"""ANIL / DHUP "Carte des loyers": asking rents per m² (charges included) by commune.

S1 ingest of the latest edition + S3 marts M8 (rent €/m²), M9 (gross yield) and M10
(price-to-rent ratio) — docs/KPI_SPEC.md §1.

Only the latest edition is used: ANIL states editions are not comparable over time. Rents
apply to listings of the edition's year, so yields are only paired with price periods from
that year onwards.

Rent per m² falls with surface. ANIL gives flats at three reference surfaces (37, 52, 72 m²),
so each commune gets a curve rent(s) = rent_52 × (s / 52)^slope, fitted on those three points,
and every price cell is paired with the rent read at its own median surface (segmentation
study §5). Houses have one point (92 m²) and borrow the commune's flat slope.
ANIL rents are listing rents of unfurnished homes, charges included: the yield is labelled so.
"""
import re
from pathlib import Path

import duckdb
import httpx

from . import paths
from .ingest import download
from .marts import RELIABLE_SALES

DATASET_SEARCH_API = "https://www.data.gouv.fr/api/1/datasets/?q=carte%20des%20loyers&page_size=20"
SLUG = re.compile(r"^carte-des-loyers-indicateurs-de-loyers-dannonce-par-commune-en-(\d{4})$")
RENTS_DIR = paths.RAW / "rents"
# Below this median €/m² a "market" is made of non-market sales (shares of undivided property,
# ruins): a yield would be meaningless (Sainte-Rose, Guadeloupe: 142 €/m² -> 104 %).
MIN_PLAUSIBLE_PRICE_M2 = 300
# A gross yield above this is not a market: it comes from a handful of odd sales in a small cell
# (one half-year, one room count). Such cells get no yield; validation checks they stay rare.
MAX_PLAUSIBLE_YIELD = 0.30

# ANIL file stem -> (property_type, reference surface in m² of the file's predictions)
SEGMENTS = {
    "pred-app12-mef-dhup": ("apartment", 37),
    "pred-app-mef-dhup": ("apartment", 52),
    "pred-app3-mef-dhup": ("apartment", 72),
    "pred-mai-mef-dhup": ("house", 92),
}
# the point each curve is anchored on: the all-flats file and the houses file
REFERENCE_SURFACE = {"apartment": 52, "house": 92}
# a rent is never extrapolated far from the surfaces ANIL observed
SURFACE_BOUNDS = (25, 110)
# rent per m² does not rise with surface; a fitted slope steeper than -0.8 is noise
SLOPE_BOUNDS = (-0.8, 0.0)
# ANIL's own caution rule: few listings in the commune or a poor model fit
CAUTION_LISTINGS, CAUTION_R2 = 30, 0.5


def rent_at(ref_rent_m2: float, ref_surface_m2: float, slope: float, surface_m2: float) -> float:
    """Rent €/m² of a home of `surface_m2` on a commune's curve (surface clamped to SURFACE_BOUNDS)."""
    surface = min(max(surface_m2, SURFACE_BOUNDS[0]), SURFACE_BOUNDS[1])
    return ref_rent_m2 * (surface / ref_surface_m2) ** slope


def rent_at_sql(ref: str, ref_surface: str, slope: str, surface: str) -> str:
    """SQL twin of rent_at."""
    low, high = SURFACE_BOUNDS
    return f"{ref} * pow(least(greatest({surface}, {low}), {high}) / {ref_surface}, {slope})"


def _latest_edition(client: httpx.Client) -> tuple[int, list[dict]]:
    response = client.get(DATASET_SEARCH_API)
    response.raise_for_status()
    editions = {
        int(match.group(1)): dataset
        for dataset in response.json()["data"]
        if (match := SLUG.match(dataset["slug"]))
    }
    year = max(editions)
    return year, [r for r in editions[year]["resources"] if r["format"] == "csv"]


def ingest_rents() -> dict:
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        year, resources = _latest_edition(client)
        files = {}
        for resource in resources:
            stem = resource["url"].rsplit("/", 1)[-1].removesuffix(".csv")
            if stem in SEGMENTS:
                files[stem] = download(resource["url"], RENTS_DIR / str(year) / f"{stem}.csv", client)
    missing = set(SEGMENTS) - set(files)
    if missing:
        raise RuntimeError(f"rent edition {year} is missing files: {sorted(missing)}")
    (RENTS_DIR / "edition.txt").write_text(str(year))
    return {"edition": year, "files": files}


def edition() -> int:
    return int((RENTS_DIR / "edition.txt").read_text())


