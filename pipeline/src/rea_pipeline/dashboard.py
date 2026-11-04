"""S5 dashboard files: what the web dashboard needs beyond the place pages
(docs/features/014-web-dashboard/spec.md §6). Nothing here is recomputed by the app.

data/serve/
  series/<level>_<type>.json      half-year and year medians of France, régions, départements
                                  (type apartment, house or all; split to keep each file < 1 MB)
  explorer/regions.json           one row per région × type × size (latest complete year)
  explorer/departements.json      one row per département × type × size
  explorer/communes/<dep>.json    one row per commune / arrondissement × type × size
  points/communes.json            commune centroids with their key figures (map, points mode)
  points/sections/<dep>.json      cadastral-section medians (≥ 10 sales, two complete years pooled)
  points/breaks.json              quintile breaks of the section layer
Individual sales are never written: a section point aggregates at least MIN_PUBLISHED_SALES sales.
"""
import json
import statistics
from pathlib import Path

import duckdb

from . import mapdata
from .marts import _market_sales
from .publish import SEARCHABLE_LEVELS, TYPES, _columns, _has_table, _latest_complete_year, _round, _typical

REGION_NAMES = {
    "01": "Guadeloupe", "02": "Martinique", "03": "Guyane", "04": "La Réunion", "06": "Mayotte",
    "11": "Île-de-France", "24": "Centre-Val de Loire", "27": "Bourgogne-Franche-Comté", "28": "Normandie",
    "32": "Hauts-de-France", "44": "Grand Est", "52": "Pays de la Loire", "53": "Bretagne",
    "75": "Nouvelle-Aquitaine", "76": "Occitanie", "84": "Auvergne-Rhône-Alpes",
    "93": "Provence-Alpes-Côte d'Azur", "94": "Corse",
}
EXPLORER_FIELDS = (
    "code", "name", "level", "parent", "type", "size", "n_sales", "reliability", "median_price_m2",
    "p25_price_m2", "p75_price_m2", "median_price", "median_surface_m2", "yoy_change", "cagr", "new_premium",
    "rent_m2", "gross_yield", "net_yield", "cash_flow_monthly", "cap_rate", "score", "share_fg", "vacancy_rate",
    "population", "population_growth_yearly", "median_living_standard", "tenant_share", "tfpb_rate",
    "rent_control", "flag_high_vacancy", "flag_population_decline",
)
SERIES_FIELDS = ("code", "condition", "size", "period_type", "period", "n", "median", "p25", "p75")
SERIES_LEVELS = ("france", "region", "departement")
COMMUNE_POINT_FIELDS = ("code", "level", "name", "dep", "lon", "lat", "type", "n", "median_price_m2",
                        "yoy_change", "gross_yield", "cash_flow_monthly")
CITIES_WITH_ARRONDISSEMENTS = {"75056", "13055", "69123"}
SECTION_FIELDS = ("section", "commune", "lon", "lat", "type", "n", "median_price_m2")


def _dump(path: Path, doc: dict) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), default=float, allow_nan=False)
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def _column(con: duckdb.DuckDBPyConnection, table: str, column: str, alias: str) -> str:
    """`alias.column`, or NULL when the table or the column does not exist (older marts, tests)."""
    if _has_table(con, table) and column in _columns(con, table):
        return f"{alias}.{column}"
    return "NULL"


def _join(con: duckdb.DuckDBPyConnection, table: str, sql: str) -> str:
    return sql if _has_table(con, table) else ""


def _departement_names() -> dict[str, str]:
    try:
        return {f["properties"]["code"]: f["properties"]["nom"] for f in mapdata._load("departements")}
    except (FileNotFoundError, OSError, KeyError):
        return {}


def _series(con: duckdb.DuckDBPyConnection, level: str, property_type: str, min_sales: int) -> dict:
    rows = con.execute(
        f"""SELECT geo_code, condition, rooms_bucket, period_type, period, n_sales,
                   median_price_m2, p25_price_m2, p75_price_m2
            FROM kpi_price WHERE geo_level = ? AND property_type = ? AND n_sales >= {min_sales}
            ORDER BY ALL""", [level, property_type]
    ).fetchall()
    return {"level": level, "type": property_type, "fields": SERIES_FIELDS,
            "rows": [[_round(v) for v in r] for r in rows]}


