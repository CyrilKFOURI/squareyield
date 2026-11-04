"""S5: publish the serve layer read by the app (schema v2, docs/features/013-comparable-segments/spec.md).

data/serve/
  index.json                 searchable places: [code, level, name, departement, population]
  geo/<level>/<code>.json    everything about one place: prices and yields per comparable cell
                             (type × size × new/existing × period), socio, housing stock, local tax,
                             energy (DPE) by type, rent control, market score, price bands per year,
                             OLL rents in place, the latest period and the typical deal of every cell,
                             neighbouring places, a pointer to its OLL agglomeration
  meta.json                  source of each block (same for every place)
  oll/<agglomeration>.json   OLL rents in place of one agglomeration (yearly series + latest detail)
  ranking.json               catalogue of ranking files and their period
  ranking/<type>_<size>.json communes/arrondissements of one segment (n >= 30, yield not excluded)
  map/                       see mapdata.py
Files are written to a staging folder and swapped in at the end, so the app never reads a
half-written serve layer. Nothing in the app recomputes these figures (014 rule).
"""
import json
import shutil
from decimal import Decimal
from pathlib import Path

import duckdb

from . import deals, mapdata, oll, paths
from .marts import RELIABLE_SALES

SCHEMA_VERSION = 2
SEARCHABLE_LEVELS = ("commune", "arrondissement")
TYPES = ("apartment", "house")
SIZES = {"apartment": ("all", "1", "2", "3", "4", "5+"), "house": ("all", "1-3", "4", "5", "6+")}
PRICE_FIELDS = ("period_type", "period", "is_partial", "condition", "property_type", "rooms_bucket", "n_sales",
                "reliability", "median_price_m2", "p25_price_m2", "p75_price_m2", "median_price", "yoy_change",
                "median_surface_m2", "median_land_m2", "share_with_outbuilding", "cagr", "cagr_since",
                "new_premium")
YIELD_FIELDS = ("period", "property_type", "rooms_bucket", "n_sales", "reliability", "rent_m2", "rent_low_m2", "rent_high_m2",
                "rent_surface_m2", "rent_method", "rent_level", "rent_caution", "rent_coverage", "n_listings",
                "gross_yield", "price_to_rent_years", "status", "reason")
SOCIO_FIELDS = ("census_year", "population", "population_growth_yearly", "dwellings",
                "vacancy_rate", "vacancy_change_pts", "second_home_share", "renter_share",
                "median_living_standard", "poverty_rate", "jobs", "jobs_growth_yearly",
                "flag_high_vacancy", "flag_population_decline")
DPE_FIELDS = ("n_dpe", "share_a", "share_b", "share_c", "share_d", "share_e", "share_f", "share_g", "share_fg")
OLL_FIELDS = ("year", "property_type", "rooms", "period_built", "tenancy", "rent_m2_median", "rent_m2_d1",
              "rent_m2_d9", "rent_monthly_median", "surface_mean", "n_obs")
NEIGHBOURS, NEIGHBOUR_RADIUS_KM = 8, 30


def size_slug(rooms_bucket: str) -> str:
    """File-name form of a size bucket ('5+' -> '5p'): '+' is ambiguous in URLs."""
    return rooms_bucket.replace("+", "p")


def _round(value):
    if isinstance(value, (float, Decimal)):
        return round(float(value), 5)
    return value


def _rows(con: duckdb.DuckDBPyConnection, query: str) -> dict:
    """Group query rows by (geo_level, geo_code) as compact column-ordered lists."""
    grouped: dict[tuple[str, str], list] = {}
    for level, code, *values in con.execute(query).fetchall():
        grouped.setdefault((level, code), []).append([_round(v) for v in values])
    return grouped


def _has_table(con: duckdb.DuckDBPyConnection, table: str) -> bool:
    return con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [table]
    ).fetchone()[0] > 0


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> list[str]:
    return [row[0] for row in con.execute(f"DESCRIBE {table}").fetchall()]


def _select(con: duckdb.DuckDBPyConnection, table: str, fields: tuple[str, ...]) -> str:
    """Select list for `fields`, NULL for columns an older table does not have yet."""
    existing = set(_columns(con, table))
    return ", ".join(f if f in existing else f"NULL AS {f}" for f in fields)


