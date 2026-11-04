"""Map layer: GeoJSON per département with KPIs (docs/features/005-map/spec.md)."""
import gzip
import json
from pathlib import Path

import duckdb

from rea_pipeline import mapdata


def _square(x: float) -> dict:
    return {"type": "Polygon", "coordinates": [[[x, 45], [x + 0.1, 45], [x + 0.1, 45.1], [x, 45.1], [x, 45]]]}


def _contours(directory: Path) -> None:
    directory.mkdir(parents=True)
    communes = [
        {"code": "49007", "nom": "Angers", "departement": "49"},
        {"code": "49099", "nom": "Small", "departement": "49"},
        {"code": "75056", "nom": "Paris", "departement": "75"},
        {"code": "75101", "nom": "Paris 1er", "departement": "75"},
    ]
    layers = {
        "communes-100m": [{"type": "Feature", "properties": c, "geometry": _square(i)} for i, c in enumerate(communes)],
        "departements-1000m": [{"type": "Feature", "properties": {"code": d, "nom": d}, "geometry": _square(i)}
                               for i, d in enumerate(("49", "75"))],
    }
    for name, features in layers.items():
        with gzip.open(directory / f"{name}.geojson.gz", "wt", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)


def _kpi_tables(con) -> None:
    rows = [
        # level, code, type, n, €/m², cagr, median price, surface
        ("commune", "49007", "apartment", 1600, 3147.0, -0.01, 150000.0, 48.0),
        ("commune", "49007", "house", 400, 2500.0, 0.02, 250000.0, 100.0),
        ("commune", "49007", "all", 2800, 3000.0, -0.01, 170000.0, 60.0),
        ("commune", "49099", "apartment", 12, 2000.0, None, 90000.0, 45.0),
        ("arrondissement", "75101", "apartment", 300, 13000.0, 0.0, 500000.0, 38.0),
        ("departement", "49", "apartment", 9000, 2500.0, 0.0, 130000.0, 52.0),
    ]
    con.execute("""CREATE TABLE kpi_price (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR, period VARCHAR,
                   is_partial BOOLEAN, condition VARCHAR, property_type VARCHAR, rooms_bucket VARCHAR,
                   n_sales INTEGER, median_price_m2 DOUBLE, cagr DOUBLE, median_price DOUBLE, median_surface_m2 DOUBLE)""")
    for level, code, ptype, n, m2, cagr, price, surface in rows:
        con.execute("INSERT INTO kpi_price VALUES (?, ?, 'year', '2025', false, 'existing', ?, 'all', ?, ?, ?, ?, ?)",
                    [level, code, ptype, n, m2, cagr, price, surface])
    con.execute("""CREATE TABLE kpi_yield AS SELECT * FROM (VALUES
                   ('commune', '49007', 'year', '2025', 'apartment', 'all', 0.0555, 14.6, 'ok'),
                   ('arrondissement', '75101', 'year', '2025', 'apartment', 'all', 0.03, 32.0, 'ok'))
                   t(geo_level, geo_code, period_type, period, property_type, rooms_bucket, gross_yield, rent_m2, status)""")
    con.execute("""CREATE TABLE kpi_socio AS SELECT 'commune' AS geo_level, '49007' AS geo_code,
                   0.059 AS vacancy_rate, 0.007 AS population_growth_yearly""")
    con.execute("""CREATE TABLE kpi_dpe AS SELECT * FROM (VALUES ('commune', '49007', 'apartment', 800, 0.08),
                   ('commune', '49007', 'house', 200, 0.18)) t(geo_level, geo_code, property_type, n_dpe, share_fg)""")
    con.execute("CREATE TABLE rent_control AS SELECT '75101' AS code")


def test_map_layer(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mapdata, "CONTOURS_DIR", tmp_path / "contours")
    _contours(tmp_path / "contours")
    con = duckdb.connect()
    _kpi_tables(con)

    sizes = mapdata.write_map_layer(con, tmp_path / "serve", min_sales=10)
    assert sizes["commune_files"] == 2

    anjou = json.loads((tmp_path / "serve" / "map" / "communes" / "49.geojson").read_text(encoding="utf-8"))
    props = {f["properties"]["code"]: f["properties"] for f in anjou["features"]}
    angers = props["49007"]
    assert angers["price_apartment"] == 3147.0 and angers["yield_apartment"] == 0.0555
    assert angers["share_fg_house"] == 0.18 and angers["cash_flow_apartment"] is not None
    # flats and houses together never get a map colour
    assert not any(k.endswith("_all") for k in angers)
    # 12 sales: the count is shown, the value is not coloured (< 30)
    assert props["49099"]["sales_apartment"] == 12 and "price_apartment" not in props["49099"]

    paris = json.loads((tmp_path / "serve" / "map" / "communes" / "75.geojson").read_text(encoding="utf-8"))
    codes = [f["properties"]["code"] for f in paris["features"]]
    assert codes == ["75101"]  # the city polygon is replaced by its arrondissements
    assert paris["features"][0]["properties"]["rent_control"] is True

    deps = json.loads((tmp_path / "serve" / "map" / "departements.geojson").read_text(encoding="utf-8"))
    assert {f["properties"]["code"]: f["properties"].get("price_apartment") for f in deps["features"]} == {
        "49": 2500.0, "75": None}


def test_breaks_are_published(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(mapdata, "CONTOURS_DIR", tmp_path / "contours")
    _contours(tmp_path / "contours")
    con = duckdb.connect()
    _kpi_tables(con)
    mapdata.write_map_layer(con, tmp_path / "serve", min_sales=10)
    breaks = json.loads((tmp_path / "serve" / "map" / "breaks.json").read_text(encoding="utf-8"))
    communes = breaks["communes"]["price_apartment"]
    assert len(communes) == 4 and communes == sorted(communes)
    assert "price_all" not in breaks["communes"]
