"""Sale-by-sale queries of the local API (docs/features/019-sales-map/spec.md, "Local API contract").

    GET /sales?commune=33063&type=&months=&rooms=&surface_min=&surface_max=&price_min=&price_max=
    GET /building/<parcel>?<same filters>
    GET /sale/<id_mutation>?<same filters>

Reads data/local/sales.parquet (pipeline `uv run rea sales`), sorted by commune, so a commune filter only reads
its own row groups. Individual DVF sales: local use only, never published or indexed (DVF rules, decision 016).
The price model never reads this file; it only estimates a sale from the sale's own fields.
"""
import dataclasses
import json
import math
import re
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from statistics import median

import duckdb

TYPES = ("apartment", "house", "all")
MONTHS = (12, 24, 60)
MIN_FIGURE_SALES = 3  # under 3 sales a median is not shown (the sales are)
SIMILAR_SURFACE_RATIO = 0.2
SIMILAR_ROOMS = 1
SIMILAR_MONTHS = 6
COMPARABLES = 10
MIN_YEARS_FOR_RATE = 1.0  # an annual rate over a few months says nothing
# arrondissements of the three split cities -> city code
SPLIT_CITIES = {"751": "75056", "6938": "69123", "132": "13055"}
COMMUNE_CODE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
PARCEL_ID = re.compile(r"^[0-9A-Z]{14}$")
SALE_ID = re.compile(r"^[0-9a-f]{32}$")
CACHED_PLACES = 16  # communes or arrondissements kept in memory (Paris whole: ~150 k sales)
SALE_KEY = "CAST(('0x' || left(id_mutation, 16)) AS UBIGINT)"
PRECISION_RANK = "CASE location_precision WHEN 'parcel' THEN 3 WHEN 'section' THEN 2 ELSE 1 END"


class BadRequest(ValueError):
    """400: a filter or a parameter is not valid."""


class NotFound(LookupError):
    """404 with a French message for the app."""


def period_start(latest: date, months: int) -> date:
    """First day of the `months` months that end on `latest` (2026-06-30, 24 -> 2024-07-01)."""
    return _add_months(latest + timedelta(days=1), -months)


def _number(query: dict[str, list[str]], name: str) -> float | None:
    values = query.get(name)
    if not values or values[-1] == "":
        return None
    try:
        value = float(values[-1])
    except ValueError:
        raise BadRequest(f"{name} doit être un nombre") from None
    if not math.isfinite(value) or value < 0:
        raise BadRequest(f"{name} doit être un nombre positif")
    return value


@dataclass(frozen=True)
class Filters:
    type: str = "apartment"
    months: int = 24
    rooms: int | None = None  # 5 = 5 rooms or more
    surface_min: float | None = None
    surface_max: float | None = None
    price_min: float | None = None
    price_max: float | None = None

    @classmethod
    def parse(cls, query: dict[str, list[str]]) -> "Filters":
        ptype = (query.get("type") or ["apartment"])[-1] or "apartment"
        if ptype not in TYPES:
            raise BadRequest("type : apartment, house ou all")
        months_text = (query.get("months") or ["24"])[-1] or "24"
        if not months_text.isdigit() or int(months_text) not in MONTHS:
            raise BadRequest("months : 12, 24 ou 60")
        rooms_text = (query.get("rooms") or [""])[-1]
        if rooms_text and (not rooms_text.isdigit() or not 1 <= int(rooms_text) <= 5):
            raise BadRequest("rooms : 1 à 5 (5 = 5 et plus)")
        return cls(ptype, int(months_text), int(rooms_text) if rooms_text else None,
                   _number(query, "surface_min"), _number(query, "surface_max"),
                   _number(query, "price_min"), _number(query, "price_max"))

    def sql(self, latest: date, with_type: bool = True) -> tuple[str, list]:
        """Boolean SQL expression of the filters (market sales of the period only) and its parameters."""
        clauses = ["date_mutation BETWEEN ? AND ?", "market_excluded IS NULL"]
        params: list = [period_start(latest, self.months), latest]
        if with_type and self.type != "all":
            clauses.append("property_type = ?")
            params.append(self.type)
        if self.rooms is not None:
            clauses.append("rooms >= 5" if self.rooms == 5 else "rooms = ?")
            params += [] if self.rooms == 5 else [self.rooms]
        for column, bound, op in (("surface_m2", self.surface_min, ">="), ("surface_m2", self.surface_max, "<="),
                                  ("price", self.price_min, ">="), ("price", self.price_max, "<=")):
            if bound is not None:
                clauses.append(f"{column} {op} ?")
                params.append(bound)
        return "(" + " AND ".join(clauses) + ")", params