def _latest_complete_year(con: duckdb.DuckDBPyConnection) -> str | None:
    return con.execute(
        "SELECT max(period) FROM kpi_price WHERE period_type = 'year' AND NOT is_partial"
    ).fetchone()[0]


def _tax_rates(con: duckdb.DuckDBPyConnection) -> dict[tuple[str, str], float]:
    if not _has_table(con, "kpi_local_tax"):
        return {}
    return {(l, c): r for l, c, r in con.execute("SELECT geo_level, geo_code, tfpb_rate FROM kpi_local_tax").fetchall()}


def _typical(price: float, surface: float, rent_m2: float, property_type: str, tfpb_rate: float | None) -> dict:
    # DuckDB returns DECIMAL literals as Decimal: the maths runs on floats
    deal = deals.typical_deal(float(price), float(surface), float(rent_m2), property_type,
                              None if tfpb_rate is None else float(tfpb_rate))
    return {k: (round(v, 5) if k.endswith(("yield", "rate")) else round(v, 2)) if v is not None else None
            for k, v in deal.items()}


def _latest_and_typical(con: duckdb.DuckDBPyConnection, min_sales: int) -> dict[tuple[str, str], dict]:
    """Per place: `latest` (which period to show by default for each type × size) and
    `typical_deal` (the median property of that cell with the default financing)."""
    out: dict[tuple[str, str], dict] = {}
    for level, code, ptype, bucket, year, half in con.execute(
        f"""SELECT geo_level, geo_code, property_type, rooms_bucket,
                   max(period) FILTER (WHERE period_type = 'year' AND NOT is_partial),
                   max(period) FILTER (WHERE period_type = 'half')
            FROM kpi_price WHERE condition = 'existing' AND property_type IN {TYPES} AND n_sales >= {min_sales}
            GROUP BY ALL"""
    ).fetchall():
        out.setdefault((level, code), {}).setdefault("latest", {}).setdefault(ptype, {})[bucket] = {
            "year": year, "half": half, "basis": "exact"}
    # a size with half-years only borrows the latest complete year of all sizes, labelled
    for place in out.values():
        for ptype, sizes in place["latest"].items():
            whole = sizes.get("all", {}).get("year")
            for bucket, entry in sizes.items():
                if entry["year"] is None and whole and bucket != "all":
                    entry.update(year=whole, basis="all_sizes")

    rates = _tax_rates(con)
    for level, code, ptype, bucket, period, price, surface, rent in con.execute(
        f"""SELECT p.geo_level, p.geo_code, p.property_type, p.rooms_bucket, p.period,
                   p.median_price, p.median_surface_m2, y.rent_m2
            FROM kpi_price p
            JOIN kpi_yield y USING (geo_level, geo_code, period_type, period, property_type, rooms_bucket)
            WHERE p.condition = 'existing' AND p.period_type = 'year' AND NOT p.is_partial
              AND p.n_sales >= {min_sales} AND y.status = 'ok'"""
    ).fetchall():
        latest = out.get((level, code), {}).get("latest", {}).get(ptype, {}).get(bucket)
        if not latest or latest["year"] != period or latest["basis"] != "exact":
            continue
        deal = _typical(price, surface, rent, ptype, rates.get((level, code)))
        out[(level, code)].setdefault("typical_deal", {}).setdefault(ptype, {})[bucket] = {
            **deal, "period": period, "basis": "exact"}
    return out


