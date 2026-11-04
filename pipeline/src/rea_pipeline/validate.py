"""Validation gates (docs/PIPELINE_RUN_SPEC.md §5). Each check returns (name, ok, detail)."""
from pathlib import Path

import duckdb

# Sanity bands for apartment median €/m² at commune level, from public figures
# (explore.data.gouv.fr / notaires). Generous on purpose: they catch pipeline bugs
# (double counting, wrong units), not market moves. Refine once compared side by side.
REFERENCE_BANDS = {
    ("75056", 2024): (8_500, 11_500),  # Paris
    ("69123", 2024): (4_000, 5_800),  # Lyon
    ("13055", 2024): (3_000, 4_500),  # Marseille
}
MAX_NATIONAL_DRIFT = 0.10

Check = tuple[str, bool, str]


def check_reference_bands(con: duckdb.DuckDBPyConnection) -> list[Check]:
    checks = []
    for (code, year), (low, high) in REFERENCE_BANDS.items():
        row = con.execute(
            """SELECT median_price_m2, n_sales FROM kpi_price
               WHERE geo_level = 'commune' AND geo_code = ? AND period_type = 'year'
                 AND period = CAST(? AS VARCHAR) AND property_type = 'apartment' AND rooms_bucket = 'all'
                 AND condition = 'existing'""",
            [code, year],
        ).fetchone()
        if row is None:
            checks.append((f"band {code} {year}", False, "missing"))
            continue
        median, n = row
        checks.append(
            (f"band {code} {year}", low <= median <= high, f"median={median:.0f} n={n} band=[{low},{high}]")
        )
    return checks


def check_national_drift(con: duckdb.DuckDBPyConnection, previous_marts: Path | None) -> list[Check]:
    if previous_marts is None or not previous_marts.exists():
        return [("national drift", True, "no previous run to compare")]
    columns = {row[0] for row in con.execute(
        f"DESCRIBE SELECT * FROM '{previous_marts.as_posix()}'").fetchall()}
    if "period_type" not in columns:
        return [("national drift", True, "previous run has the old schema, not comparable")]
    query = """SELECT median(median_price_m2) FROM {src}
               WHERE geo_level = 'departement' AND period_type = 'year' AND NOT is_partial
                 AND property_type = 'all' AND rooms_bucket = 'all'"""
    current = con.execute(query.format(src="kpi_price")).fetchone()[0]
    previous = con.execute(query.format(src=f"'{previous_marts.as_posix()}'")).fetchone()[0]
    drift = abs(current / previous - 1)
    return [("national drift", drift <= MAX_NATIONAL_DRIFT, f"drift={drift:.1%}")]


def check_clean(con: duckdb.DuckDBPyConnection) -> list[Check]:
    duplicates = con.execute(
        "SELECT count(*) - count(DISTINCT id_mutation) FROM dvf_sales"
    ).fetchone()[0]
    null_communes = con.execute(
        "SELECT count(*) FROM dvf_sales WHERE code_commune IS NULL"
    ).fetchone()[0]
    return [
        ("one row per mutation", duplicates == 0, f"duplicates={duplicates}"),
        ("no null commune", null_communes == 0, f"nulls={null_communes}"),
    ]


def check_bucket_sums(con: duckdb.DuckDBPyConnection) -> list[Check]:
    """V8: for flats and houses, the size cells of a place and period add up to "all sizes"
    (unknown sizes are left out of both), so a page never shows parts that exceed the whole."""
    mismatches = con.execute(
        """SELECT count(*) FROM (
               SELECT geo_level, geo_code, period, property_type,
                      sum(n_sales) FILTER (WHERE rooms_bucket <> 'all') AS parts,
                      max(n_sales) FILTER (WHERE rooms_bucket = 'all') AS whole
               FROM kpi_price WHERE condition = 'existing' AND property_type IN ('apartment', 'house')
               GROUP BY ALL)
           WHERE parts IS DISTINCT FROM whole"""
    ).fetchone()[0]
    return [("size cells add up to all sizes", mismatches == 0, f"{mismatches} mismatching cells")]