def _as_utf8(path: Path) -> Path:
    """ANIL files are Windows-1252 (they contain 'œ', which latin-1 lacks): convert once."""
    target = path.with_name(path.stem + ".utf8.csv")
    if not target.exists() or target.stat().st_mtime < path.stat().st_mtime:
        target.write_text(path.read_bytes().decode("cp1252"), encoding="utf-8", newline="")
    return target


def load_rents(con: duckdb.DuckDBPyConnection, directory: Path, vintage: int) -> None:
    """Create table rent_ref(code, property_type, ref_surface, rent_m2, rent_low_m2, rent_high_m2,
    rent_level, n_listings, r2, vintage): one row per ANIL file and code. `code` is the INSEE
    code of the file: a commune, or an arrondissement for Paris/Lyon/Marseille."""
    selects = []
    for stem, (property_type, surface) in SEGMENTS.items():
        selects.append(
            f"""
            SELECT INSEE_C AS code, '{property_type}' AS property_type, {surface} AS ref_surface,
                   CAST(replace(loypredm2, ',', '.') AS DOUBLE) AS rent_m2,
                   CAST(replace("lwr.IPm2", ',', '.') AS DOUBLE) AS rent_low_m2,
                   CAST(replace("upr.IPm2", ',', '.') AS DOUBLE) AS rent_high_m2,
                   -- where ANIL estimated it: the commune's own listings, its EPCI, or a
                   -- "maille" (group of similar neighbouring communes)
                   lower(TYPPRED) AS rent_level,
                   CAST(nbobs_com AS INTEGER) AS n_listings,
                   CAST(replace(R2_adj, ',', '.') AS DOUBLE) AS r2,
                   {vintage} AS vintage
            FROM read_csv('{_as_utf8(directory / f"{stem}.csv").as_posix()}', delim = ';',
                          header = true, all_varchar = true)
            """
        )
    con.execute(f"CREATE OR REPLACE TABLE rent_ref AS {' UNION ALL '.join(selects)}")


def build_rent_curves(con: duckdb.DuckDBPyConnection) -> None:
    """Create rent_child (one curve per ANIL code and type, with its rental-home weight) and
    rent_area (the same curves listed under every geo level that contains them)."""
    low, high = SLOPE_BOUNDS
    con.execute(
        f"""
        CREATE OR REPLACE TABLE rent_child AS
        WITH flat_slope AS (
            SELECT code, greatest(least(regr_slope(ln(rent_m2), ln(ref_surface)), {high}), {low}) AS slope
            FROM rent_ref WHERE property_type = 'apartment' GROUP BY code
        )
        SELECT r.code, r.property_type, r.ref_surface, r.rent_m2 AS ref_rent_m2,
               r.rent_low_m2 / r.rent_m2 AS low_ratio, r.rent_high_m2 / r.rent_m2 AS high_ratio,
               coalesce(f.slope, 0) AS slope, r.rent_level, r.n_listings,
               r.n_listings < {CAUTION_LISTINGS} OR r.r2 < {CAUTION_R2} AS caution, r.vintage,
               m.code_commune, m.code_arrondissement, m.departement, m.region,
               -- weight: rental main homes, where the rents are paid (a commune with none still
               -- counts a little: a zero weight would make a lone commune's rent 0/0 = NaN)
               CASE WHEN coalesce(s.rental_homes, 0) > 0 THEN s.rental_homes ELSE 1 END AS w
        FROM rent_ref r
        JOIN commune_map m ON m.code = r.code
        LEFT JOIN flat_slope f ON f.code = r.code
        LEFT JOIN kpi_socio s
          ON s.geo_level = CASE WHEN m.code_arrondissement IS NOT NULL THEN 'arrondissement' ELSE 'commune' END
         AND s.geo_code = r.code
        WHERE (r.property_type = 'apartment' AND r.ref_surface = {REFERENCE_SURFACE["apartment"]})
           OR (r.property_type = 'house' AND r.ref_surface = {REFERENCE_SURFACE["house"]})
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE rent_area AS
        SELECT 'arrondissement' AS geo_level, code_arrondissement AS geo_code, *
        FROM rent_child WHERE code_arrondissement IS NOT NULL
        UNION ALL SELECT 'commune', code_commune, * FROM rent_child
        UNION ALL SELECT 'departement', departement, * FROM rent_child
        UNION ALL SELECT 'region', region, * FROM rent_child
        UNION ALL SELECT 'france', 'FR', * FROM rent_child
        """
    )


