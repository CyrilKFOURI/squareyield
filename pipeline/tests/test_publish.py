"""Serve layer v2 written for the app (docs/features/013-comparable-segments/spec.md §2.7–2.8)."""
import json
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import deals, mapdata, publish


@pytest.fixture(autouse=True)
def no_contours(tmp_path: Path, monkeypatch):
    """Publication tests never read the real contours in data/raw (the map has its own test)."""
    monkeypatch.setattr(mapdata, "CONTOURS_DIR", tmp_path / "no-contours")


# (geo_level, code, period_type, period, is_partial, condition, type, bucket, n, €/m², price, surface)
PRICES = [
    ("commune", "49007", "year", "2024", False, "existing", "apartment", "all", 1500, 3000.0, 150000.0, 50.0),
    ("commune", "49007", "year", "2025", False, "existing", "apartment", "all", 1600, 3100.0, 155000.0, 50.0),
    ("commune", "49007", "year", "2026", True, "existing", "apartment", "all", 700, 3150.0, 157000.0, 50.0),
    ("commune", "49007", "half", "2026-H1", False, "existing", "apartment", "all", 700, 3150.0, 157000.0, 50.0),
    ("commune", "49007", "year", "2025", False, "existing", "apartment", "2", 600, 3200.0, 140000.0, 44.0),
    ("commune", "49007", "year", "2025", False, "existing", "apartment", "5+", 15, 2800.0, 300000.0, 105.0),
    ("commune", "49007", "year", "2025", False, "existing", "house", "all", 400, 2500.0, 250000.0, 100.0),
    ("commune", "49007", "year", "2025", False, "new", "apartment", "all", 40, 4200.0, 230000.0, 55.0),
    ("commune", "49007", "year", "2025", False, "existing", "all", "all", 2000, 2900.0, 170000.0, 60.0),
    ("commune", "49015", "year", "2025", False, "existing", "apartment", "all", 50, 2500.0, 120000.0, 48.0),
    ("commune", "49020", "year", "2025", False, "existing", "apartment", "all", 35, 2400.0, 110000.0, 46.0),
    ("commune", "75056", "year", "2025", False, "existing", "apartment", "all", 9, 9600.0, 400000.0, 40.0),
    ("arrondissement", "75101", "year", "2025", False, "existing", "apartment", "all", 300, 13000.0, 500000.0, 38.0),
    ("france", "FR", "year", "2025", False, "existing", "apartment", "all", 800000, 3300.0, 180000.0, 55.0),
    ("region", "52", "year", "2025", False, "existing", "apartment", "all", 30000, 2700.0, 140000.0, 52.0),
    ("departement", "49", "year", "2025", False, "existing", "apartment", "all", 9000, 2600.0, 135000.0, 52.0),
]