def _explorer_rows(con: duckdb.DuckDBPyConnection, min_sales: int) -> list[dict]:
    period = _latest_complete_year(con)
    rows = con.execute(
        f"""
        WITH parents AS (
            SELECT departement AS code, any_value(region) AS region FROM commune_map GROUP BY departement
        )
        SELECT p.geo_code, m.nom, p.geo_level,
               CASE WHEN p.geo_level IN ('commune', 'arrondissement') THEN m.departement
                    WHEN p.geo_level = 'departement' THEN pa.region ELSE 'FR' END,
               p.property_type, p.rooms_bucket, p.n_sales, p.reliability, p.median_price_m2, p.p25_price_m2,
               p.p75_price_m2, p.median_price, p.median_surface_m2, p.yoy_change, p.cagr,
               {_column(con, "kpi_price", "new_premium", "p")},
               CASE WHEN y.status = 'ok' THEN y.rent_m2 END, CASE WHEN y.status = 'ok' THEN y.gross_yield END,
               {_column(con, "kpi_score", "score", "sc")}, {_column(con, "kpi_dpe", "share_fg", "d")},
               {_column(con, "kpi_socio", "vacancy_rate", "s")}, {_column(con, "kpi_socio", "population", "s")},
               {_column(con, "kpi_socio", "population_growth_yearly", "s")},
               {_column(con, "kpi_socio", "median_living_standard", "s")},
               {_column(con, "kpi_stock", "tenant_share", "st")}, {_column(con, "kpi_local_tax", "tfpb_rate", "t")},
               {"p.geo_code IN (SELECT code FROM rent_control)" if _has_table(con, "rent_control") else "false"},
               {_column(con, "kpi_socio", "flag_high_vacancy", "s")},
               {_column(con, "kpi_socio", "flag_population_decline", "s")}
        FROM kpi_price p
        LEFT JOIN commune_map m ON m.code = p.geo_code AND p.geo_level IN ('commune', 'arrondissement')
        LEFT JOIN parents pa ON pa.code = p.geo_code AND p.geo_level = 'departement'
        LEFT JOIN kpi_yield y ON y.geo_level = p.geo_level AND y.geo_code = p.geo_code AND y.period = p.period
             AND y.period_type = p.period_type AND y.property_type = p.property_type
             AND y.rooms_bucket = p.rooms_bucket
        {_join(con, "kpi_score", "LEFT JOIN kpi_score sc ON sc.geo_level = p.geo_level AND sc.geo_code = p.geo_code "
                                 "AND sc.property_type = p.property_type")}
        {_join(con, "kpi_dpe", "LEFT JOIN kpi_dpe d ON d.geo_level = p.geo_level AND d.geo_code = p.geo_code "
                               "AND d.property_type = p.property_type")}
        {_join(con, "kpi_socio", "LEFT JOIN kpi_socio s ON s.geo_level = p.geo_level AND s.geo_code = p.geo_code")}
        {_join(con, "kpi_stock", "LEFT JOIN kpi_stock st ON st.geo_level = p.geo_level AND st.geo_code = p.geo_code")}
        {_join(con, "kpi_local_tax", "LEFT JOIN kpi_local_tax t ON t.geo_level = p.geo_level "
                                     "AND t.geo_code = p.geo_code")}
        WHERE p.period_type = 'year' AND p.period = '{period}' AND p.condition = 'existing'
          AND p.property_type IN {TYPES} AND p.geo_level <> 'france' AND p.n_sales >= {min_sales}
        ORDER BY p.geo_level, p.geo_code, p.property_type, p.rooms_bucket
        """
    ).fetchall()
    departements = _departement_names()
    out = []
    for values in rows:
        row = dict(zip(EXPLORER_FIELDS[:16] + ("rent_m2", "gross_yield") + EXPLORER_FIELDS[21:], values))
        level, code = row["level"], row["code"]
        if level == "departement":
            row["name"] = departements.get(code, code)
        elif level == "region":
            row["name"] = REGION_NAMES.get(code, code)
        deal = (_typical(row["median_price"], row["median_surface_m2"], row["rent_m2"], row["type"], row["tfpb_rate"])
                if row["rent_m2"] is not None and row["median_price"] and row["median_surface_m2"] else {})
        row |= {"net_yield": deal.get("net_yield"), "cash_flow_monthly": deal.get("cash_flow_monthly"),
                "cap_rate": deal.get("cap_rate")}
        out.append({f: _round(row.get(f)) for f in EXPLORER_FIELDS})
    return out


