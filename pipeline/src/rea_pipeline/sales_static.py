"""Static sale-by-sale files for the sales map and sale sheets (docs/features/022-full-frontend/spec.md, rule 1).

data/serve/sales/<2 first chars>/<code>.json: one file per commune, Paris / Lyon / Marseille per arrondissement (751xx, 6938x,
132xx), read by the app (apps/app/src/data/sales-static.ts) instead of the local API. Same rows as
data/local/sales.parquet (built by `rea sales`), market-excluded sales included and flagged (the building panel
lists them, the figures skip them). Lot numbers are not published (decision 022): only a per-parcel rank of the
first lot, enough to find the resale of the same flat.

Columnar and gzip-friendly (format version 1):
    {"v": 1, "code", "name", "city", "city_name", "dep", "latest": "YYYY-MM-DD",
     "parcels": {"id": [...], "lon": [...], "lat": [...], "loc": [3 parcel | 2 section | 1 commune | 0 none]},
     "streets": {"key": ["<parcel commune>|<street code>"], "name": [street | null]},
     "postcodes": [...],
     "sales": {"id", "d", "p", "s", "c", "r", "t", "l", "nb", "pa", "st", "no", "pc", "nl", "nd", "lk", "x"}}
- parcels.id: the 9 characters after the place code when the parcel starts with it, else the full 14.
- sales sorted by date then full DVF id; d = days since 1970-01-01, delta-coded (first value absolute).
- id: last 12 hex characters of the DVF id (unique within a file, checked); the app URL is <code>-<id>.
- p price €, s surface m², c Carrez m², r rooms, t 0 flat / 1 house, l land m² (null when 0), nb new build 0/1,
  pa parcel index (-1 none), st street index (-1 no street code), no number label ("108 bis"), pc postcode index,
  nl lots, nd dependencies, lk first-lot rank within the parcel (0 none), x market-excluded 0/1.
"""
import gzip
import json
import shutil
from datetime import date
from pathlib import Path

import duckdb

SPLIT_CITIES = {"751": "75056", "6938": "69123", "132": "13055"}
SHORT_ID = 12
PRECISION = {"parcel": 3, "section": 2, "commune": 1}
EPOCH = date(1970, 1, 1)


def _num(value: float | None, digits: int = 2):
    """Rounded number, written as an int when it is one (45.0 -> 45)."""
    if value is None:
        return None
    rounded = round(float(value), digits)
    return int(rounded) if rounded == int(rounded) else rounded


def _city(code: str) -> str:
    for prefix, city in SPLIT_CITIES.items():
        if code.startswith(prefix):
            return city
    return code


def _department(code: str) -> str:
    return code[:3] if code.startswith("97") else code[:2]


QUERY = """
    SELECT coalesce(code_arrondissement, code_commune) AS place, code_commune, commune_name, arrondissement_name,
           code_departement, id_mutation, date_mutation, price, surface_m2, surface_carrez_m2, rooms, property_type,
           land_m2, is_new_build, id_parcelle, street_code, street, address_number_label, postcode, n_lots,
           n_dependencies, first_lot, longitude, latitude, location_precision, market_excluded IS NOT NULL AS excluded
    FROM (
        SELECT *, CASE WHEN address IS NULL OR street IS NULL OR address = street THEN NULL
                       ELSE left(address, length(address) - length(street) - 1) END AS address_number_label
        FROM read_parquet('{source}')
    )
    ORDER BY place, date_mutation, id_mutation
"""