def _neighbours(con: duckdb.DuckDBPyConnection, min_sales: int) -> dict[tuple[str, str], list]:
    """Up to 8 nearest places of the same level (≤ 30 km) that have a published flat or house cell."""
    if not _has_table(con, "commune_point"):
        return {}
    rows = con.execute(
        f"""
        WITH places AS (
            SELECT DISTINCT p.geo_level, p.geo_code, pt.longitude AS lon, pt.latitude AS lat, m.nom
            FROM kpi_price p
            JOIN commune_point pt ON pt.code = p.geo_code
            JOIN commune_map m ON m.code = p.geo_code
            WHERE p.geo_level IN {SEARCHABLE_LEVELS} AND p.condition = 'existing'
              AND p.property_type IN {TYPES} AND p.n_sales >= {min_sales}
        ),
        pairs AS (
            SELECT a.geo_level, a.geo_code, b.geo_code AS other, b.nom,
                   2 * 6371 * asin(sqrt(pow(sin(radians(b.lat - a.lat) / 2), 2)
                       + cos(radians(a.lat)) * cos(radians(b.lat)) * pow(sin(radians(b.lon - a.lon) / 2), 2))) AS km
            FROM places a JOIN places b
              ON a.geo_level = b.geo_level AND a.geo_code <> b.geo_code
             AND abs(a.lat - b.lat) < 0.3 AND abs(a.lon - b.lon) < 0.45
        )
        SELECT geo_level, geo_code, other, nom, round(km, 1) FROM (
            SELECT *, row_number() OVER (PARTITION BY geo_level, geo_code ORDER BY km) AS rank
            FROM pairs WHERE km <= {NEIGHBOUR_RADIUS_KM})
        WHERE rank <= {NEIGHBOURS} ORDER BY geo_level, geo_code, km
        """
    ).fetchall()
    out: dict[tuple[str, str], list] = {}
    for level, code, other, name, km in rows:
        out.setdefault((level, code), []).append([other, name, km])
    return out


def _extras(con: duckdb.DuckDBPyConnection) -> tuple[dict[tuple[str, str], dict], dict[str, dict]]:
    """Optional per-place blocks from the other KPI tables (absent tables are skipped), and the
    OLL series per agglomeration (written once, places point to them)."""
    extras: dict[tuple[str, str], dict] = {}
    series: dict[str, dict] = {}

    def put(key, name, value):
        extras.setdefault(key, {})[name] = value

    if _has_table(con, "kpi_local_tax"):
        for level, code, year, rate in con.execute(
            "SELECT geo_level, geo_code, tax_year, tfpb_rate FROM kpi_local_tax"
        ).fetchall():
            put((level, code), "local_tax", {"tax_year": year, "tfpb_rate": round(rate, 5)})
    if _has_table(con, "kpi_dpe"):
        for level, code, ptype, *values in con.execute(
            f"SELECT geo_level, geo_code, property_type, {_select(con, 'kpi_dpe', DPE_FIELDS)} FROM kpi_dpe "
            "WHERE n_dpe >= 10"
        ).fetchall():
            extras.setdefault((level, code), {}).setdefault("energy", {})[ptype] = {
                f: _round(v) for f, v in zip(DPE_FIELDS, values) if v is not None}
    if _has_table(con, "rent_control"):
        for (code,) in con.execute("SELECT code FROM rent_control").fetchall():
            for level in SEARCHABLE_LEVELS:
                put((level, code), "rent_control", True)
    if _has_table(con, "kpi_score"):
        for level, code, period, ptype, score, n, strengths, weaknesses, rti in con.execute(
            "SELECT geo_level, geo_code, period, property_type, score, n_criteria, strengths, weaknesses, "
            "rent_to_income FROM kpi_score"
        ).fetchall():
            extras.setdefault((level, code), {}).setdefault("score", {})[ptype] = {
                "period": period, "score": score, "n_criteria": n, "strengths": strengths,
                "weaknesses": weaknesses, "rent_to_income": None if rti is None else round(rti, 4)}
    if _has_table(con, "kpi_price_bands"):
        for level, code, year, ptype, band, share, n in con.execute(
            f"""SELECT geo_level, geo_code, year, property_type, band, share, n_sales FROM kpi_price_bands
                WHERE n_sales >= 10 AND property_type IN {TYPES}
                ORDER BY geo_level, geo_code, year, property_type, band_order"""
        ).fetchall():
            bands = extras.setdefault((level, code), {}).setdefault("price_bands", {}).setdefault(str(year), {})
            bands.setdefault(ptype, {"n_sales": n, "bands": []})["bands"].append([band, round(share, 4)])
    if _has_table(con, "kpi_stock"):
        columns = [c for c in _columns(con, "kpi_stock") if c not in ("geo_level", "geo_code")]
        for level, code, *values in con.execute(
            f"SELECT geo_level, geo_code, {', '.join(columns)} FROM kpi_stock"
        ).fetchall():
            put((level, code), "stock", {c: _round(v) for c, v in zip(columns, values) if v is not None})
    if _has_table(con, "kpi_rent_oll") and _has_table(con, "oll_commune"):
        for agglo, name, *values in con.execute(
            f"""WITH latest AS (SELECT agglo_code, max(year) AS y FROM kpi_rent_oll GROUP BY agglo_code)
                SELECT o.agglo_code, o.agglomeration, {_select(con, 'kpi_rent_oll', OLL_FIELDS)}
                FROM kpi_rent_oll o JOIN latest l USING (agglo_code)
                -- yearly series of the main cells, every detail for the latest year
                WHERE (o.period_built = 'all' AND o.tenancy = 'all') OR o.year = l.y
                ORDER BY ALL"""
        ).fetchall():
            block = series.setdefault(agglo, {"agglomeration": name, "agglo_code": agglo,
                                              "fields": OLL_FIELDS, "rows": []})
            block["rows"].append([_round(v) for v in values])
        for level, code, agglo in con.execute("SELECT geo_level, geo_code, agglo_code FROM oll_commune").fetchall():
            if agglo in series:
                put((level, code), "oll", {"agglo_code": agglo, "agglomeration": series[agglo]["agglomeration"]})
    return extras, series