# Gross yield bands (12 × asking rent / median price) for apartments, latest full year.
# Paris is known for ~3–4.5 %, the national figure for ~5–7 %.
YIELD_BANDS = {
    ("commune", "75056"): (0.025, 0.05),
    ("france", "FR"): (0.04, 0.09),
}
MIN_RENT_COVERAGE = 0.95
MAX_PLAUSIBLE_YIELD = 0.30  # same value as rents.MAX_PLAUSIBLE_YIELD
MAX_DROPPED_YIELD_SHARE = 0.005


def check_yields(con: duckdb.DuckDBPyConnection) -> list[Check]:
    latest = con.execute(
        "SELECT max(period) FROM kpi_yield WHERE period_type = 'year' AND period IN "
        "(SELECT period FROM kpi_price WHERE period_type = 'year' AND NOT is_partial)"
    ).fetchone()[0]
    if latest is None:
        return [("yield period", False, "no complete year matches the rent edition")]
    checks = []
    for (level, code), (low, high) in YIELD_BANDS.items():
        row = con.execute(
            """SELECT gross_yield FROM kpi_yield WHERE geo_level = ? AND geo_code = ?
               AND period = ? AND property_type = 'apartment' AND rooms_bucket = 'all'""",
            [level, code, latest],
        ).fetchone()
        ok = row is not None and row[0] is not None and low <= row[0] <= high
        detail = "missing" if row is None else f"yield={row[0]:.2%} band=[{low:.1%},{high:.1%}]"
        checks.append((f"yield {code} {latest}", ok, detail))
    # share of published commune price cells (flats and houses, every size) that found a rent
    coverage = con.execute(
        f"""SELECT count(y.geo_code)::DOUBLE / count(*) FROM kpi_price p
            LEFT JOIN kpi_yield y USING (geo_level, geo_code, period, property_type, rooms_bucket)
            WHERE p.geo_level = 'commune' AND p.period = '{latest}' AND p.n_sales >= 10
              AND p.condition = 'existing' AND p.property_type IN ('apartment', 'house')"""
    ).fetchone()[0]
    checks.append(("rent coverage", coverage >= MIN_RENT_COVERAGE, f"{coverage:.1%} of commune cells"))
    # implausible yields are published as excluded; they must stay a rare exception
    excluded = con.execute(
        "SELECT avg((status = 'excluded')::INTEGER) FROM kpi_yield WHERE n_sales >= 10"
    ).fetchone()[0]
    checks.append(("implausible yields excluded", excluded <= MAX_DROPPED_YIELD_SHARE,
                   f"{excluded:.3%} of cells (limit {MAX_DROPPED_YIELD_SHARE:.1%})"))
    # a yield is only ever paired with a price cell of the same key, never on flats + houses
    orphans = con.execute(
        """SELECT count(*) FROM kpi_yield y
           LEFT JOIN kpi_price p ON p.geo_level = y.geo_level AND p.geo_code = y.geo_code
            AND p.period = y.period AND p.property_type = y.property_type
            AND p.rooms_bucket = y.rooms_bucket AND p.condition = 'existing'
           WHERE p.geo_code IS NULL OR y.property_type = 'all'"""
    ).fetchone()[0]
    checks.append(("yields paired with their own cell", orphans == 0, f"{orphans} unpaired"))
    return checks


# Census 2023 orders of magnitude: Paris ~2.1 M inhabitants, France ~68 M, vacancy ~8 %.
SOCIO_BANDS = {
    ("commune", "75056", "population"): (1.9e6, 2.3e6),
    ("france", "FR", "population"): (65e6, 71e6),
    ("france", "FR", "vacancy_rate"): (0.06, 0.11),
}
MIN_SOCIO_COVERAGE = 0.99


def check_socio(con: duckdb.DuckDBPyConnection) -> list[Check]:
    checks = []
    for (level, code, column), (low, high) in SOCIO_BANDS.items():
        row = con.execute(
            f"SELECT {column} FROM kpi_socio WHERE geo_level = ? AND geo_code = ?", [level, code]
        ).fetchone()
        ok = row is not None and row[0] is not None and low <= row[0] <= high
        checks.append((f"{column} {code}", ok, "missing" if row is None else f"{row[0]:,.3f}"))
    # every commune with published prices must have INSEE context
    coverage = con.execute(
        """SELECT count(s.geo_code)::DOUBLE / count(*) FROM
               (SELECT DISTINCT geo_code FROM kpi_price WHERE geo_level = 'commune' AND n_sales >= 10) p
           LEFT JOIN kpi_socio s ON s.geo_level = 'commune' AND s.geo_code = p.geo_code"""
    ).fetchone()[0]
    checks.append(("socio coverage", coverage >= MIN_SOCIO_COVERAGE, f"{coverage:.1%} of priced communes"))
    return checks