def _place_doc(code: str, rows: list[dict], names: dict, latest: date) -> dict:
    parcels: dict[str, tuple] = {}
    for r in rows:
        if r["id_parcelle"] and r["id_parcelle"] not in parcels:
            parcels[r["id_parcelle"]] = (r["longitude"], r["latitude"], PRECISION.get(r["location_precision"], 0))
    parcel_ids = sorted(parcels)
    parcel_index = {p: i for i, p in enumerate(parcel_ids)}
    streets: dict[tuple, int] = {}
    postcodes: dict[str, int] = {}
    lot_ranks: dict[str, dict[str, int]] = {}
    sales = {k: [] for k in ("id", "d", "p", "s", "c", "r", "t", "l", "nb", "pa", "st", "no", "pc", "nl", "nd",
                             "lk", "x")}
    previous_day = 0
    for r in rows:
        parcel = r["id_parcelle"]
        street = -1
        if r["street_code"]:
            key = ((parcel or "")[:5] + "|" + r["street_code"], r["street"])
            street = streets.setdefault(key, len(streets))
        postcode = postcodes.setdefault(r["postcode"], len(postcodes)) if r["postcode"] else -1
        lot = 0
        if parcel and r["first_lot"]:
            ranks = lot_ranks.setdefault(parcel, {})
            lot = ranks.setdefault(r["first_lot"], len(ranks) + 1)
        day = (r["date_mutation"] - EPOCH).days
        sales["id"].append(r["id_mutation"][-SHORT_ID:])
        sales["d"].append(day - previous_day)
        previous_day = day
        sales["p"].append(_num(r["price"]))
        sales["s"].append(_num(r["surface_m2"]))
        sales["c"].append(_num(r["surface_carrez_m2"]))
        sales["r"].append(r["rooms"])
        sales["t"].append(1 if r["property_type"] == "house" else 0)
        sales["l"].append(_num(r["land_m2"]) or None)
        sales["nb"].append(1 if r["is_new_build"] else 0)
        sales["pa"].append(parcel_index[parcel] if parcel else -1)
        sales["st"].append(street)
        sales["no"].append(r["address_number_label"])
        sales["pc"].append(postcode)
        sales["nl"].append(r["n_lots"] or 0)
        sales["nd"].append(r["n_dependencies"] or 0)
        sales["lk"].append(lot)
        sales["x"].append(1 if r["excluded"] else 0)
    if len(set(sales["id"])) != len(sales["id"]):
        raise ValueError(f"{code}: two sales share the last {SHORT_ID} characters of their id")
    return {
        "v": 1, "code": code, "name": names["name"], "city": _city(code), "city_name": names["city_name"],
        "dep": names["dep"], "latest": latest.isoformat(),
        "parcels": {
            "id": [p[5:] if p.startswith(code) else p for p in parcel_ids],
            "lon": [_num(parcels[p][0], 6) for p in parcel_ids],
            "lat": [_num(parcels[p][1], 6) for p in parcel_ids],
            "loc": [parcels[p][2] for p in parcel_ids],
        },
        "streets": {"key": [k for k, _ in streets], "name": [n for _, n in streets]},
        "postcodes": list(postcodes),
        "sales": sales,
    }


def export(source: Path, dest: Path) -> dict:
    """Write dest/<code>.json for every place of source (data/local/sales.parquet). Returns files, bytes and the
    biggest file (raw and gzipped bytes)."""
    con = duckdb.connect()
    latest = con.execute(f"SELECT max(date_mutation) FROM read_parquet('{source.as_posix()}')").fetchone()[0]
    cursor = con.execute(QUERY.format(source=source.as_posix()))
    names = [d[0] for d in cursor.description]
    staging = dest.with_name(dest.name + ".next")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    stats = {"files": 0, "bytes": 0, "biggest": None, "biggest_bytes": 0}
    current: str | None = None
    rows: list[dict] = []
    place_names: dict = {}

    def flush() -> None:
        if current is None:
            return
        text = json.dumps(_place_doc(current, rows, place_names, latest), ensure_ascii=False, separators=(",", ":"))
        data = text.encode("utf-8")
        target = staging / current[:2] / f"{current}.json"  # ≤ ~1,000 files per folder (Hugging Face: < 10k)
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(data)
        stats["files"] += 1
        stats["bytes"] += len(data)
        if len(data) > stats["biggest_bytes"]:
            stats.update(biggest=current, biggest_bytes=len(data))

    while batch := cursor.fetchmany(50000):
        for values in batch:
            r = dict(zip(names, values))
            if r["place"] != current:
                flush()
                current, rows = r["place"], []
                split = r["place"] != r["code_commune"]
                place_names = {"name": r["arrondissement_name"] if split else r["commune_name"],
                               "city_name": r["commune_name"], "dep": r["code_departement"] or _department(current)}
            rows.append(r)
    flush()
    con.close()
    shutil.rmtree(dest, ignore_errors=True)
    staging.replace(dest)
    if stats["biggest"]:
        stats["biggest_gzip_bytes"] = len(gzip.compress((dest / stats['biggest'][:2] / f"{stats['biggest']}.json").read_bytes(), 6))
    return stats


def gzip_size(path: Path) -> int:
    return len(gzip.compress(path.read_bytes(), 6))