def _explorer_doc(rows: list[dict], period: str | None) -> dict:
    return {"period": period, "fields": EXPLORER_FIELDS, "rows": [[r[f] for f in EXPLORER_FIELDS] for r in rows]}


def _commune_points(con: duckdb.DuckDBPyConnection, min_sales: int) -> dict:
    if not _has_table(con, "commune_point"):
        return {"fields": COMMUNE_POINT_FIELDS, "rows": []}
    period = _latest_complete_year(con)
    rows = con.execute(
        f"""SELECT p.geo_code, p.geo_level, m.nom, m.departement, round(pt.longitude, 5), round(pt.latitude, 5),
                   p.property_type, p.n_sales, round(p.median_price_m2), round(p.yoy_change, 4),
                   CASE WHEN y.status = 'ok' THEN round(y.gross_yield, 4) END,
                   p.median_price, p.median_surface_m2, CASE WHEN y.status = 'ok' THEN y.rent_m2 END,
                   {_column(con, "kpi_local_tax", "tfpb_rate", "t")}
            FROM kpi_price p
            JOIN commune_point pt ON pt.code = p.geo_code
            JOIN commune_map m ON m.code = p.geo_code
            LEFT JOIN kpi_yield y ON y.geo_level = p.geo_level AND y.geo_code = p.geo_code AND y.period = p.period
                 AND y.period_type = p.period_type AND y.property_type = p.property_type
                 AND y.rooms_bucket = p.rooms_bucket
            {_join(con, "kpi_local_tax", "LEFT JOIN kpi_local_tax t ON t.geo_level = p.geo_level "
                                         "AND t.geo_code = p.geo_code")}
            WHERE p.geo_level IN {SEARCHABLE_LEVELS} AND p.period_type = 'year' AND p.period = '{period}'
              AND p.condition = 'existing' AND p.property_type IN {TYPES} AND p.rooms_bucket = 'all'
              AND p.n_sales >= {min_sales}
            ORDER BY p.geo_code, p.property_type"""
    ).fetchall()
    out = []
    for code, level, name, dep, lon, lat, ptype, n, m2, yoy, gross, price, surface, rent, rate in rows:
        cash_flow = (_typical(price, surface, rent, ptype, rate)["cash_flow_monthly"]
                     if rent is not None and price and surface else None)
        out.append([code, level, name, dep, _round(lon), _round(lat), ptype, n, _round(m2), _round(yoy),
                    _round(gross), cash_flow])
    return {"period": period, "fields": COMMUNE_POINT_FIELDS, "rows": out}


def _section_points(con: duckdb.DuckDBPyConnection, min_sales: int) -> tuple[str | None, dict[str, list]]:
    """Section medians of existing homes over the last two complete years, at least min_sales sales."""
    if not _has_table(con, "dvf_sales"):
        return None, {}
    last = con.execute(
        "SELECT max(year) FROM (SELECT year FROM dvf_sales GROUP BY year HAVING count(DISTINCT half) = 2)"
    ).fetchone()[0]
    if last is None:
        return None, {}
    rows = con.execute(
        f"""WITH market AS ({_market_sales()})
            SELECT code_departement, section, code_commune,
                   round(any_value(longitude) FILTER (WHERE location_precision = 'section'), 5),
                   round(any_value(latitude) FILTER (WHERE location_precision = 'section'), 5),
                   property_type, count(*) AS n, round(median(price_m2))
            FROM market
            WHERE condition = 'existing' AND year BETWEEN {last - 1} AND {last} AND section IS NOT NULL
            GROUP BY code_departement, section, code_commune, property_type
            HAVING count(*) >= {min_sales}
               AND any_value(longitude) FILTER (WHERE location_precision = 'section') IS NOT NULL
            ORDER BY ALL"""
    ).fetchall()
    by_dep: dict[str, list] = {}
    for dep, section, commune, lon, lat, ptype, n, m2 in rows:
        # Paris, Lyon, Marseille: DVF files the city, the section id starts with the arrondissement
        if commune in CITIES_WITH_ARRONDISSEMENTS:
            commune = section[:5]
        by_dep.setdefault(dep, []).append([section, commune, _round(lon), _round(lat), ptype, n, _round(m2)])
    return f"{last - 1}-{last}", by_dep