def commune_clause(code: str) -> tuple[str, list]:
    """WHERE clause of a commune or arrondissement code (75056 = all of Paris, 75115 = its 15th)."""
    if not COMMUNE_CODE.match(code or ""):
        raise BadRequest("commune : code INSEE à 5 caractères")
    for prefix, city in SPLIT_CITIES.items():
        if code.startswith(prefix):
            # the city code first: the file is sorted by commune, then arrondissement
            return "code_commune = ? AND code_arrondissement = ?", [city, code]
    return "code_commune = ?", [code]


def _int(value) -> int | None:
    return None if value is None else int(round(value))


def _ratio(value) -> float | None:
    return None if value is None else round(float(value), 4)


def _median_or_none(values: list[float]) -> float | None:
    return median(values) if len(values) >= MIN_FIGURE_SALES else None


def _km(lon1, lat1, lon2, lat2) -> float | None:
    if None in (lon1, lat1, lon2, lat2):
        return None
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(min(1.0, math.sqrt(h)))


SALE_COLUMNS = ("id_mutation, date_mutation, address, street, street_code, property_type, rooms, surface_m2, "
                "surface_carrez_m2, land_m2, price, price_m2, lots, n_dependencies, n_lots, is_new_build, "
                "first_lot, id_parcelle, section, postcode, longitude, latitude, location_precision, code_commune, "
                "code_arrondissement, code_departement, commune_name, arrondissement_name, market_excluded")


