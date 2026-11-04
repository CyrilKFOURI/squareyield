"""INSEE "Comparateur de territoires": population, housing, income and jobs per territory.

S1 ingest + S3 marts M11 (vacancy), M12 (population growth), M13 (income) and context
indicators — docs/KPI_SPEC.md §1. INSEE already publishes every geo level we use, so no
aggregation is done here: values are only reshaped and turned into rates.
"""
import zipfile
from pathlib import Path

import duckdb
import httpx

from . import paths
from .ingest import download

COMPARATEUR_URL = "https://www.insee.fr/fr/statistiques/fichier/2521169/comparateur_csv.zip"
INSEE_DIR = paths.RAW / "insee"
HEADERS = {"User-Agent": "Mozilla/5.0 (rea-pipeline; open data ingestion)"}

# INSEE GEO_OBJECT (+ GEO code for France) -> our geo_level. Codes overlap between levels
# (a "bassin de vie" can be coded 49007 like the commune), so always filter on GEO_OBJECT.
GEO_LEVELS = {"COM": "commune", "ARM": "arrondissement", "DEP": "departement", "REG": "region"}
FRANCE_GEO = "F"  # France incl. overseas; 'FM' is metropolitan only

MEASURES = (
    "POP", "DWELLINGS", "DWELLINGS_OCS_DW_VAC", "DWELLINGS_OCS_DW_MAIN",
    "DWELLINGS_OCS_DW_MAIN_TSH_100", "DWELLINGS_OCS_DW_SEC_DW_OCC",
    "MED_SL", "PR_MD60", "NBEMP_EMPFORM_2",
)
CENSUS_YEAR, PREVIOUS_CENSUS_YEAR = 2023, 2017

# Risk thresholds shown as flags in the app (books: avoid vacancy above ~10 %).
HIGH_VACANCY = 0.10
POPULATION_DECLINE = -0.002  # per year


def ingest_insee() -> dict:
    with httpx.Client(follow_redirects=True, timeout=300, headers=HEADERS) as client:
        archive = INSEE_DIR / "comparateur_csv.zip"
        meta = download(COMPARATEUR_URL, archive, client)
    with zipfile.ZipFile(archive) as zf:
        zf.extract("comparateur.csv", INSEE_DIR)
    return meta


def comparateur_file() -> Path:
    return INSEE_DIR / "comparateur.csv"


