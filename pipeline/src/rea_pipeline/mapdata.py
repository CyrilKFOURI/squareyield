"""S5 map layer: GeoJSON with KPIs for the app's choropleth maps (docs/features/005-map/spec.md).

data/serve/map/
  departements.geojson         every département with its KPIs (France view)
  communes/<departement>.geojson  its communes (Paris/Lyon/Marseille as arrondissements), loaded on click
Geometries: Etalab "contours administratifs" (communes simplified to 100 m, départements to 1 km).
Values are per property type only (flats and houses are never coloured together) and only for
cells with at least 30 sales (marts.RELIABLE_SALES): thinner places show their sales count and stay
grey. map/breaks.json holds the quintile breaks of every metric, so the app does not compute them.
"""
import gzip
import json
import statistics
from decimal import Decimal
from pathlib import Path

import duckdb
import httpx

from . import deals, paths
from .ingest import download
from .marts import RELIABLE_SALES

CONTOURS_URL = "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/latest/geojson/{name}.geojson.gz"
CONTOURS_DIR = paths.RAW / "contours"
LAYERS = {"communes": "communes-100m", "departements": "departements-1000m"}
CITY_WITH_ARRONDISSEMENTS = ("75056", "69123", "13055")

TYPES = ("apartment", "house")


def ingest_contours() -> dict:
    with httpx.Client(follow_redirects=True, timeout=600) as client:
        return {layer: download(CONTOURS_URL.format(name=name), CONTOURS_DIR / f"{name}.geojson.gz", client)
                for layer, name in LAYERS.items()}


def _load(layer: str) -> list[dict]:
    with gzip.open(CONTOURS_DIR / f"{LAYERS[layer]}.geojson.gz", "rt", encoding="utf-8") as f:
        return json.load(f)["features"]


def _has(con: duckdb.DuckDBPyConnection, table: str) -> bool:
    return con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name = ?", [table]).fetchone()[0] > 0


def _kpis(con: duckdb.DuckDBPyConnection, levels: tuple[str, ...], min_sales: int) -> dict[tuple[str, str], dict]:
    """Map properties per (geo_level, geo_code) for the latest complete year, all sizes."""
    level_list = ", ".join(f"'{l}'" for l in levels)
    rates = dict(((l, c), r) for l, c, r in con.execute(
        "SELECT geo_level, geo_code, tfpb_rate FROM kpi_local_tax").fetchall()) if _has(con, "kpi_local_tax") else {}
    out: dict[tuple[str, str], dict] = {}
    for level, code, ptype, n, price_m2, cagr, price, surface, gross, rent in con.execute(
        f"""
        WITH latest AS (
            SELECT max(period) AS latest_period FROM kpi_price WHERE period_type = 'year' AND NOT is_partial
        )
        SELECT p.geo_level, p.geo_code, p.property_type, p.n_sales, p.median_price_m2, p.cagr,
               p.median_price, p.median_surface_m2,
               CASE WHEN y.status = 'ok' THEN y.gross_yield END, CASE WHEN y.status = 'ok' THEN y.rent_m2 END
        FROM kpi_price p
        JOIN latest ON p.period = latest.latest_period
        LEFT JOIN kpi_yield y ON y.geo_level = p.geo_level AND y.geo_code = p.geo_code
             AND y.period_type = p.period_type AND y.period = p.period
             AND y.property_type = p.property_type AND y.rooms_bucket = p.rooms_bucket
        WHERE p.geo_level IN ({level_list}) AND p.rooms_bucket = 'all' AND p.condition = 'existing'
          AND p.property_type IN {TYPES} AND p.n_sales >= {min_sales}
        """
    ).fetchall():
        props = out.setdefault((level, code), {})
        props[f"sales_{ptype}"] = n
        if n < RELIABLE_SALES:
            continue  # too few sales to colour: grey on the map, count in the tooltip
        props |= {f"price_{ptype}": price_m2, f"trend_{ptype}": cagr, f"yield_{ptype}": gross}
        if gross is not None and price and surface:
            rate = rates.get((level, code))
            deal = deals.typical_deal(float(price), float(surface), float(rent), ptype,
                                      None if rate is None else float(rate))
            props |= {f"net_yield_{ptype}": deal["net_yield"], f"cash_flow_{ptype}": deal["cash_flow_monthly"]}

    def add(query: str, names: tuple[str, ...]):
        for level, code, *values in con.execute(query).fetchall():
            if (level, code) in out:
                out[(level, code)].update(dict(zip(names, values)))

    add(f"SELECT geo_level, geo_code, vacancy_rate, population_growth_yearly FROM kpi_socio "
        f"WHERE geo_level IN ({level_list})", ("vacancy", "population_growth"))
    if _has(con, "kpi_dpe"):
        add(f"""SELECT geo_level, geo_code,
                       max(share_fg) FILTER (WHERE property_type = 'apartment'),
                       max(share_fg) FILTER (WHERE property_type = 'house')
                FROM kpi_dpe WHERE geo_level IN ({level_list}) AND n_dpe >= 10 GROUP BY ALL""",
            ("share_fg_apartment", "share_fg_house"))
    if _has(con, "kpi_score"):
        add("SELECT geo_level, geo_code, max(score) FILTER (WHERE property_type = 'apartment'), "
            "max(score) FILTER (WHERE property_type = 'house') FROM kpi_score GROUP BY ALL",
            ("score_apartment", "score_house"))
    if rates:
        add(f"SELECT geo_level, geo_code, tfpb_rate FROM kpi_local_tax WHERE geo_level IN ({level_list})",
            ("tfpb_rate",))
    return out