def rent_curves(con: duckdb.DuckDBPyConnection) -> dict[tuple[str, str], dict]:
    """ANIL rent curve per commune / arrondissement and type, so the app can read the rent at a
    property's own surface. Cities made of several ANIL codes (Paris, Lyon, Marseille) get none."""
    if not _has_table(con, "rent_child"):
        return {}
    curves: dict[tuple[str, str], dict] = {}
    for level, code, ptype, rent, surface, slope in con.execute(
        """SELECT 'commune', code_commune, any_value(property_type), any_value(ref_rent_m2),
                  any_value(ref_surface), any_value(slope)
           FROM rent_child GROUP BY code_commune, property_type HAVING count(DISTINCT code) = 1
           UNION ALL
           SELECT 'arrondissement', code_arrondissement, property_type, ref_rent_m2, ref_surface, slope
           FROM rent_child WHERE code_arrondissement IS NOT NULL"""
    ).fetchall():
        curves.setdefault((level, code), {})[ptype] = {
            "ref_rent_m2": _round(rent), "ref_surface": surface, "slope": _round(slope)}
    return curves


def write(con: duckdb.DuckDBPyConnection, serve_dir: Path, min_sales: int) -> dict:
    """Write every dashboard file into serve_dir (the publish staging folder)."""
    period = _latest_complete_year(con)
    explorer = _explorer_rows(con, min_sales)
    stats = {"series_max_kb": round(max(
        _dump(serve_dir / "series" / f"{level}_{t}.json", _series(con, level, t, min_sales))
        for level in SERIES_LEVELS for t in (*TYPES, "all")) / 1024)}
    _dump(serve_dir / "explorer" / "regions.json", _explorer_doc([r for r in explorer if r["level"] == "region"], period))
    _dump(serve_dir / "explorer" / "departements.json",
          _explorer_doc([r for r in explorer if r["level"] == "departement"], period))
    departements = [d for (d,) in con.execute(
        "SELECT DISTINCT departement FROM commune_map WHERE departement IS NOT NULL ORDER BY 1").fetchall()]
    local = [r for r in explorer if r["level"] in SEARCHABLE_LEVELS]
    sizes = [_dump(serve_dir / "explorer" / "communes" / f"{dep}.json",
                   _explorer_doc([r for r in local if r["parent"] == dep], period)) for dep in departements]
    stats["explorer_max_kb"] = round(max(sizes, default=0) / 1024)
    stats["points_kb"] = round(_dump(serve_dir / "points" / "communes.json", _commune_points(con, min_sales)) / 1024)
    section_period, sections = _section_points(con, min_sales)
    section_sizes = [_dump(serve_dir / "points" / "sections" / f"{dep}.json",
                           {"period": section_period, "fields": SECTION_FIELDS, "rows": sections.get(dep, [])})
                     for dep in departements]
    prices = {t: [r[6] for rows in sections.values() for r in rows if r[4] == t] for t in TYPES}
    _dump(serve_dir / "points" / "breaks.json",
          {f"price_{t}": [round(b) for b in statistics.quantiles(v, n=5)] for t, v in prices.items() if len(v) >= 2})
    stats |= {"sections": sum(len(v) for v in sections.values()),
              "sections_max_kb": round(max(section_sizes, default=0) / 1024)}
    return stats