# (code, type, bucket, rent €/m² charges incl., status)
YIELDS = [
    ("49007", "apartment", "all", 14.6, "ok"),
    ("49007", "apartment", "2", 15.2, "ok"),
    ("49007", "house", "all", 10.0, "ok"),
    ("49015", "apartment", "all", 12.0, "ok"),
    ("49020", "apartment", "all", 11.0, "excluded"),
]


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES
               ('49007', '49007', NULL, 'Angers', '49', '52'),
               ('49015', '49015', NULL, 'Avrillé', '49', '52'),
               ('49020', '49020', NULL, 'Beaucouzé', '49', '52'),
               ('75056', '75056', NULL, 'Paris', '75', '11'),
               ('75101', '75056', '75101', 'Paris 1er', '75', '11'))
           t(code, code_commune, code_arrondissement, nom, departement, region)"""
    )
    con.execute(
        """CREATE TABLE kpi_price (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR, period VARCHAR,
               year INTEGER, is_partial BOOLEAN, condition VARCHAR, property_type VARCHAR, rooms_bucket VARCHAR,
               n_sales INTEGER, reliability VARCHAR, median_price_m2 DOUBLE, p25_price_m2 DOUBLE,
               p75_price_m2 DOUBLE, median_price DOUBLE, yoy_change DOUBLE, median_surface_m2 DOUBLE,
               cagr DOUBLE, cagr_since INTEGER, new_premium DOUBLE, run_id VARCHAR)"""
    )
    for level, code, ptype_, period, partial, cond, ptype, bucket, n, m2, price, surface in PRICES:
        con.execute(
            "INSERT INTO kpi_price VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.02, ?, 0.01, 2022, NULL, 'r')",
            [level, code, ptype_, period, int(period[:4]), partial, cond, ptype, bucket, n,
             "ok" if n >= 30 else "low", m2, m2 * 0.8, m2 * 1.2, price, surface],
        )
    con.execute(
        """CREATE TABLE kpi_yield (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR, period VARCHAR,
               property_type VARCHAR, rooms_bucket VARCHAR, n_sales INTEGER, median_price_m2 DOUBLE, rent_m2 DOUBLE,
               rent_low_m2 DOUBLE, rent_high_m2 DOUBLE, rent_surface_m2 DOUBLE, rent_method VARCHAR,
               rent_level VARCHAR, rent_caution BOOLEAN, rent_coverage DOUBLE, n_listings INTEGER,
               rent_vintage INTEGER, gross_yield DOUBLE, price_to_rent_years DOUBLE, status VARCHAR, reason VARCHAR,
               run_id VARCHAR)"""
    )
    for code, ptype, bucket, rent, status in YIELDS:
        n, m2, surface = next((p[8], p[9], p[11]) for p in PRICES
                              if p[1] == code and p[3] == "2025" and p[6] == ptype and p[7] == bucket)
        ok = status == "ok"
        con.execute(
            "INSERT INTO kpi_yield VALUES ('commune', ?, 'year', '2025', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'commune', false, 1.0,"
            " 3000, 2025, ?, ?, ?, ?, 'r')",
            [code, ptype, bucket, n, m2, rent, rent * 0.8, rent * 1.2, surface,
             "house_approx" if ptype == "house" else "surface_adjusted",
             12 * rent / m2 if ok else None, m2 / (12 * rent) if ok else None, status,
             None if ok else "yield_above_ceiling"],
        )
    socio_columns = ", ".join(f"NULL AS {f}" for f in publish.SOCIO_FIELDS if f != "population")
    con.execute(f"""CREATE TABLE kpi_socio AS SELECT * FROM (
                    SELECT 'commune' AS geo_level, '49007' AS geo_code, 159022 AS population, {socio_columns}
                    UNION ALL SELECT 'commune', '49015', 14000, {socio_columns}
                    UNION ALL SELECT 'commune', '49020', 5500, {socio_columns})""")
    # Avrillé 4 km north of Angers, Beaucouzé 5 km west, Paris far away
    con.execute("""CREATE TABLE commune_point AS SELECT * FROM (VALUES
                   ('49007', -0.5541, 47.4784), ('49015', -0.5900, 47.5100), ('49020', -0.6250, 47.4740),
                   ('75101', 2.3400, 48.8600)) t(code, longitude, latitude)""")
    return con


def _with_extras(con: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    con.execute("CREATE TABLE kpi_local_tax AS SELECT 'commune' AS geo_level, '49007' AS geo_code, "
                "2025 AS tax_year, 0.5665 AS tfpb_rate")
    con.execute("CREATE TABLE rent_control AS SELECT '75101' AS code")
    con.execute("CREATE TABLE kpi_score AS SELECT 'commune' AS geo_level, '49007' AS geo_code, '2025' AS period, "
                "'apartment' AS property_type, 71.5 AS score, 7 AS n_criteria, ['jobs_growth_yearly'] AS strengths, "
                "['gross_yield'] AS weaknesses, 0.33 AS rent_to_income")
    con.execute("""CREATE TABLE kpi_dpe AS SELECT * FROM (VALUES
                   ('commune', '49007', 'all', 1000, 0.1), ('commune', '49007', 'apartment', 800, 0.08),
                   ('commune', '49007', 'house', 200, 0.18)) t(geo_level, geo_code, property_type, n_dpe, share_fg)""")
    con.execute("""CREATE TABLE kpi_price_bands AS SELECT * FROM (VALUES
                   ('commune', '49007', 2024, 'apartment', '0-100k', 0, 1500, 0.2),
                   ('commune', '49007', 2025, 'apartment', '0-100k', 0, 1600, 0.1)) t(geo_level, geo_code, year,
                   property_type, band, band_order, n_sales, share)""")
    con.execute("""CREATE TABLE kpi_stock AS SELECT 'commune' AS geo_level, '49007' AS geo_code,
                   0.22 AS share_houses, 0.77 AS share_apartments, 0.55 AS tenant_share""")
    con.execute("""CREATE TABLE oll_commune AS SELECT 'commune' AS geo_level, '49007' AS geo_code, 'L4900' AS agglo_code""")
    con.execute("""CREATE TABLE kpi_rent_oll AS SELECT * FROM (VALUES
                   ('L4900', 'Agglomération d''Angers', 'B4900', 2024, 'all', 'all', 'all', 'all', 9.8),
                   ('L4900', 'Agglomération d''Angers', 'B4900', 2025, 'all', 'all', 'all', 'all', 10.1),
                   ('L4900', 'Agglomération d''Angers', 'B4900', 2025, 'apartment', '2', '<1946', 'new', 12.0))
                   t(agglo_code, agglomeration, observatory, year, property_type, rooms, period_built, tenancy,
                     rent_m2_median)""")
    return con


@pytest.fixture
def serve(tmp_path: Path) -> Path:
    directory = tmp_path / "serve"
    publish.publish(_with_extras(_con()), min_sales=10, run_id="r3", serve_dir=directory)
    return directory


def _place(serve: Path, level: str, code: str) -> dict:
    return json.loads((serve / "geo" / level / f"{code}.json").read_text(encoding="utf-8"))


def test_schema_and_fields(serve):
    angers = _place(serve, "commune", "49007")
    assert angers["schema_version"] == 2
    assert {"condition", "reliability", "new_premium"} <= set(angers["price_fields"])
    assert {"status", "reason", "rent_method", "rent_level", "rent_surface_m2"} <= set(angers["yield_fields"])
    # every published value says how many sales it rests on and how reliable it is
    assert {"n_sales", "reliability"} <= set(angers["yield_fields"])
    assert {"median_land_m2", "share_with_outbuilding"} <= set(angers["price_fields"])


def test_latest_points_at_last_complete_year(serve):
    latest = _place(serve, "commune", "49007")["latest"]
    assert latest["apartment"]["all"] == {"year": "2025", "half": "2026-H1", "basis": "exact"}


def test_typical_deal_matches_deals_module(serve):
    typical = _place(serve, "commune", "49007")["typical_deal"]["apartment"]["all"]
    expected = deals.typical_deal(155000, 50, 14.6, "apartment", 0.5665)
    assert typical["cash_flow_monthly"] == pytest.approx(expected["cash_flow_monthly"], abs=0.01)
    assert typical["period"] == "2025" and typical["basis"] == "exact"
    # no typical deal for flats + houses together
    assert "all" not in _place(serve, "commune", "49007")["typical_deal"]


def test_excluded_yield_is_published_with_its_reason(serve):
    beaucouze = _place(serve, "commune", "49020")
    row = dict(zip(beaucouze["yield_fields"], beaucouze["yields"][0]))
    assert row["status"] == "excluded" and row["reason"] == "yield_above_ceiling" and row["gross_yield"] is None
    assert "typical_deal" not in beaucouze or "all" not in beaucouze["typical_deal"].get("apartment", {})


def test_energy_by_type_and_bands_every_year(serve):
    angers = _place(serve, "commune", "49007")
    assert angers["energy"]["house"]["share_fg"] == 0.18 and angers["energy"]["all"]["n_dpe"] == 1000
    assert set(angers["price_bands"]) == {"2024", "2025"}


def test_stock_oll_and_meta(serve):
    angers = _place(serve, "commune", "49007")
    assert angers["stock"]["share_houses"] == 0.22
    # an agglomeration's rents are written once, communes point to them
    assert angers["oll"] == {"agglo_code": "L4900", "agglomeration": "Agglomération d'Angers"}
    oll = json.loads((serve / "oll" / "L4900.json").read_text(encoding="utf-8"))
    assert {dict(zip(oll["fields"], r))["year"] for r in oll["rows"]} == {2024, 2025}
    # sources are the same for every place: one file
    assert "meta" not in angers
    meta = json.loads((serve / "meta.json").read_text(encoding="utf-8"))
    assert meta["prices"]["source"].startswith("DVF")


def test_neighbours_nearest_first_without_itself(serve):
    neighbours = _place(serve, "commune", "49007")["neighbours"]
    assert [n[0] for n in neighbours] == ["49015", "49020"]
    assert neighbours[0][1] == "Avrillé" and 3 < neighbours[0][2] < 6


def test_index_and_small_places(serve):
    # Paris commune has n=9 < 10: not published; the others are
    assert not (serve / "geo" / "commune" / "75056.json").exists()
    index = json.loads((serve / "index.json").read_text(encoding="utf-8"))
    assert [place[2] for place in index["places"]][:1] == ["Angers"]
    assert json.loads((serve / "geo" / "france" / "FR.json").read_text())["name"] == "France"


def test_regions_and_departements_are_named(serve):
    assert _place(serve, "region", "52")["name"] == "Pays de la Loire"
    assert _place(serve, "departement", "49")["region"] == "52"


def test_ranking_per_segment(serve):
    catalogue = json.loads((serve / "ranking.json").read_text(encoding="utf-8"))
    assert catalogue["period"] == "2025"
    assert "apartment_all" in catalogue["segments"] and not any(s.startswith("all_") for s in catalogue["segments"])
    flats = json.loads((serve / "ranking" / "apartment_all.json").read_text(encoding="utf-8"))
    rows = {r[flats["fields"].index("code")]: dict(zip(flats["fields"], r)) for r in flats["rows"]}
    # Beaucouzé's yield is excluded: not ranked; Angers has its typical cash-flow and score
    assert set(rows) == {"49007", "49015"}
    assert rows["49007"]["score"] == 71.5 and rows["49007"]["cash_flow_monthly"] is not None
    assert rows["49007"]["rent_control"] is False
    # T5+ in Angers has 15 sales < 30: no ranking file row
    five = json.loads((serve / "ranking" / "apartment_5p.json").read_text(encoding="utf-8"))
    assert five["rows"] == []


def test_publish_replaces_previous_serve_layer(tmp_path: Path):
    serve = tmp_path / "serve"
    (serve / "geo" / "commune").mkdir(parents=True)
    (serve / "geo" / "commune" / "99999.json").write_text("{}")
    publish.publish(_con(), min_sales=10, run_id="r2", serve_dir=serve)
    assert not (serve / "geo" / "commune" / "99999.json").exists()