def _breaks(features: list[dict]) -> dict[str, list[float]]:
    """Quintile breaks (20/40/60/80 %) of every numeric property present on at least 2 features."""
    values: dict[str, list[float]] = {}
    for feature in features:
        for key, value in feature["properties"].items():
            if isinstance(value, (int, float)) and not isinstance(value, bool) and not key.startswith("sales_"):
                values.setdefault(key, []).append(float(value))
    return {key: [round(b, 5) for b in statistics.quantiles(v, n=5)] for key, v in sorted(values.items())
            if len(v) >= 2}


def _clean(values: dict) -> dict:
    return {k: (round(float(v), 4) if isinstance(v, (float, Decimal)) else v) for k, v in values.items() if v is not None}


def _write(path: Path, features: list[dict]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(allow_nan=False, obj={"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode("utf-8"))


def write_map_layer(con: duckdb.DuckDBPyConnection, serve_dir: Path, min_sales: int) -> dict:
    """Write map/departements.geojson and map/communes/<dep>.geojson into serve_dir."""
    departement_kpis = _kpis(con, ("departement",), min_sales)
    commune_kpis = _kpis(con, ("commune", "arrondissement"), min_sales)
    rent_control = (
        {c for (c,) in con.execute("SELECT code FROM rent_control").fetchall()} if _has(con, "rent_control") else set()
    )

    departements = [
        {"type": "Feature", "geometry": f["geometry"],
         "properties": {"code": f["properties"]["code"], "nom": f["properties"]["nom"],
                        **_clean(departement_kpis.get(("departement", f["properties"]["code"]), {}))}}
        for f in _load("departements")
    ]
    sizes = {"departements": _write(serve_dir / "map" / "departements.geojson", departements)}

    by_departement: dict[str, list[dict]] = {}
    for feature in _load("communes"):
        props = feature["properties"]
        code = props["code"]
        if code in CITY_WITH_ARRONDISSEMENTS:
            continue  # shown as its arrondissements
        level = "arrondissement" if code[:3] in ("751", "132") or code.startswith("6938") else "commune"
        by_departement.setdefault(props["departement"], []).append({
            "type": "Feature", "geometry": feature["geometry"],
            "properties": {"code": code, "nom": props["nom"], "level": level,
                           **({"rent_control": True} if code in rent_control else {}),
                           **_clean(commune_kpis.get((level, code), {}))},
        })
    commune_bytes = [
        _write(serve_dir / "map" / "communes" / f"{dep}.geojson", features) for dep, features in by_departement.items()
    ]
    breaks = {"departements": _breaks(departements),
              "communes": _breaks([f for features in by_departement.values() for f in features])}
    (serve_dir / "map" / "breaks.json").write_text(json.dumps(allow_nan=False, obj=breaks, separators=(",", ":")), encoding="utf-8")
    sizes |= {"commune_files": len(commune_bytes), "commune_max_kb": round(max(commune_bytes) / 1024),
              "departements_kb": round(sizes["departements"] / 1024)}
    return sizes