def build_yield_kpis(con: duckdb.DuckDBPyConnection) -> None:
    """Create table kpi_yield: every existing-home price cell of flats or houses paired with the
    rent read at that cell's median surface, same area, same type, same size.

    Communes and arrondissements read their own curve (Paris/Lyon/Marseille: their
    arrondissements); higher levels average the curves of their communes weighted by rental
    homes, and rent_coverage says which share of the area's rental homes has a rent.
    Implausible cells are kept with status 'excluded' and a reason instead of vanishing.
    """
    build_rent_curves(con)
    rent = rent_at_sql("a.ref_rent_m2", "a.ref_surface", "a.slope", "p.median_surface_m2")
    low_s, high_s = SURFACE_BOUNDS
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_yield AS
        WITH rented AS (
            SELECT p.geo_level, p.geo_code, p.period_type, p.period, p.property_type, p.rooms_bucket,
                   any_value(p.n_sales) AS n_sales, any_value(p.median_price_m2) AS median_price_m2,
                   least(greatest(any_value(p.median_surface_m2), {low_s}), {high_s}) AS rent_surface_m2,
                   sum(a.w * {rent}) / sum(a.w) AS rent_m2,
                   sum(a.w * {rent} * a.low_ratio) / sum(a.w) AS rent_low_m2,
                   sum(a.w * {rent} * a.high_ratio) / sum(a.w) AS rent_high_m2,
                   CASE WHEN p.geo_level IN ('commune', 'arrondissement')
                        THEN arg_max(a.rent_level, CASE a.rent_level WHEN 'commune' THEN 0
                                                                     WHEN 'epci' THEN 1 ELSE 2 END)
                        ELSE 'aggregate' END AS rent_level,
                   p.geo_level IN ('commune', 'arrondissement') AND bool_or(a.caution) AS rent_caution,
                   sum(a.w) AS covered_homes,
                   sum(a.n_listings) AS n_listings, any_value(a.vintage) AS rent_vintage,
                   any_value(p.run_id) AS run_id
            FROM kpi_price p
            JOIN rent_area a ON a.geo_level = p.geo_level AND a.geo_code = p.geo_code
                            AND a.property_type = p.property_type
            -- a rent edition describes its own year: never pair it with older prices
            WHERE p.condition = 'existing' AND p.property_type IN ('apartment', 'house')
              AND p.year >= a.vintage
            GROUP BY p.geo_level, p.geo_code, p.period_type, p.period, p.property_type, p.rooms_bucket
        ),
        judged AS (
            SELECT r.*,
                   CASE WHEN r.median_price_m2 < {MIN_PLAUSIBLE_PRICE_M2} THEN 'price_below_floor'
                        WHEN 12 * r.rent_m2 / r.median_price_m2 > {MAX_PLAUSIBLE_YIELD} THEN 'yield_above_ceiling'
                   END AS reason
            FROM rented r
        )
        SELECT j.geo_level, j.geo_code, j.period_type, j.period, j.property_type, j.rooms_bucket,
               j.n_sales, CASE WHEN j.n_sales >= {RELIABLE_SALES} THEN 'ok' ELSE 'low' END AS reliability,
               j.median_price_m2, j.rent_m2, j.rent_low_m2, j.rent_high_m2, j.rent_surface_m2,
               CASE j.property_type WHEN 'house' THEN 'house_approx' ELSE 'surface_adjusted' END AS rent_method,
               j.rent_level, j.rent_caution,
               least(j.covered_homes / s.rental_homes, 1) AS rent_coverage,
               j.n_listings, j.rent_vintage,
               CASE WHEN j.reason IS NULL THEN 12 * j.rent_m2 / j.median_price_m2 END AS gross_yield,
               CASE WHEN j.reason IS NULL THEN j.median_price_m2 / (12 * j.rent_m2) END AS price_to_rent_years,
               CASE WHEN j.reason IS NULL THEN 'ok' ELSE 'excluded' END AS status,
               j.reason, j.run_id
        FROM judged j
        LEFT JOIN kpi_socio s ON s.geo_level = j.geo_level AND s.geo_code = j.geo_code
        """
    )


def export_published(con: duckdb.DuckDBPyConnection, dest: Path, min_sales: int) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    query = f"SELECT * FROM kpi_yield WHERE n_sales >= {min_sales}"
    con.execute(
        f"COPY ({query} ORDER BY geo_level, geo_code, property_type, rooms_bucket, period) "
        f"TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0]