def _meta(con: duckdb.DuckDBPyConnection, run_id: str) -> dict:
    """Source of each block, shown in the app's ⓘ (KPI_SPEC §3)."""
    first, last = con.execute(
        "SELECT min(period), max(period) FROM kpi_price WHERE period_type = 'half'"
    ).fetchone()
    meta = {"prices": {"source": "DVF (DGFiP) — ventes signées", "periods": f"{first} → {last}",
                       "computed_at": run_id}}
    if _has_table(con, "kpi_yield"):
        vintage = con.execute("SELECT max(rent_vintage) FROM kpi_yield").fetchone()[0]
        meta["rents"] = {"source": f"ANIL, carte des loyers {vintage} — loyers d'annonce non meublés, charges comprises",
                         "edition": vintage}
    if _has_table(con, "kpi_rent_oll"):
        meta["oll"] = {"source": "Observatoires locaux des loyers — loyers en place, hors charges"}
    if _has_table(con, "kpi_socio"):
        meta["socio"] = {"source": "INSEE, comparateur de territoires"}
    if _has_table(con, "kpi_stock"):
        meta["stock"] = {"source": "INSEE, recensement 2022 (logement)"}
    if _has_table(con, "kpi_dpe"):
        meta["dpe"] = {"source": "ADEME, DPE des logements existants (depuis juillet 2021)"}
    if _has_table(con, "kpi_local_tax"):
        year = con.execute("SELECT max(tax_year) FROM kpi_local_tax").fetchone()[0]
        meta["tax"] = {"source": f"DGFiP, REI {year} (taux global de taxe foncière bâtie)"}
    return meta


