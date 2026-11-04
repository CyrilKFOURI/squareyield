"""S3: market price KPIs M1–M7 (docs/KPI_SPEC.md §1) per geo × period × segment, and the
distribution of sales by price band.

Periods: calendar years ('2025') and half-years ('2026-H1'). DVF releases cover a rolling
window that starts and ends on half-years (e.g. 2021-H2 → 2026-H1), so a year present for
only one half is flagged is_partial and gets no year-on-year change.
"""
from pathlib import Path

import duckdb

MIN_PUBLISHED_SALES = 10
# One meaning of "reliable" everywhere (segmentation study §4.3): published from 10 sales,
# flagged "low" under 30, used in rankings, scores and map colours from 30.
RELIABLE_SALES = 30
TRIM_LOW, TRIM_HIGH = 0.01, 0.99

# geo_level -> column of dvf_sales holding the geo_code
GEO_LEVELS = {
    "commune": "code_commune",
    "arrondissement": "code_arrondissement",
    "departement": "code_departement",
    "region": "code_region",
    "france": "'FR'",
}


def rooms_bucket_sql(property_type: str, rooms: str) -> str:
    """Size bucket: flats T1…T4, 5+; houses are larger, so ≤3 rooms, 4, 5, 6+."""
    return f"""CASE WHEN {rooms} IS NULL OR {rooms} < 1 THEN 'unknown'
                    WHEN {property_type} = 'house' THEN
                         CASE WHEN {rooms} <= 3 THEN '1-3' WHEN {rooms} >= 6 THEN '6+'
                              ELSE CAST({rooms} AS VARCHAR) END
                    WHEN {rooms} >= 5 THEN '5+' ELSE CAST({rooms} AS VARCHAR) END"""


def _market_sales() -> str:
    """Sales that enter market cells, outliers removed.

    Existing homes: P1–P99 of €/m² per département × type × size × year, so a thin commune
    cell is trimmed with stable bounds of its own size class; unknown sizes are left out so
    that size cells add up to "all sizes". New builds (VEFA) are trimmed per département ×
    type × year and only published for all sizes (their rooms are often missing).
    """
    return f"""
        WITH base AS (
            SELECT *, {rooms_bucket_sql("property_type", "rooms")} AS rooms_bucket,
                   CASE WHEN is_new_build THEN 'new' ELSE 'existing' END AS condition
            FROM dvf_sales WHERE market_excluded IS NULL
        ),
        eligible AS (
            SELECT *, CASE WHEN condition = 'new' THEN 'all' ELSE rooms_bucket END AS trim_bucket
            FROM base WHERE condition = 'new' OR rooms_bucket <> 'unknown'
        ),
        bounds AS (
            SELECT code_departement, property_type, condition, trim_bucket, year,
                   quantile_cont(price_m2, {TRIM_LOW}) AS lo, quantile_cont(price_m2, {TRIM_HIGH}) AS hi
            FROM eligible GROUP BY ALL
        )
        SELECT e.* FROM eligible e
        JOIN bounds b USING (code_departement, property_type, condition, trim_bucket, year)
        WHERE e.price_m2 BETWEEN b.lo AND b.hi"""


