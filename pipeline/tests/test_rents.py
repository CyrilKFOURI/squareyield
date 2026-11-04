"""Rent loading, surface-adjusted rents and gross-yield rules (docs/KPI_SPEC.md M8–M10,
docs/research/segmentation_study.md §5)."""
import json
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import rents

HEADER = '"id_zone";"INSEE_C";"LIBGEO";"EPCI";"DEP";"REG";"loypredm2";"lwr.IPm2";"upr.IPm2";"TYPPRED";"nbobs_com";"nbobs_mail";"R2_adj"'

COMMUNES = [
    {"code": "49007", "type": "commune-actuelle", "nom": "Angers", "departement": "49", "region": "52"},
    {"code": "49050", "type": "commune-actuelle", "nom": "Odd", "departement": "49", "region": "52"},
    {"code": "49099", "type": "commune-actuelle", "nom": "NoRent", "departement": "49", "region": "52"},
    {"code": "75056", "type": "commune-actuelle", "nom": "Paris", "departement": "75", "region": "11"},
    {"code": "75101", "type": "arrondissement-municipal", "commune": "75056", "nom": "Paris 1", "departement": "75", "region": "11"},
    {"code": "75120", "type": "arrondissement-municipal", "commune": "75056", "nom": "Paris 20", "departement": "75", "region": "11"},
]

# code -> rent €/m² per ANIL file (T1-T2 37 m², all flats 52 m², T3+ 72 m², houses 92 m²)
RENTS = {
    "49007": {"pred-app12-mef-dhup": "18,0", "pred-app-mef-dhup": "15,0", "pred-app3-mef-dhup": "13,0", "pred-mai-mef-dhup": "11,0"},
    # rent per m² rising with surface: not a market pattern, slope clamped to 0
    "49050": {"pred-app12-mef-dhup": "10,0", "pred-app-mef-dhup": "12,0", "pred-app3-mef-dhup": "14,0", "pred-mai-mef-dhup": "9,0"},
    "75101": {"pred-app12-mef-dhup": "44,0", "pred-app-mef-dhup": "40,0", "pred-app3-mef-dhup": "36,0", "pred-mai-mef-dhup": "30,0"},
    "75120": {"pred-app12-mef-dhup": "33,0", "pred-app-mef-dhup": "30,0", "pred-app3-mef-dhup": "27,0", "pred-mai-mef-dhup": "25,0"},
}

# (geo_level, code, year, property_type, rooms_bucket, n_sales, median €/m², median surface)
PRICES = [
    ("commune", "49007", 2025, "apartment", "all", 1500, 3000, 52),
    ("commune", "49007", 2024, "apartment", "all", 1500, 3000, 52),
    ("commune", "49007", 2025, "apartment", "1", 200, 3500, 28),
    ("commune", "49007", 2025, "apartment", "4", 100, 2600, 85),
    ("commune", "49007", 2025, "house", "4", 80, 2200, 95),
    ("commune", "49007", 2025, "all", "all", 1800, 2800, 60),
    ("commune", "49050", 2025, "apartment", "all", 50, 2000, 52),
    ("commune", "49099", 2025, "apartment", "all", 40, 1500, 52),
    ("commune", "75056", 2025, "apartment", "all", 14000, 9600, 45),
    ("arrondissement", "75120", 2025, "apartment", "all", 2000, 9000, 45),
    ("departement", "49", 2025, "apartment", "all", 3000, 2900, 52),
]

# rental main homes (INSEE main homes − owner homes)
RENTAL_HOMES = [
    ("commune", "49007", 30000), ("commune", "49050", 500), ("commune", "49099", 1000),
    ("arrondissement", "75101", 10000), ("arrondissement", "75120", 30000),
    ("commune", "75056", 40000), ("departement", "49", 31500),
]


def _write_rent_files(directory: Path) -> None:
    directory.mkdir(parents=True)
    for stem in rents.SEGMENTS:
        lines = [HEADER]
        for code, by_file in RENTS.items():
            # LIBGEO with "œ": files are Windows-1252, not latin-1
            lines.append(f'"1";"{code}";"Bœuf é";"1";"{code[:2]}";"52";{by_file[stem]};10,0;20,0;"commune";3000;3000;0,8')
        (directory / f"{stem}.csv").write_bytes("\r\n".join(lines).encode("cp1252"))