def build_socio_kpis(con: duckdb.DuckDBPyConnection, comparateur_csv: Path, run_id: str) -> None:
    """Create table kpi_socio: one row per geo with census, income and jobs indicators."""
    measures = ", ".join(f"'{m}'" for m in MEASURES)
    level_case = " ".join(f"WHEN '{obj}' THEN '{level}'" for obj, level in GEO_LEVELS.items())
    con.execute(
        f"""
        CREATE OR REPLACE TABLE insee_long AS
        SELECT CASE GEO_OBJECT {level_case} WHEN 'FRANCE' THEN 'france' END AS geo_level,
               CASE WHEN GEO_OBJECT = 'FRANCE' THEN 'FR' ELSE GEO END AS geo_code,
               CAST(TIME_PERIOD AS INTEGER) AS year,
               TAB_MEASURE AS measure,
               TRY_CAST(OBS_VALUE AS DOUBLE) AS value
        FROM read_csv('{comparateur_csv.as_posix()}', delim = ';', header = true,
                      all_varchar = true)
        WHERE TAB_MEASURE IN ({measures})
          AND (GEO_OBJECT IN ({", ".join(f"'{o}'" for o in GEO_LEVELS)})
               OR (GEO_OBJECT = 'FRANCE' AND GEO = '{FRANCE_GEO}'))
        """
    )

    def pick(measure: str, year: int | None = CENSUS_YEAR) -> str:
        year_filter = f"AND year = {year}" if year else ""
        return f"max(value) FILTER (WHERE measure = '{measure}' {year_filter})"

    span = CENSUS_YEAR - PREVIOUS_CENSUS_YEAR
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_socio AS
        WITH wide AS (
            SELECT geo_level, geo_code,
                   {pick("POP")} AS population,
                   {pick("POP", PREVIOUS_CENSUS_YEAR)} AS population_prev,
                   {pick("DWELLINGS")} AS dwellings,
                   {pick("DWELLINGS_OCS_DW_VAC")} AS vacant,
                   {pick("DWELLINGS_OCS_DW_VAC", PREVIOUS_CENSUS_YEAR)} AS vacant_prev,
                   {pick("DWELLINGS", PREVIOUS_CENSUS_YEAR)} AS dwellings_prev,
                   {pick("DWELLINGS_OCS_DW_MAIN")} AS main_homes,
                   {pick("DWELLINGS_OCS_DW_MAIN_TSH_100")} AS owner_homes,
                   {pick("DWELLINGS_OCS_DW_SEC_DW_OCC")} AS second_homes,
                   {pick("NBEMP_EMPFORM_2")} AS jobs,
                   {pick("NBEMP_EMPFORM_2", PREVIOUS_CENSUS_YEAR)} AS jobs_prev,
                   -- Filosofi values are missing where INSEE applies statistical secrecy
                   {pick("MED_SL", None)} AS median_living_standard,
                   {pick("PR_MD60", None)} AS poverty_rate_pct
            FROM insee_long GROUP BY geo_level, geo_code
        )
        SELECT geo_level, geo_code,
               {CENSUS_YEAR} AS census_year,
               population,
               pow(population / nullif(population_prev, 0), 1.0 / {span}) - 1 AS population_growth_yearly,
               dwellings,
               vacant / nullif(dwellings, 0) AS vacancy_rate,
               vacant / nullif(dwellings, 0) - vacant_prev / nullif(dwellings_prev, 0) AS vacancy_change_pts,
               second_homes / nullif(dwellings, 0) AS second_home_share,
               1 - owner_homes / nullif(main_homes, 0) AS renter_share,
               main_homes - owner_homes AS rental_homes,
               median_living_standard,
               poverty_rate_pct / 100 AS poverty_rate,
               jobs,
               pow(jobs / nullif(jobs_prev, 0), 1.0 / {span}) - 1 AS jobs_growth_yearly,
               vacant / nullif(dwellings, 0) > {HIGH_VACANCY} AS flag_high_vacancy,
               pow(population / nullif(population_prev, 0), 1.0 / {span}) - 1
                   < {POPULATION_DECLINE} AS flag_population_decline,
               '{run_id}' AS run_id
        FROM wide
        WHERE geo_level IS NOT NULL AND population IS NOT NULL
        """
    )


HOUSING_URL = "https://www.insee.fr/fr/statistiques/fichier/8581474/base-cc-logement-2022_csv.zip"
HOUSING_MEMBER = "base-cc-logement-2022.CSV"
APARTMENT_PERIODS = [f"P22_RPAPPART_ACH{y}" for y in (1919, 1945, 1970, 1990, 2005, 2019)]
HOUSE_PERIODS = [f"P22_RPMAISON_ACH{y}" for y in (1919, 1945, 1970, 1990, 2005, 2019)]
STOCK_MEASURES = (
    "P22_LOG", "P22_RP", "P22_MAISON", "P22_APPART", "P22_RP_1P", "P22_RP_2P", "P22_RP_3P", "P22_RP_4P",
    "P22_RP_5PP", "P22_RPMAISON", "P22_NBPI_RPMAISON", "P22_RPAPPART", "P22_NBPI_RPAPPART",
    *APARTMENT_PERIODS, *HOUSE_PERIODS, "P22_RP_LOC", "P22_RP_LOCHLMV",
)


def ingest_housing() -> dict:
    """INSEE census 2022 "Logement" base per commune and arrondissement (~43 MB zip)."""
    with httpx.Client(follow_redirects=True, timeout=300, headers=HEADERS) as client:
        archive = INSEE_DIR / "base-cc-logement-2022_csv.zip"
        meta = download(HOUSING_URL, archive, client)
    with zipfile.ZipFile(archive) as zf:
        zf.extract(HOUSING_MEMBER, INSEE_DIR)
    return meta


def housing_file() -> Path:
    return INSEE_DIR / HOUSING_MEMBER


def build_stock_kpis(con: duckdb.DuckDBPyConnection, housing_csv: Path) -> None:
    """Create table kpi_stock: what the housing stock is made of, per geo level (census 2022).

    Communes and arrondissements as published; départements, régions and France add up the
    communes (arrondissement rows and the Paris/Lyon/Marseille totals are not double counted).
    Construction periods use the unambiguous ACH1919 … ACH2019 columns (ACH2019 = 2006–2019).
    """
    cast = ", ".join(f"TRY_CAST(\"{m}\" AS DOUBLE) AS {m}" for m in STOCK_MEASURES)
    sums = ", ".join(f"sum({m}) AS {m}" for m in STOCK_MEASURES)
    apt_total = " + ".join(APARTMENT_PERIODS)
    house_total = " + ".join(HOUSE_PERIODS)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_stock AS
        WITH raw AS (
            SELECT CODGEO AS code, {cast}
            FROM read_csv('{housing_csv.as_posix()}', delim = ';', header = true, all_varchar = true)
        ),
        own AS (
            SELECT CASE WHEN m.code_arrondissement IS NOT NULL THEN 'arrondissement' ELSE 'commune' END AS geo_level,
                   r.*
            FROM raw r JOIN commune_map m ON m.code = r.code
            WHERE m.code = m.code_commune OR m.code = m.code_arrondissement
        ),
        communes AS (
            SELECT r.*, m.departement, m.region FROM raw r JOIN commune_map m ON m.code = r.code
            WHERE m.code = m.code_commune
        ),
        higher AS (
            SELECT 'departement' AS geo_level, departement AS code, {sums} FROM communes GROUP BY departement
            UNION ALL SELECT 'region', region, {sums} FROM communes GROUP BY region
            UNION ALL SELECT 'france', 'FR', {sums} FROM communes
        ),
        stock AS (
            SELECT geo_level, code, {", ".join(STOCK_MEASURES)} FROM own
            UNION ALL SELECT * FROM higher
        )
        SELECT geo_level, code AS geo_code,
               P22_LOG AS dwellings_2022,
               P22_MAISON / nullif(P22_LOG, 0) AS share_houses,
               P22_APPART / nullif(P22_LOG, 0) AS share_apartments,
               P22_RP_1P / nullif(P22_RP, 0) AS main_homes_1p_share,
               P22_RP_2P / nullif(P22_RP, 0) AS main_homes_2p_share,
               P22_RP_3P / nullif(P22_RP, 0) AS main_homes_3p_share,
               P22_RP_4P / nullif(P22_RP, 0) AS main_homes_4p_share,
               P22_RP_5PP / nullif(P22_RP, 0) AS main_homes_5p_share,
               P22_NBPI_RPAPPART / nullif(P22_RPAPPART, 0) AS avg_rooms_apartment,
               P22_NBPI_RPMAISON / nullif(P22_RPMAISON, 0) AS avg_rooms_house,
               (P22_RPAPPART_ACH1919 + P22_RPAPPART_ACH1945) / nullif({apt_total}, 0) AS apartments_before_1946_share,
               P22_RPAPPART_ACH2019 / nullif({apt_total}, 0) AS apartments_after_2005_share,
               (P22_RPMAISON_ACH1919 + P22_RPMAISON_ACH1945) / nullif({house_total}, 0) AS houses_before_1946_share,
               P22_RPMAISON_ACH2019 / nullif({house_total}, 0) AS houses_after_2005_share,
               P22_RP_LOC / nullif(P22_RP, 0) AS tenant_share,
               P22_RP_LOCHLMV / nullif(P22_RP, 0) AS social_tenant_share
        FROM stock
        """
    )


def export_published(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    con.execute(
        f"COPY (SELECT * FROM kpi_socio ORDER BY geo_level, geo_code) "
        f"TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute("SELECT count(*) FROM kpi_socio").fetchone()[0]