class SalesStore:
    """Queries of the local API. The first request on a commune (or arrondissement) copies its sales from the
    parquet file into memory; every later request on it (map, building clicks, sale sheets) reads memory only."""

    def __init__(self, sales_path: Path, levels_dir: Path, model=None, cached_places: int = CACHED_PLACES):
        """`model`: the loaded PriceCheckModel for the sheet's estimate, or None (then `model` is null)."""
        self.levels_dir = levels_dir
        self.model_slices = ModelSlices(model) if model is not None else None
        self.cached_places = cached_places
        self.source = f"read_parquet('{sales_path.as_posix()}')"
        self.con = duckdb.connect()
        self.con.execute("SET parquet_metadata_cache = true")
        self.latest: date = self.con.execute(f"SELECT max(date_mutation) FROM {self.source}").fetchone()[0]
        # small keys: sale id (first 64 bits of the md5) -> place; parcel commune prefix -> place
        # (place = arrondissement in Paris, Lyon and Marseille, else commune)
        self.con.execute(f"""CREATE TABLE sale_key AS
                             SELECT {SALE_KEY} AS k, coalesce(code_arrondissement, code_commune) AS place
                             FROM {self.source}""")
        self.con.execute(f"""CREATE TABLE parcel_place AS
                             SELECT DISTINCT left(id_parcelle, 5) AS prefix,
                                    coalesce(code_arrondissement, code_commune) AS place
                             FROM {self.source} WHERE id_parcelle IS NOT NULL""")
        self._tables: OrderedDict[str, str] = OrderedDict()
        self._lock = threading.Lock()
        self._levels: dict[str, dict | None] = {}

    def _rows(self, sql: str, params: list) -> list[dict]:
        cursor = self.con.cursor()  # one connection per request thread
        try:
            result = cursor.execute(sql, params)
            names = [d[0] for d in result.description]
            return [dict(zip(names, row)) for row in result.fetchall()]
        finally:
            cursor.close()

    def _table(self, code: str) -> str:
        """In-memory table of a place's sales (all years, types and flags), loaded on first use."""
        where, params = commune_clause(code)
        with self._lock:
            if code in self._tables:
                self._tables.move_to_end(code)
                return self._tables[code]
            table = f"place_{code}"
            cursor = self.con.cursor()
            try:
                cursor.execute(f"CREATE OR REPLACE TABLE {table} AS SELECT {SALE_COLUMNS} FROM {self.source} "
                               f"WHERE {where}", params)
                if cursor.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == 0:
                    cursor.execute(f"DROP TABLE {table}")
                    raise NotFound("commune introuvable")
                self._tables[code] = table
                while len(self._tables) > self.cached_places:
                    _, oldest = self._tables.popitem(last=False)
                    cursor.execute(f"DROP TABLE IF EXISTS {oldest}")
            finally:
                cursor.close()
            return table

    # ---- shared pieces

    def _place(self, code: str) -> dict:
        found = self._rows(f"SELECT commune_name, arrondissement_name FROM {self._table(code)} LIMIT 1", [])
        is_arrondissement = len(commune_clause(code)[1]) == 2
        return {"code": code, "name": found[0]["arrondissement_name" if is_arrondissement else "commune_name"]}

    def _sale_place(self, row: dict) -> dict:
        if row["code_arrondissement"]:
            return {"code": row["code_arrondissement"], "name": row["arrondissement_name"]}
        return {"code": row["code_commune"], "name": row["commune_name"]}

    def _type_medians(self, code: str, filters: Filters) -> dict[str, tuple[int, float | None]]:
        """Filtered commune sales per type ('all' too, whatever the type filter): (n, median €/m²)."""
        flt, flt_params = filters.sql(self.latest, with_type=False)
        rows = self._rows(
            f"""SELECT coalesce(property_type, 'all') AS t, count(*) AS n, median(price_m2) AS m
                FROM {self._table(code)} WHERE {flt}
                GROUP BY GROUPING SETS ((property_type), ())""", flt_params)
        out = {r["t"]: (r["n"], r["m"] if r["n"] >= MIN_FIGURE_SALES else None) for r in rows}
        return out | {t: (0, None) for t in TYPES if t not in out}

    def _matches(self, code: str, condition: str, params: list, filters: Filters) -> list[dict]:
        """Rows of a place meeting `condition`, each flagged against the filters, newest first."""
        flt, flt_params = filters.sql(self.latest)
        return self._rows(
            f"SELECT *, coalesce({flt}, false) AS matches_filters FROM {self._table(code)} WHERE {condition} "
            "ORDER BY date_mutation DESC, id_mutation", flt_params + params)

    def _places_of(self, key_sql: str, params: list) -> list[str]:
        return [r["place"] for r in self._rows(key_sql, params)]

    def _parcel_rows(self, parcel: str, filters: Filters) -> list[dict]:
        places = self._places_of("SELECT place FROM parcel_place WHERE prefix = ?", [parcel[:5]])
        rows = [r for place in places for r in self._matches(place, "id_parcelle = ?", [parcel], filters)]
        return sorted(rows, key=lambda r: (r["date_mutation"], r["id_mutation"]), reverse=True)

    @staticmethod
    def _sale(row: dict, commune_medians: dict) -> dict:
        reference = commune_medians.get(row["property_type"], (0, None))[1]
        return {
            "id": row["id_mutation"], "date": row["date_mutation"].isoformat(), "address": row["address"],
            "type": row["property_type"], "rooms": row["rooms"], "surface": row["surface_m2"],
            "carrez": row["surface_carrez_m2"], "land": row["land_m2"] or None, "price": _int(row["price"]),
            "price_m2": _int(row["price_m2"]),
            "lots": [{"number": lot["number"], "carrez": lot["carrez"]} for lot in row["lots"] or []],
            "n_dependencies": row["n_dependencies"], "new": bool(row["is_new_build"]),
            "gap_commune": _ratio(row["price_m2"] / reference - 1) if reference else None,
            "matches_filters": bool(row["matches_filters"]),
        }

    # ---- GET /sales

    def sales_map(self, code: str, filters: Filters) -> dict:
        place = self._place(code)
        table = self._table(code)
        flt, flt_params = filters.sql(self.latest)
        reference = self._rows(f"SELECT count(*) AS n, median(price_m2) AS m FROM {table} WHERE {flt}",
                               flt_params)[0]
        # the array is written as JSON by DuckDB: Paris has ~25 000 buildings, Python objects would triple the time
        [buildings] = self._rows(
            f"""SELECT CAST(coalesce(to_json(list(json_object(
                           'id', id, 'lon', round(lon, 6), 'lat', round(lat, 6), 'addresses', addresses, 'n', n,
                           'median_m2', CASE WHEN n >= {MIN_FIGURE_SALES} THEN CAST(round(median_m2) AS BIGINT) END,
                           -- colour of the dot from 1 sale: the sales are listed anyway, only the "médiane" waits for 3
                           'm2', CAST(round(median_m2) AS BIGINT),
                           'last_date', strftime(last_date, '%Y-%m-%d')) ORDER BY id)), '[]') AS VARCHAR)
                       AS buildings
                FROM (SELECT id_parcelle AS id,
                             arg_max(longitude, {PRECISION_RANK}) AS lon, arg_max(latitude, {PRECISION_RANK}) AS lat,
                             coalesce(list_sort(list(DISTINCT address) FILTER (WHERE address IS NOT NULL)), [])
                                 AS addresses,
                             count(*) AS n, median(price_m2) AS median_m2, max(date_mutation) AS last_date
                      FROM {table} WHERE {flt} AND id_parcelle IS NOT NULL AND longitude IS NOT NULL
                      GROUP BY id_parcelle)""", flt_params)
        return {
            "commune": place,
            "period": {"from": period_start(self.latest, filters.months).isoformat(), "to": self.latest.isoformat()},
            "reference": {"n": reference["n"],
                          "median_m2": _int(reference["m"]) if reference["n"] >= MIN_FIGURE_SALES else None},
            "buildings": RawJson(buildings["buildings"]),
        }

    # ---- GET /building/<parcel>

    def building(self, parcel: str, filters: Filters) -> dict:
        if not PARCEL_ID.match(parcel or ""):
            raise NotFound("immeuble introuvable")
        rows = self._parcel_rows(parcel, filters)
        if not rows:
            raise NotFound("immeuble introuvable")
        place = self._sale_place(rows[0])
        medians = self._type_medians(place["code"], filters)
        reference_type = filters.type
        matching = [r["price_m2"] for r in rows if r["matches_filters"]]
        point = max(rows, key=lambda r: {"parcel": 3, "section": 2}.get(r["location_precision"], 1))
        return {
            "id": parcel, "lon": _round6(point["longitude"]), "lat": _round6(point["latitude"]),
            "addresses": sorted({r["address"] for r in rows if r["address"]}),
            "commune": place | {"median_m2": _int(medians[reference_type][1])},
            "street": self._street(rows, place["code"], filters),
            "stats": self._stats(matching),
            "sales": [self._sale(r, medians) for r in rows],
        }

    @staticmethod
    def _stats(values: list[float]) -> dict:
        if len(values) < MIN_FIGURE_SALES:
            return {"n": len(values), "median_m2": None, "p25_m2": None, "p75_m2": None}
        ordered = sorted(values)

        def quantile(q: float) -> float:  # linear interpolation, like DuckDB quantile_cont
            position = q * (len(ordered) - 1)
            low = math.floor(position)
            high = min(low + 1, len(ordered) - 1)
            return ordered[low] + (ordered[high] - ordered[low]) * (position - low)

        return {"n": len(values), "median_m2": _int(median(ordered)), "p25_m2": _int(quantile(0.25)),
                "p75_m2": _int(quantile(0.75))}

    def _street(self, rows: list[dict], code: str, filters: Filters) -> dict | None:
        """The building's main street (most sales), with the filtered sales of that street in the commune."""
        streets: dict[tuple, int] = {}
        for r in rows:
            if r["street_code"] and r["street"]:
                key = (r["id_parcelle"][:5], r["street_code"], r["street"])
                streets[key] = streets.get(key, 0) + 1
        if not streets:
            return None
        (parcel_commune, street_code, name), _ = max(streets.items(), key=lambda item: item[1])
        flt, flt_params = filters.sql(self.latest)
        found = self._rows(
            f"""SELECT count(*) AS n, median(price_m2) AS m FROM {self._table(code)}
                WHERE left(id_parcelle, 5) = ? AND street_code = ? AND {flt}""",
            [parcel_commune, street_code] + flt_params)[0]
        return {"name": name, "n": found["n"],
                "median_m2": _int(found["m"]) if found["n"] >= MIN_FIGURE_SALES else None}

    # ---- GET /sale/<id>

    def sale(self, sale_id: str, filters: Filters) -> dict:
        if not SALE_ID.match(sale_id or ""):
            raise NotFound("vente introuvable")
        places = self._places_of(f"SELECT place FROM sale_key WHERE k = {SALE_KEY.replace('id_mutation', '?')}",
                                 [sale_id])
        found = [r for place in places for r in self._matches(place, "id_mutation = ?", [sale_id], filters)]
        if not found:
            raise NotFound("vente introuvable")
        row = found[0]
        building = self._parcel_rows(row["id_parcelle"], filters) if row["id_parcelle"] else [row]
        place = self._sale_place(row)
        medians = self._type_medians(place["code"], filters)
        model = _MODEL_RUNNER.submit(self._model, row)  # the slowest part: in parallel with the queries
        similar = self._similar(row, place["code"])
        return {
            "sale": self._sale(row, medians) | {
                "postcode": row["postcode"], "section": row["section"], "parcel": row["id_parcelle"],
                "lon": _round6(row["longitude"]), "lat": _round6(row["latitude"]),
                "location_precision": row["location_precision"], "commune": place,
                "departement": row["code_departement"],
            },
            "similar_rule": {"surface_ratio": SIMILAR_SURFACE_RATIO, "rooms": SIMILAR_ROOMS, "months": SIMILAR_MONTHS},
            "position": self._position(row, similar),
            "comparables": self._comparables(row, similar),
            "value_today": self._value_today(row, place["code"]),
            "model": model.result(),
            "resale": self._resale(row, building),
            "building_sales": [
                {"id": r["id_mutation"], "date": r["date_mutation"].isoformat(), "type": r["property_type"],
                 "rooms": r["rooms"], "surface": r["surface_m2"], "price_m2": _int(r["price_m2"])}
                for r in building if r["id_mutation"] != sale_id
            ],
        }

    def _similar(self, row: dict, code: str) -> list[dict]:
        """Same type, surface ±20 %, rooms ±1, date ±6 months, market sales of the commune, the sale excluded."""
        surface, rooms, day = row["surface_m2"], row["rooms"], row["date_mutation"]
        params: list = []
        clauses = ["market_excluded IS NULL", "property_type = ?", "surface_m2 BETWEEN ? AND ?",
                   "date_mutation BETWEEN ? AND ?", "id_mutation <> ?"]
        params += [row["property_type"], surface * (1 - SIMILAR_SURFACE_RATIO), surface * (1 + SIMILAR_SURFACE_RATIO),
                   _add_months(day, -SIMILAR_MONTHS), _add_months(day, SIMILAR_MONTHS), row["id_mutation"]]
        if rooms:
            clauses.append("rooms BETWEEN ? AND ?")
            params += [rooms - SIMILAR_ROOMS, rooms + SIMILAR_ROOMS]
        return self._rows(
            f"""SELECT id_mutation, date_mutation, address, longitude, latitude, rooms, surface_m2, price, price_m2,
                       id_parcelle, section, street_code FROM {self._table(code)}
                WHERE {' AND '.join(clauses)}""", params)

    @staticmethod
    def _position(row: dict, similar: list[dict]) -> list[dict]:
        street_key = (row["id_parcelle"] or "")[:5], row["street_code"]
        levels = {
            "building": lambda s: row["id_parcelle"] is not None and s["id_parcelle"] == row["id_parcelle"],
            "street": lambda s: row["street_code"] is not None
                                and ((s["id_parcelle"] or "")[:5], s["street_code"]) == street_key,
            "section": lambda s: row["section"] is not None and s["section"] == row["section"],
            "commune": lambda s: True,
        }
        out = []
        for level, keep in levels.items():
            values = [s["price_m2"] for s in similar if keep(s)]
            reference = _median_or_none(values)
            out.append({
                "level": level, "n": len(values), "median_m2": _int(reference),
                "gap": _ratio(row["price_m2"] / reference - 1) if reference else None,
                "percentile": _ratio(sum(v < row["price_m2"] for v in values) / len(values)) if reference else None,
            })
        return out

    @staticmethod
    def _comparables(row: dict, similar: list[dict]) -> list[dict]:
        def distance(s):
            return _km(row["longitude"], row["latitude"], s["longitude"], s["latitude"])

        ranked = sorted(similar, key=lambda s: (distance(s) if distance(s) is not None else math.inf,
                                                abs((s["date_mutation"] - row["date_mutation"]).days), s["id_mutation"]))
        return [
            {"id": s["id_mutation"], "date": s["date_mutation"].isoformat(), "address": s["address"],
             "lon": _round6(s["longitude"]), "lat": _round6(s["latitude"]), "rooms": s["rooms"],
             "surface": s["surface_m2"], "price": _int(s["price"]), "price_m2": _int(s["price_m2"]),
             "km": None if distance(s) is None else round(distance(s), 3)}
            for s in ranked[:COMPARABLES]
        ]

    def _levels_file(self, departement: str) -> dict | None:
        if departement not in self._levels:
            path = self.levels_dir / f"{departement}.json"
            self._levels[departement] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        return self._levels[departement]

    def _value_today(self, row: dict, code: str) -> dict | None:
        """Price × (latest yearly median / median of the sale's year), commune series else département."""
        doc = self._levels_file(row["code_departement"])
        if not doc or row["property_type"] not in doc.get("types", {}):
            return None
        years = doc["years"]
        if not years:
            return None
        sale_year = row["date_mutation"].year
        from_index = min(range(len(years)), key=lambda i: (abs(int(years[i]) - sale_year), -i))
        block = doc["types"][row["property_type"]]
        commune = next((c for c in block.get("communes", []) if c["code"] == code), None)
        for level, medians in (("commune", commune and commune.get("medians")),
                               ("departement", block.get("curves", {}).get("departement"))):
            if not medians or medians[from_index] is None:
                continue
            to_index = max(i for i, m in enumerate(medians) if m is not None)
            if to_index < from_index:
                continue
            factor = medians[to_index] / medians[from_index]
            value = round(row["price"] * factor)
            return {"level": level, "from_year": years[from_index], "to_year": years[to_index],
                    "factor": round(factor, 4), "value": value, "gain": value - _int(row["price"])}
        return None

    def _model(self, row: dict) -> dict | None:
        """Price model estimate of the property as of today (the model's latest period), from the sale's fields."""
        if self.model_slices is None or not row["surface_m2"]:
            return None
        prop = {"property_type": row["property_type"], "surface_m2": row["surface_m2"], "rooms": row["rooms"],
                "land_m2": row["land_m2"] or 0.0, "n_dependencies": row["n_dependencies"] or 0,
                "n_lots": row["n_lots"] or 1, "is_new_build": bool(row["is_new_build"]),
                "code_commune": row["code_commune"], "section": row["section"]}
        try:
            model = self.model_slices.for_location(row["section"], row["code_commune"])
            [result] = model.estimate([prop], explain=False)
        except Exception:  # noqa: BLE001 — the sheet works without the model (e.g. a commune it never saw)
            return None
        surface = row["surface_m2"]
        estimate = result["price_m2"]
        return {"estimate_m2": _int(estimate), "low_m2": _int(result["price_low"] / surface),
                "high_m2": _int(result["price_high"] / surface), "gap": _ratio(row["price_m2"] / estimate - 1),
                "as_of": "today"}

    @staticmethod
    def _resale(row: dict, building: list[dict]) -> dict | None:
        """Same parcel and same first lot (flats) or same parcel (houses), sold before or after."""
        if row["property_type"] == "apartment" and not row["first_lot"]:
            return None

        def same_property(other: dict) -> bool:
            if other["id_mutation"] == row["id_mutation"] or other["property_type"] != row["property_type"]:
                return False
            return row["property_type"] == "house" or other["first_lot"] == row["first_lot"]

        others = [o for o in building if same_property(o)]
        day = row["date_mutation"]
        before = max((o for o in others if o["date_mutation"] < day), key=lambda o: o["date_mutation"], default=None)
        after = min((o for o in others if o["date_mutation"] > day), key=lambda o: o["date_mutation"], default=None)
        if before is None and after is None:
            return None
        first, last = (before, row) if before is not None else (row, after)
        years = (last["date_mutation"] - first["date_mutation"]).days / 365.25
        rate = (last["price"] / first["price"]) ** (1 / years) - 1 if years >= MIN_YEARS_FOR_RATE else None

        def brief(o):
            return None if o is None else {"id": o["id_mutation"], "date": o["date_mutation"].isoformat(),
                                           "price": _int(o["price"])}

        return {"previous": brief(before), "next": brief(after), "holding_years": round(years, 1),
                "gain": _int(last["price"] - first["price"]), "annual_rate": _ratio(rate)}


