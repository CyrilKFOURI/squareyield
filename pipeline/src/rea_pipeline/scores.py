"""Market score (M17) and tenant affordability (M13), from the other KPI tables.

Score: every criterion of config/score_weights.json becomes a percentile rank (0–1) among the
places of the same level and property type that have enough sales; the score is the weighted
mean of available ranks × 100. The two strongest and two weakest criteria are kept so the app
can say *why* a place scores what it scores.
"""
import json
from pathlib import Path

import duckdb

from .rents import rent_at_sql

WEIGHTS_CONFIG = Path(__file__).resolve().parents[2] / "config" / "score_weights.json"
# Affordability: yearly rent of a typical home of the same type over the median living standard.
TYPICAL_SURFACE_M2 = {"apartment": 45, "house": 90}
SCORED_LEVELS = ("commune", "arrondissement")


def build_scores(con: duckdb.DuckDBPyConnection, config_path: Path = WEIGHTS_CONFIG) -> None:
    """Create table kpi_score(geo_level, geo_code, period, property_type, score, n_criteria,
    strengths, weaknesses, rent_to_income)."""
    config = json.loads(config_path.read_text(encoding="utf-8"))
    criteria = config["criteria"]
    levels = ", ".join(f"'{l}'" for l in SCORED_LEVELS)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE score_inputs AS
        WITH latest AS (
            SELECT max(period) AS latest_period FROM kpi_price WHERE period_type = 'year' AND NOT is_partial
        )
        SELECT p.geo_level, p.geo_code, p.period, p.property_type, p.n_sales, p.cagr,
               y.gross_yield, s.population_growth_yearly, s.jobs_growth_yearly, s.vacancy_rate,
               s.median_living_standard, d.share_fg
        FROM kpi_price p
        JOIN latest ON p.period = latest.latest_period
        LEFT JOIN kpi_yield y USING (geo_level, geo_code, period_type, period, property_type, rooms_bucket)
        LEFT JOIN kpi_socio s ON s.geo_level = p.geo_level AND s.geo_code = p.geo_code
        -- a house is judged on houses' energy labels, a flat on flats'
        LEFT JOIN kpi_dpe d ON d.geo_level = p.geo_level AND d.geo_code = p.geo_code
             AND d.property_type = p.property_type
        WHERE p.geo_level IN ({levels}) AND p.rooms_bucket = 'all' AND p.condition = 'existing'
          AND p.property_type IN ('apartment', 'house') AND p.n_sales >= {int(config["min_sales"])}
        """
    )
    ranks = []
    for name, spec in criteria.items():
        order = "DESC" if spec["direction"] == "low" else "ASC"
        ranks.append(
            f"""SELECT geo_level, geo_code, property_type, '{name}' AS criterion, {float(spec["weight"])} AS weight,
                       percent_rank() OVER (PARTITION BY geo_level, property_type ORDER BY {name} {order}) AS rank
                FROM score_inputs WHERE {name} IS NOT NULL"""
        )
    con.execute(f"CREATE OR REPLACE TABLE score_ranks AS {' UNION ALL '.join(ranks)}")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_score AS
        WITH scored AS (
            SELECT geo_level, geo_code, property_type,
                   100 * sum(rank * weight) / sum(weight) AS score,
                   count(*) AS n_criteria,
                   list(criterion ORDER BY rank DESC)[1:2] AS strengths,
                   list(criterion ORDER BY rank ASC)[1:2] AS weaknesses
            FROM score_ranks GROUP BY ALL
        ),
        typical AS (
            SELECT * FROM (VALUES {", ".join(f"('{t}', {m})" for t, m in TYPICAL_SURFACE_M2.items())})
                   t(property_type, surface)
        ),
        typical_rent AS (
            SELECT a.geo_level, a.geo_code, a.property_type, t.surface,
                   sum(a.w * {rent_at_sql("a.ref_rent_m2", "a.ref_surface", "a.slope", "t.surface")}) / sum(a.w) AS rent_m2
            FROM rent_area a JOIN typical t USING (property_type)
            WHERE a.geo_level IN ({levels})
            GROUP BY ALL
        )
        SELECT i.geo_level, i.geo_code, i.period, i.property_type, round(s.score, 1) AS score,
               s.n_criteria, s.strengths, s.weaknesses,
               12 * r.rent_m2 * r.surface / i.median_living_standard AS rent_to_income
        FROM score_inputs i
        JOIN scored s USING (geo_level, geo_code, property_type)
        LEFT JOIN typical_rent r USING (geo_level, geo_code, property_type)
        """
    )
    con.execute("DROP TABLE score_ranks")
    con.execute("DROP TABLE score_inputs")


def criteria_labels(config_path: Path = WEIGHTS_CONFIG) -> dict[str, str]:
    return {k: v["label"] for k, v in json.loads(config_path.read_text(encoding="utf-8"))["criteria"].items()}


def export_published(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    con.execute(f"COPY (SELECT * FROM kpi_score ORDER BY ALL) TO '{dest.as_posix()}' (FORMAT parquet)")
    return con.execute("SELECT count(*) FROM kpi_score").fetchone()[0]
