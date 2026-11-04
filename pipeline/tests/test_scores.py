"""Market score (M17) and rent-to-income (M13)."""
import duckdb
import pytest

from rea_pipeline import scores

# commune -> (yield, cagr, pop growth, jobs growth, vacancy, share F/G, sales, living standard, T2 rent/m²)
COMMUNES = {
    "GOOD": (0.08, 0.03, 0.010, 0.020, 0.05, 0.03, 300, 24_000, 12.0),
    "MID": (0.06, 0.01, 0.002, 0.005, 0.08, 0.08, 100, 22_000, 13.0),
    "BAD": (0.04, -0.02, -0.010, -0.010, 0.15, 0.20, 40, 20_000, 14.0),
    "TINY": (0.20, 0.10, 0.050, 0.050, 0.01, 0.00, 12, 20_000, 10.0),  # too few sales: not scored
}


@pytest.fixture
def con() -> duckdb.DuckDBPyConnection:
    c = duckdb.connect()
    c.execute("""CREATE TABLE kpi_price (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR, period VARCHAR,
                 is_partial BOOLEAN, condition VARCHAR, property_type VARCHAR, rooms_bucket VARCHAR, n_sales INTEGER,
                 cagr DOUBLE)""")
    c.execute("""CREATE TABLE kpi_yield (geo_level VARCHAR, geo_code VARCHAR, period_type VARCHAR, period VARCHAR,
                 property_type VARCHAR, rooms_bucket VARCHAR, gross_yield DOUBLE, rent_m2 DOUBLE)""")
    c.execute("""CREATE TABLE kpi_socio (geo_level VARCHAR, geo_code VARCHAR, population_growth_yearly DOUBLE,
                 jobs_growth_yearly DOUBLE, vacancy_rate DOUBLE, median_living_standard DOUBLE)""")
    c.execute("CREATE TABLE kpi_dpe (geo_level VARCHAR, geo_code VARCHAR, property_type VARCHAR, share_fg DOUBLE)")
    # flat curve (slope 0): rent at any surface = the reference rent
    c.execute("""CREATE TABLE rent_area (geo_level VARCHAR, geo_code VARCHAR, property_type VARCHAR,
                 ref_rent_m2 DOUBLE, ref_surface DOUBLE, slope DOUBLE, w DOUBLE)""")
    for code, (yld, cagr, pop, jobs, vac, fg, n, income, rent) in COMMUNES.items():
        c.execute("INSERT INTO kpi_price VALUES ('commune', ?, 'year', '2025', false, 'existing', 'apartment', 'all', ?, ?)",
                  [code, n, cagr])
        c.execute("INSERT INTO kpi_yield VALUES ('commune', ?, 'year', '2025', 'apartment', 'all', ?, ?)",
                  [code, yld, rent])
        c.execute("INSERT INTO kpi_yield VALUES ('commune', ?, 'year', '2025', 'apartment', '2', ?, ?)",
                  [code, yld, rent])
        c.execute("INSERT INTO kpi_socio VALUES ('commune', ?, ?, ?, ?, ?)", [code, pop, jobs, vac, income])
        c.execute("INSERT INTO kpi_dpe VALUES ('commune', ?, 'apartment', ?)", [code, fg])
        c.execute("INSERT INTO rent_area VALUES ('commune', ?, 'apartment', ?, 52, 0, 1)", [code, rent])
    # houses in GOOD and MID: their own DPE (GOOD's houses are worse than MID's) and rent
    for code, fg, rent in (("GOOD", 0.30, 9.0), ("MID", 0.05, 10.0)):
        c.execute("INSERT INTO kpi_price VALUES ('commune', ?, 'year', '2025', false, 'existing', 'house', 'all', 100, 0.01)",
                  [code])
        c.execute("INSERT INTO kpi_yield VALUES ('commune', ?, 'year', '2025', 'house', 'all', 0.06, ?)", [code, rent])
        c.execute("INSERT INTO kpi_dpe VALUES ('commune', ?, 'house', ?)", [code, fg])
        c.execute("INSERT INTO rent_area VALUES ('commune', ?, 'house', ?, 92, 0, 1)", [code, rent])
    scores.build_scores(c)
    return c


def _score(con, code):
    return con.execute(
        "SELECT score, n_criteria, strengths, weaknesses, rent_to_income FROM kpi_score "
        "WHERE geo_code = ? AND property_type = 'apartment'", [code]
    ).fetchone()


def test_order_and_bounds(con):
    assert _score(con, "GOOD")[0] == 100 and _score(con, "BAD")[0] == 0
    assert 0 < _score(con, "MID")[0] < 100
    assert _score(con, "TINY") is None


def test_explanations_and_affordability(con):
    score, n, strengths, weaknesses, rent_to_income = _score(con, "MID")
    assert n == 7 and len(strengths) == 2 and len(weaknesses) == 2
    assert rent_to_income == pytest.approx(12 * 13.0 * 45 / 22_000)


def test_house_score_uses_house_dpe(con):
    strengths, weaknesses = con.execute(
        "SELECT strengths, weaknesses FROM kpi_score WHERE geo_code = 'GOOD' AND property_type = 'house'"
    ).fetchone()
    # GOOD's flats are the best on F/G but its houses are the worst
    assert "share_fg" not in strengths


def test_rent_to_income_per_type(con):
    house = con.execute(
        "SELECT rent_to_income FROM kpi_score WHERE geo_code = 'MID' AND property_type = 'house'"
    ).fetchone()[0]
    assert house == pytest.approx(12 * 10.0 * 90 / 22_000)


def _score_apartment(con, code):
    return con.execute(
        "SELECT score, n_criteria FROM kpi_score WHERE geo_code = ? AND property_type = 'apartment'", [code]
    ).fetchone()


def test_missing_criterion_reweights(con):
    con.execute("UPDATE kpi_dpe SET share_fg = NULL WHERE geo_code = 'GOOD'")
    scores.build_scores(con)
    score, n = _score_apartment(con, "GOOD")
    assert n == 6 and score == 100