@pytest.fixture
def con(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    communes = tmp_path / "communes.json"
    communes.write_text(json.dumps(COMMUNES))
    _write_rent_files(tmp_path / "2025")
    connection = duckdb.connect()
    connection.execute(
        f"""CREATE TABLE commune_map AS
            SELECT code,
                   CASE WHEN type = 'arrondissement-municipal' THEN commune ELSE code END AS code_commune,
                   CASE WHEN type = 'arrondissement-municipal' THEN code END AS code_arrondissement,
                   nom, departement, region
            FROM read_json_auto('{communes.as_posix()}')"""
    )
    connection.execute(
        """CREATE TABLE kpi_price (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR,
               period VARCHAR, year INTEGER, condition VARCHAR, property_type VARCHAR, rooms_bucket VARCHAR,
               n_sales INTEGER, median_price_m2 DOUBLE, median_surface_m2 DOUBLE, run_id VARCHAR)"""
    )
    for level, code, year, ptype, bucket, n, price, surface in PRICES:
        connection.execute(
            "INSERT INTO kpi_price VALUES (?, ?, 'year', ?, ?, 'existing', ?, ?, ?, ?, ?, 't')",
            [level, code, str(year), year, ptype, bucket, n, price, surface],
        )
    connection.execute("CREATE TABLE kpi_socio (geo_level VARCHAR, geo_code VARCHAR, rental_homes DOUBLE)")
    connection.executemany("INSERT INTO kpi_socio VALUES (?, ?, ?)", RENTAL_HOMES)
    rents.load_rents(connection, tmp_path / "2025", 2025)
    rents.build_yield_kpis(connection)
    return connection


def _yield(con, level, code, property_type="apartment", bucket="all", period="2025"):
    row = con.execute(
        """SELECT rent_m2, gross_yield, price_to_rent_years, rent_surface_m2, rent_method, status,
                  reason, rent_coverage, rent_level
           FROM kpi_yield WHERE geo_level = ? AND geo_code = ? AND period = ?
             AND property_type = ? AND rooms_bucket = ?""",
        [level, code, period, property_type, bucket],
    ).fetchone()
    keys = ("rent", "gross", "years", "surface", "method", "status", "reason", "coverage", "level")
    return None if row is None else dict(zip(keys, row))


def _slope(con, code, property_type="apartment"):
    return con.execute(
        "SELECT slope FROM rent_child WHERE code = ? AND property_type = ?", [code, property_type]
    ).fetchone()[0]


def test_rent_at_matches_reference_points(con):
    slope = _slope(con, "49007")
    assert slope < 0
    assert rents.rent_at(15, 52, slope, 52) == pytest.approx(15)


def test_rent_clamped_outside_surface_bounds():
    assert rents.rent_at(15, 52, -0.3, 18) == rents.rent_at(15, 52, -0.3, 25)
    assert rents.rent_at(15, 52, -0.3, 200) == rents.rent_at(15, 52, -0.3, 110)


def test_positive_slope_clamped(con):
    assert _slope(con, "49050") == 0


def test_gross_yield_and_price_to_rent(con):
    y = _yield(con, "commune", "49007")
    assert y["rent"] == pytest.approx(15.0)
    assert y["gross"] == pytest.approx(12 * 15 / 3000)
    assert y["years"] == pytest.approx(3000 / (12 * 15))
    assert y["status"] == "ok" and y["level"] == "commune"


def test_yield_uses_cell_surface(con):
    small = _yield(con, "commune", "49007", bucket="1")
    assert small["rent"] > 18 and small["surface"] == 28 and small["method"] == "surface_adjusted"
    assert _yield(con, "commune", "49007", bucket="4")["rent"] < 13


def test_house_yield_per_size(con):
    house = _yield(con, "commune", "49007", property_type="house", bucket="4")
    assert house["method"] == "house_approx"
    assert house["rent"] == pytest.approx(rents.rent_at(11, 92, _slope(con, "49007"), 95))
    assert _yield(con, "commune", "49007", property_type="all") is None


def test_paris_rent_weighted_by_rental_homes_of_arrondissements(con):
    expected = (10000 * rents.rent_at(40, 52, _slope(con, "75101"), 45)
                + 30000 * rents.rent_at(30, 52, _slope(con, "75120"), 45)) / 40000
    assert _yield(con, "commune", "75056")["rent"] == pytest.approx(expected)


def test_arrondissement_keeps_its_own_rent(con):
    expected = rents.rent_at(30, 52, _slope(con, "75120"), 45)
    assert _yield(con, "arrondissement", "75120")["rent"] == pytest.approx(expected)


def test_departement_rent_weighted_and_coverage_below_one(con):
    d = _yield(con, "departement", "49")
    expected = (30000 * 15 + 500 * 12) / 30500
    assert d["rent"] == pytest.approx(expected)
    assert d["coverage"] == pytest.approx(30500 / 31500)
    assert d["level"] == "aggregate"


def test_zero_rental_homes_never_gives_nan(con):
    con.execute("UPDATE kpi_socio SET rental_homes = 0 WHERE geo_code = '49007'")
    rents.build_yield_kpis(con)
    rent = _yield(con, "commune", "49007")["rent"]
    assert rent == pytest.approx(15.0)


def test_missing_anil_commune_has_no_yield(con):
    assert _yield(con, "commune", "49099") is None


def test_rent_edition_never_paired_with_older_prices(con):
    assert _yield(con, "commune", "49007", period="2024") is None


def test_excluded_yield_kept_with_reason(con):
    con.execute("UPDATE kpi_price SET median_price_m2 = 142 WHERE geo_code = '49007' AND rooms_bucket = 'all'")
    rents.build_yield_kpis(con)
    y = _yield(con, "commune", "49007")
    assert y["status"] == "excluded" and y["gross"] is None and y["years"] is None and y["reason"]


def test_implausible_yield_excluded(con):
    # 15 €/m² rent on a 500 €/m² price = 36 % gross yield: not a market
    con.execute("UPDATE kpi_price SET median_price_m2 = 500 WHERE geo_code = '49007' AND rooms_bucket = 'all'")
    rents.build_yield_kpis(con)
    assert _yield(con, "commune", "49007")["status"] == "excluded"


def test_rent_at_shared_fixture():
    # the app's rentAt (apps/app/src/data/rent.ts) is tested against the same file
    fixture = json.loads((Path(__file__).parent / "fixtures" / "rent_at_cases.json").read_text())
    assert tuple(fixture["surface_bounds"]) == rents.SURFACE_BOUNDS
    for case in fixture["cases"]:
        got = rents.rent_at(case["ref_rent_m2"], case["ref_surface"], case["slope"], case["surface_m2"])
        assert got == pytest.approx(case["rent_m2"], abs=1e-6)