# Published 2025 rates: Paris ~20.9 % (low), Angers ~56.7 % (high).
TAX_BANDS = {"75056": (0.18, 0.25), "49007": (0.50, 0.62)}
MIN_TAX_COVERAGE = 0.99


def check_local_tax(con: duckdb.DuckDBPyConnection) -> list[Check]:
    checks = []
    for code, (low, high) in TAX_BANDS.items():
        row = con.execute(
            "SELECT tfpb_rate FROM kpi_local_tax WHERE geo_level = 'commune' AND geo_code = ?", [code]
        ).fetchone()
        ok = row is not None and low <= row[0] <= high
        checks.append((f"tfpb rate {code}", ok, "missing" if row is None else f"{row[0]:.1%}"))
    coverage = con.execute(
        """SELECT count(t.geo_code)::DOUBLE / count(*) FROM
               (SELECT DISTINCT geo_code FROM kpi_price WHERE geo_level = 'commune' AND n_sales >= 10) p
           LEFT JOIN kpi_local_tax t ON t.geo_level = 'commune' AND t.geo_code = p.geo_code"""
    ).fetchone()[0]
    checks.append(("tax coverage", coverage >= MIN_TAX_COVERAGE, f"{coverage:.1%} of priced communes"))
    return checks


MIN_DPE_COVERAGE = 0.95


def check_dpe(con: duckdb.DuckDBPyConnection) -> list[Check]:
    france, paris = (con.execute(
        "SELECT share_fg FROM kpi_dpe WHERE geo_level = ? AND geo_code = ? AND property_type = 'all'", [level, code]
    ).fetchone() for level, code in (("france", "FR"), ("commune", "75056")))
    paris_flats = con.execute(
        "SELECT share_fg FROM kpi_dpe WHERE geo_level = 'commune' AND geo_code = '75056' AND property_type = 'apartment'"
    ).fetchone()
    coverage = con.execute(
        """SELECT count(d.geo_code)::DOUBLE / count(*) FROM
               (SELECT DISTINCT geo_code FROM kpi_price WHERE geo_level = 'commune' AND n_sales >= 10) p
           LEFT JOIN kpi_dpe d ON d.geo_level = 'commune' AND d.geo_code = p.geo_code
                AND d.property_type = 'all'"""
    ).fetchone()[0]
    return [
        ("share F/G France", france is not None and 0.05 <= france[0] <= 0.25,
         "missing" if france is None else f"{france[0]:.1%}"),
        # Paris has many small old flats: more F/G than the national average
        ("share F/G Paris > France", france is not None and paris is not None and paris[0] > france[0],
         "missing" if paris is None else f"{paris[0]:.1%}"),
        ("dpe coverage", coverage >= MIN_DPE_COVERAGE, f"{coverage:.1%} of priced communes"),
        ("flats DPE split present (Paris)", paris_flats is not None,
         "missing" if paris_flats is None else f"{paris_flats[0]:.1%}"),
    ]


MIN_SCORE_COVERAGE = 0.95


def check_scores(con: duckdb.DuckDBPyConnection) -> list[Check]:
    low, median, high = con.execute(
        "SELECT min(score), median(score), max(score) FROM kpi_score"
    ).fetchone()
    coverage = con.execute(
        """SELECT count(s.geo_code)::DOUBLE / count(*) FROM
               (SELECT geo_level, geo_code, property_type FROM kpi_yield
                WHERE geo_level = 'commune' AND rooms_bucket = 'all' AND n_sales >= 30
                  AND period = (SELECT max(period) FROM kpi_price WHERE period_type = 'year' AND NOT is_partial)) y
           LEFT JOIN kpi_score s USING (geo_level, geo_code, property_type)"""
    ).fetchone()[0]
    return [
        ("score bounds", low is not None and low >= 0 and high <= 100, f"[{low}, {high}]"),
        # percentile ranks: the median place scores around 50
        ("score median", median is not None and 35 <= median <= 65, f"{median}"),
        ("score coverage", coverage >= MIN_SCORE_COVERAGE, f"{coverage:.1%} of ranked communes"),
    ]