def publish(con: duckdb.DuckDBPyConnection, min_sales: int, run_id: str,
            serve_dir: Path = paths.SERVE) -> dict:
    """Write the serve layer from the KPI tables and commune_map."""
    prices = _rows(
        con,
        f"""SELECT geo_level, geo_code, {_select(con, "kpi_price", PRICE_FIELDS)} FROM kpi_price
            WHERE n_sales >= {min_sales}
            ORDER BY condition, property_type, rooms_bucket, period_type, period""",
    )
    yields = _rows(
        con,
        f"""SELECT geo_level, geo_code, {_select(con, "kpi_yield", YIELD_FIELDS)} FROM kpi_yield
            WHERE n_sales >= {min_sales} ORDER BY property_type, rooms_bucket, period""",
    )
    socio = {
        key: dict(zip(SOCIO_FIELDS, rows[0]))
        for key, rows in _rows(
            con, f"SELECT geo_level, geo_code, {_select(con, 'kpi_socio', SOCIO_FIELDS)} FROM kpi_socio"
        ).items()
    }
    extras, oll_series = _extras(con)
    derived = _latest_and_typical(con, min_sales)
    neighbours = _neighbours(con, min_sales)
    from . import dashboard  # dashboard reuses this module's helpers

    curves = dashboard.rent_curves(con)
    meta = _meta(con, run_id)
    names = {
        code: (name, departement, region)
        for code, name, departement, region in con.execute(
            "SELECT code, nom, departement, region FROM commune_map WHERE code = code_commune "
            "OR code = code_arrondissement"
        ).fetchall()
    }

    staging = serve_dir.with_name(serve_dir.name + ".next")
    shutil.rmtree(staging, ignore_errors=True)
    departement_names = dashboard._departement_names()
    departement_regions = dict(con.execute(
        "SELECT departement, min(region) FROM commune_map WHERE departement IS NOT NULL GROUP BY departement"
    ).fetchall())
    index = []
    sizes = []
    for level, code in sorted(prices):
        name, departement, region = names.get(code, (None, None, None))
        if level == "france":
            name = "France"
        elif level == "departement":
            name = departement_names.get(code, name)
            region = departement_regions.get(code)
        elif level == "region":
            name = dashboard.REGION_NAMES.get(code, name)
        doc = {
            "schema_version": SCHEMA_VERSION,
            "code": code,
            "level": level,
            "name": name,
            "departement": departement,
            "region": region,
            "run_id": run_id,
            "price_fields": PRICE_FIELDS,
            "prices": prices[(level, code)],
            "yield_fields": YIELD_FIELDS,
            "yields": yields.get((level, code), []),
            "socio": socio.get((level, code)),
            **derived.get((level, code), {}),
            **({"neighbours": neighbours[(level, code)]} if (level, code) in neighbours else {}),
            **({"rent_curve": curves[(level, code)]} if (level, code) in curves else {}),
            **extras.get((level, code), {}),
        }
        target = staging / "geo" / level / f"{code}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(allow_nan=False, obj=doc, ensure_ascii=False, separators=(",", ":"), default=float)  # DuckDB DECIMAL
        target.write_text(text, encoding="utf-8")
        sizes.append(len(text.encode("utf-8")))
        if level in SEARCHABLE_LEVELS and name:
            population = (doc["socio"] or {}).get("population")
            index.append([code, level, name, departement, population])

    index.sort(key=lambda item: -(item[4] or 0))  # biggest places first in search results
    (staging / "index.json").write_text(
        json.dumps(allow_nan=False, obj={"schema_version": SCHEMA_VERSION, "run_id": run_id,
                    "fields": ["code", "level", "name", "departement", "population"], "places": index},
                   ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (staging / "meta.json").write_text(json.dumps(allow_nan=False, obj=meta, ensure_ascii=False), encoding="utf-8")
    for agglo, block in oll_series.items():
        if not oll.is_agglomeration_code(agglo):
            raise ValueError(f"unexpected OLL agglomeration code {agglo!r}")  # it becomes a file name
        target = staging / "oll" / f"{agglo}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(allow_nan=False, obj=block, ensure_ascii=False, separators=(",", ":"), default=float),
                          encoding="utf-8")
    ranking = _write_ranking(con, staging, run_id)
    dashboard_files = dashboard.write(con, staging, min_sales)
    have_contours = all((mapdata.CONTOURS_DIR / f"{n}.geojson.gz").exists() for n in mapdata.LAYERS.values())
    map_layer = mapdata.write_map_layer(con, staging, min_sales) if have_contours else "no contours"
    shutil.rmtree(serve_dir, ignore_errors=True)
    staging.rename(serve_dir)
    return {"files": len(sizes), "indexed": len(index), "ranked": ranking, "map": map_layer,
            "dashboard": dashboard_files,
            "avg_kb": round(sum(sizes) / max(len(sizes), 1) / 1024, 1),
            "max_kb": round(max(sizes, default=0) / 1024, 1)}


RANKING_FIELDS = ("code", "level", "name", "departement", "region", "property_type", "rooms_bucket", "n_sales",
                  "reliability", "median_price_m2", "typical_price", "median_surface_m2", "yoy_change", "cagr",
                  "rent_m2", "rent_level", "gross_yield", "net_yield", "cash_flow_monthly", "cap_rate",
                  "population", "population_growth_yearly", "vacancy_rate", "flag_high_vacancy",
                  "flag_population_decline", "score", "share_fg", "tfpb_rate", "rent_control")


def _write_ranking(con: duckdb.DuckDBPyConnection, staging: Path, run_id: str) -> int:
    """One file per segment (type × size), communes and arrondissements with at least 30 sales in
    the latest complete year and a yield that is not excluded; the app filters and sorts on device."""
    period = _latest_complete_year(con)
    joins, score, share_fg, rent_control = [], "NULL", "NULL", "false"
    if _has_table(con, "kpi_score"):
        joins.append("LEFT JOIN kpi_score sc ON sc.geo_level = y.geo_level AND sc.geo_code = y.geo_code "
                     "AND sc.property_type = y.property_type")
        score = "sc.score"
    if _has_table(con, "kpi_dpe"):
        joins.append("LEFT JOIN kpi_dpe d ON d.geo_level = y.geo_level AND d.geo_code = y.geo_code "
                     "AND d.property_type = y.property_type")
        share_fg = "round(d.share_fg, 4)"
    if _has_table(con, "rent_control"):
        rent_control = "y.geo_code IN (SELECT code FROM rent_control)"
    socio = {f: f"s.{f}" if f in _columns(con, "kpi_socio") else "NULL"
             for f in ("population", "population_growth_yearly", "vacancy_rate", "flag_high_vacancy",
                       "flag_population_decline")}
    rows = con.execute(
        f"""
        SELECT y.geo_code, y.geo_level, m.nom, m.departement, m.region, y.property_type, y.rooms_bucket,
               p.n_sales, p.reliability, round(p.median_price_m2), p.median_price, p.median_surface_m2,
               round(p.yoy_change, 4), round(p.cagr, 4), round(y.rent_m2, 2), y.rent_level, round(y.gross_yield, 4),
               {socio["population"]}, round({socio["population_growth_yearly"]}, 4), round({socio["vacancy_rate"]}, 4),
               {socio["flag_high_vacancy"]}, {socio["flag_population_decline"]}, {score}, {share_fg}, {rent_control}
        FROM kpi_yield y
        JOIN kpi_price p ON p.geo_level = y.geo_level AND p.geo_code = y.geo_code AND p.period = y.period
             AND p.period_type = y.period_type AND p.property_type = y.property_type
             AND p.rooms_bucket = y.rooms_bucket AND p.condition = 'existing'
        JOIN commune_map m ON m.code = y.geo_code
        LEFT JOIN kpi_socio s ON s.geo_level = y.geo_level AND s.geo_code = y.geo_code
        {" ".join(joins)}
        WHERE y.geo_level IN {SEARCHABLE_LEVELS} AND y.period_type = 'year' AND y.period = '{period}'
          AND y.status = 'ok' AND p.n_sales >= {RELIABLE_SALES}
        ORDER BY y.gross_yield DESC
        """
    ).fetchall()
    rates = _tax_rates(con)
    files: dict[str, list] = {f"{t}_{size_slug(b)}": [] for t in TYPES for b in SIZES[t]}
    for (code, level, name, dep, reg, ptype, bucket, n, reliability, price_m2, price, surface, yoy, cagr,
         rent, rent_level, gross, population, pop_growth, vacancy, high_vacancy, decline, sc, fg, controlled) in rows:
        rate = rates.get((level, code))
        deal = _typical(price, surface, rent, ptype, rate)
        files.setdefault(f"{ptype}_{size_slug(bucket)}", []).append([
            code, level, name, dep, reg, ptype, bucket, n, reliability, price_m2, round(price), round(surface, 1),
            yoy, cagr, rent, rent_level, gross, deal["net_yield"], deal["cash_flow_monthly"], deal["cap_rate"],
            population, pop_growth, vacancy, high_vacancy, decline, sc, fg,
            None if rate is None else round(rate, 4), controlled])
    directory = staging / "ranking"
    directory.mkdir(parents=True, exist_ok=True)
    for slug, segment_rows in files.items():
        (directory / f"{slug}.json").write_text(
            json.dumps(allow_nan=False, obj={"run_id": run_id, "period": period, "min_sales": RELIABLE_SALES,
                        "fields": RANKING_FIELDS, "rows": segment_rows},
                       ensure_ascii=False, separators=(",", ":"), default=float),
            encoding="utf-8",
        )
    (staging / "ranking.json").write_text(
        json.dumps(allow_nan=False, obj={"schema_version": SCHEMA_VERSION, "run_id": run_id, "period": period,
                    "min_sales": RELIABLE_SALES, "segments": sorted(files)}, ensure_ascii=False),
        encoding="utf-8",
    )
    return len(rows)


def sync_app(app_public_data: Path, serve_dir: Path = paths.SERVE) -> None:
    """Copy the serve layer into the Expo app's public folder (served statically on web)."""
    shutil.rmtree(app_public_data, ignore_errors=True)
    shutil.copytree(serve_dir, app_public_data)