class ModelSlices:
    """The price model with its lookup tables cut to one section and commune, so one estimate does not merge
    the whole of France (≈ 0.4 s per call otherwise). Same model, same numbers."""

    def __init__(self, model):
        self.model = model
        self._sections = _indexed(model.section_points, "section")
        self._communes = _indexed(model.commune_points, "code")
        self._socio = _indexed(model.socio, "code_commune")
        self._tables = {level: _indexed(table, level) for level, table in model.encoder.tables.items()}
        if len(model.section_points):  # the first estimate of a process is slow: pay it at start-up
            section = str(model.section_points["section"].iloc[0])
            try:
                self.for_location(section, section[:5]).estimate(
                    [{"property_type": "apartment", "surface_m2": 50.0, "rooms": 2, "code_commune": section[:5],
                      "section": section}], explain=False)
            except Exception:  # noqa: BLE001 — a warm-up only
                pass

    def for_location(self, section: str | None, code_commune: str):
        keys = {"section": section, "code_commune": code_commune}
        tables = {level: _pick(indexed, keys[level]) if level in keys else self.model.encoder.tables[level]
                  for level, indexed in self._tables.items()}
        return dataclasses.replace(
            self.model, section_points=_pick(self._sections, section), commune_points=_pick(self._communes, code_commune),
            socio=_pick(self._socio, code_commune), encoder=dataclasses.replace(self.model.encoder, tables=tables))


