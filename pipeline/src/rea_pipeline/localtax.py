"""DGFiP REI (fichier de recensement des éléments d'imposition): property tax rate per commune (M15).

The global taxe foncière (built property) rate is the sum of what every body levies on the
commune's territory: commune (E12), syndicates (E22), intercommunality (E32), special
equipment tax (E52), GEMAPI (E52gGEMAPI) and the Île-de-France TASA (E52TASA). The tax a
property pays is roughly half its cadastral rental value times this rate.
"""
import re
import zipfile
from pathlib import Path

import duckdb
import httpx

from . import paths
from .ingest import download

DATASET_API = (
    "https://www.data.gouv.fr/api/1/datasets/"
    "impots-locaux-fichier-de-recensement-des-elements-dimposition-a-la-fiscalite-dir/"
)
SEARCH_API = "https://www.data.gouv.fr/api/1/datasets/?q=impots%20locaux%20fichier%20de%20recensement&page_size=3"
TITLE = re.compile(r"REI-(\d{4})-fichier")
REI_DIR = paths.RAW / "rei"
RATE_COLUMNS = ("E12", "E22", "E32", "E52", "E52gGEMAPI", "E52TASA")


def ingest_rei() -> dict:
    """Download the latest REI year listed on data.gouv.fr."""
    with httpx.Client(follow_redirects=True, timeout=600) as client:
        response = client.get(SEARCH_API)
        response.raise_for_status()
        resources = response.json()["data"][0]["resources"]
        editions = {int(m.group(1)): r for r in resources if (m := TITLE.match(r["title"]))}
        year = max(editions)
        archive = REI_DIR / f"rei_{year}.zip"
        meta = download(editions[year]["url"], archive, client)
    with zipfile.ZipFile(archive) as zf:
        member = next(name for name in zf.namelist() if name.lower().endswith(".csv"))
        zf.extract(member, REI_DIR)
    (REI_DIR / "edition.txt").write_text(f"{year}\n{member}")
    return meta | {"year": year}


def rei_file() -> tuple[int, Path]:
    year, member = (REI_DIR / "edition.txt").read_text().split("\n")
    return int(year), REI_DIR / member


def build_local_tax_kpis(con: duckdb.DuckDBPyConnection, csv: Path, year: int) -> None:
    """Create table kpi_local_tax(geo_level, geo_code, tax_year, tfpb_rate) for communes and the
    arrondissements of Paris, Lyon and Marseille (which share their city's rate)."""
    rate = " + ".join(f"coalesce(TRY_CAST(\"{c}\" AS DOUBLE), 0)" for c in RATE_COLUMNS)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_local_tax AS
        WITH rei AS (
            SELECT DEP || COM AS code, ({rate}) / 100 AS tfpb_rate,
                   coalesce(TRY_CAST("E11" AS DOUBLE), 0) AS base
            FROM read_csv('{csv.as_posix()}', delim = ';', header = true, all_varchar = true,
                          encoding = 'latin-1')
        ),
        communes AS (
            -- a merged commune: its own row when the REI lists the current code, else the
            -- mean of its former communes weighted by their built-property tax base (E11)
            SELECT 'commune' AS geo_level, m.code_commune AS geo_code,
                   coalesce(any_value(r.tfpb_rate) FILTER (WHERE r.code = m.code_commune),
                            sum(r.tfpb_rate * r.base) / nullif(sum(r.base), 0),
                            avg(r.tfpb_rate)) AS tfpb_rate
            FROM rei r JOIN commune_map m ON m.code = r.code
            GROUP BY m.code_commune
        )
        SELECT geo_level, geo_code, {year} AS tax_year, tfpb_rate FROM communes
        UNION ALL
        SELECT 'arrondissement', m.code_arrondissement, {year}, c.tfpb_rate
        FROM commune_map m JOIN communes c ON c.geo_code = m.code_commune
        WHERE m.code_arrondissement IS NOT NULL
        """
    )


def export_published(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    con.execute(f"COPY (SELECT * FROM kpi_local_tax ORDER BY ALL) TO '{dest.as_posix()}' (FORMAT parquet)")
    return con.execute("SELECT count(*) FROM kpi_local_tax").fetchone()[0]