def build_price_kpis(con: duckdb.DuckDBPyConnection, run_id: str) -> None:
    """Create table kpi_price for every geo level, period and comparable cell
    (type × size × condition)."""
    by_level = " UNION ALL ".join(
        f"SELECT '{level}' AS geo_level, {column} AS geo_code, * FROM market WHERE {column} IS NOT NULL"
        for level, column in GEO_LEVELS.items()
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_price AS
        WITH market AS ({_market_sales()}),
        coverage AS (
            -- a year is complete only if the release contains both of its halves
            SELECT year, count(DISTINCT half) = 2 AS is_complete FROM dvf_sales WHERE NOT is_new_build GROUP BY year
        ),
        geo AS ({by_level}),
        periods AS (
            SELECT *, 'year' AS period_type, CAST(year AS VARCHAR) AS period FROM geo
            UNION ALL
            SELECT *, 'half', year || '-H' || half FROM geo
        ),
        segmented AS (
            SELECT geo_level, geo_code, period_type, period, year, half, condition, property_type,
                   rooms_bucket, price_m2, price, surface_m2, land_m2, n_dependencies
            FROM periods WHERE condition = 'existing'
            UNION ALL
            SELECT geo_level, geo_code, period_type, period, year, half, condition, property_type,
                   'all', price_m2, price, surface_m2, land_m2, n_dependencies FROM periods
            UNION ALL
            -- flats and houses together: market context only, never compared (study §1)
            SELECT geo_level, geo_code, period_type, period, year, half, condition, 'all',
                   'all', price_m2, price, surface_m2, land_m2, n_dependencies FROM periods
            WHERE condition = 'existing'
        ),
        agg AS (
            SELECT geo_level, geo_code, period_type, period, year,
                   CASE WHEN period_type = 'half' THEN any_value(half) END AS half,
                   condition, property_type, rooms_bucket,
                   count(*) AS n_sales,
                   median(price_m2) AS median_price_m2,
                   quantile_cont(price_m2, 0.25) AS p25_price_m2,
                   quantile_cont(price_m2, 0.75) AS p75_price_m2,
                   median(price) AS median_price,
                   median(surface_m2) AS median_surface_m2,
                   -- what a house price includes: land, and for any cell a cellar / parking
                   CASE WHEN property_type = 'house' THEN median(land_m2) END AS median_land_m2,
                   avg((n_dependencies > 0)::INTEGER) AS share_with_outbuilding
            FROM segmented GROUP BY geo_level, geo_code, period_type, period, year,
                                    condition, property_type, rooms_bucket
        ),
        flagged AS (
            SELECT a.*, period_type = 'year' AND NOT c.is_complete AS is_partial
            FROM agg a JOIN coverage c USING (year)
        ),
        with_prev AS (
            -- compare with the same period one year earlier (2026-H1 vs 2025-H1)
            SELECT cur.*, prev.median_price_m2 AS prev_median, prev.is_partial AS prev_partial
            FROM flagged cur
            LEFT JOIN flagged prev
              ON prev.geo_level = cur.geo_level AND prev.geo_code = cur.geo_code
             AND prev.period_type = cur.period_type AND prev.condition = cur.condition
             AND prev.property_type = cur.property_type AND prev.rooms_bucket = cur.rooms_bucket
             AND prev.year = cur.year - 1 AND prev.half IS NOT DISTINCT FROM cur.half
        ),
        first_full AS (
            -- first complete calendar year of each cell: the base of the annualised trend
            SELECT geo_level, geo_code, condition, property_type, rooms_bucket,
                   arg_min(year, year) AS first_year, arg_min(median_price_m2, year) AS first_median
            FROM flagged WHERE period_type = 'year' AND NOT is_partial
            GROUP BY ALL
        ),
        new_builds AS (
            SELECT geo_level, geo_code, period_type, period, property_type, median_price_m2 AS new_median
            FROM flagged WHERE condition = 'new' AND n_sales >= {MIN_PUBLISHED_SALES}
        )
        SELECT w.geo_level, w.geo_code, w.period_type, w.period, w.year, w.half, w.is_partial,
               w.condition, w.property_type, w.rooms_bucket, w.n_sales,
               CASE WHEN w.n_sales >= {RELIABLE_SALES} THEN 'ok' ELSE 'low' END AS reliability,
               w.median_price_m2, w.p25_price_m2, w.p75_price_m2, w.median_price, w.median_surface_m2,
               w.median_land_m2, w.share_with_outbuilding,
               CASE WHEN NOT w.is_partial AND NOT w.prev_partial
                    THEN w.median_price_m2 / w.prev_median - 1 END AS yoy_change,
               -- M5: annualised change since the first complete year (e.g. 2022 → 2025)
               CASE WHEN w.period_type = 'year' AND NOT w.is_partial AND w.year > f.first_year
                    THEN pow(w.median_price_m2 / f.first_median, 1.0 / (w.year - f.first_year)) - 1
               END AS cagr,
               CASE WHEN w.period_type = 'year' AND NOT w.is_partial AND w.year > f.first_year
                    THEN f.first_year END AS cagr_since,
               -- new-build premium, on the existing all-sizes cell of the same type
               CASE WHEN w.condition = 'existing' AND w.rooms_bucket = 'all'
                    THEN nb.new_median / w.median_price_m2 - 1 END AS new_premium,
               '{run_id}' AS run_id
        FROM with_prev w
        LEFT JOIN first_full f USING (geo_level, geo_code, condition, property_type, rooms_bucket)
        LEFT JOIN new_builds nb ON nb.geo_level = w.geo_level AND nb.geo_code = w.geo_code
             AND nb.period_type = w.period_type AND nb.period = w.period AND nb.property_type = w.property_type
        """
    )


def land_cap_share(con: duckdb.DuckDBPyConnection) -> dict[str, float]:
    """Share of house sales left out of market cells for large land, per département (run report)."""
    return {
        dep: round(share, 4) for dep, share in con.execute(
            # every house counts: market_excluded is NULL for the ones kept
            """SELECT code_departement, avg(coalesce(market_excluded = 'large_land', false)::INTEGER)
               FROM dvf_sales WHERE property_type = 'house' GROUP BY 1 ORDER BY 2 DESC"""
        ).fetchall()
    }


# Price bands of the whole sale (€), as in most listing sites' budget filters.
PRICE_BANDS = ((0, 100_000), (100_000, 200_000), (200_000, 300_000), (300_000, 500_000), (500_000, None))


def build_price_band_kpis(con: duckdb.DuckDBPyConnection) -> None:
    """Create table kpi_price_bands: share of sales per price band, per geo × year × type
    (same trimmed existing sales as the €/m² cells, flats and houses apart, every year).
    Bands with no sale are present with share 0."""
    by_level = " UNION ALL ".join(
        f"SELECT '{level}' AS geo_level, {column} AS geo_code, year, property_type, price FROM market "
        f"WHERE {column} IS NOT NULL AND condition = 'existing'"
        for level, column in GEO_LEVELS.items()
    )
    band_case = " ".join(
        f"WHEN price < {high} THEN '{low // 1000}-{high // 1000}k'" if high else f"ELSE '{low // 1000}k+'"
        for low, high in PRICE_BANDS
    )
    labels = ", ".join(
        f"('{low // 1000}-{high // 1000}k', {i})" if high else f"('{low // 1000}k+', {i})"
        for i, (low, high) in enumerate(PRICE_BANDS)
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_price_bands AS
        WITH market AS ({_market_sales()}),
        sales AS (
            SELECT geo_level, geo_code, year, property_type, CASE {band_case} END AS band
            FROM ({by_level})
        ),
        bands AS (SELECT * FROM (VALUES {labels}) t(band, band_order)),
        cells AS (SELECT geo_level, geo_code, year, property_type, count(*) AS n_sales FROM sales GROUP BY ALL),
        counts AS (SELECT geo_level, geo_code, year, property_type, band, count(*) AS n FROM sales GROUP BY ALL)
        SELECT c.geo_level, c.geo_code, c.year, c.property_type, b.band, b.band_order, c.n_sales,
               coalesce(k.n, 0)::DOUBLE / c.n_sales AS share
        FROM cells c CROSS JOIN bands b
        LEFT JOIN counts k USING (geo_level, geo_code, year, property_type, band)
        """
    )


def export_published(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    """Write only publishable cells (n_sales >= MIN_PUBLISHED_SALES)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    query = f"SELECT * FROM kpi_price WHERE n_sales >= {MIN_PUBLISHED_SALES}"
    con.execute(
        f"COPY ({query} ORDER BY geo_level, geo_code, condition, property_type, rooms_bucket, period_type, period) "
        f"TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0]


def export_price_bands(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    """Publishable cells only (n_sales >= MIN_PUBLISHED_SALES), like the price KPIs."""
    query = f"SELECT * FROM kpi_price_bands WHERE n_sales >= {MIN_PUBLISHED_SALES}"
    con.execute(f"COPY ({query} ORDER BY ALL) TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
    return con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0]