def _indexed(frame, column: str):
    return frame.set_index(column, drop=False).rename_axis(None).sort_index()


def _pick(indexed, key):
    if key is None or key not in indexed.index:
        return indexed.iloc[0:0].reset_index(drop=True)
    return indexed.loc[[key]].reset_index(drop=True)


class RawJson(str):
    """A value already encoded as JSON, inserted as is by `dumps`."""


def dumps(body: dict) -> str:
    """json.dumps that inserts RawJson values without decoding them."""
    raws: dict[str, str] = {}

    def default(value):
        if isinstance(value, date):
            return value.isoformat()
        return str(value)

    def mark(value):
        if isinstance(value, RawJson):
            token = f"\u0000raw{len(raws)}\u0000"
            raws[json.dumps(token)] = str(value)
            return token
        if isinstance(value, dict):
            return {k: mark(v) for k, v in value.items()}
        if isinstance(value, list):
            return [mark(v) for v in value]
        return value

    text = json.dumps(mark(body), ensure_ascii=False, default=default)
    for token, raw in raws.items():
        text = text.replace(token, raw, 1)
    return text


_MODEL_RUNNER = ThreadPoolExecutor(max_workers=2, thread_name_prefix="sale-model")


def _round6(value: float | None) -> float | None:
    return None if value is None else round(value, 6)


def _add_months(day: date, months: int) -> date:
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    last = (date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day.day, last))
