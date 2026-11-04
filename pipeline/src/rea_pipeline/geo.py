"""Coordinates for DVF sales (docs/features/011-price-check-ml/spec.md §3).

The official DVF files have no coordinates. geo-DVF (Etalab) has lat/lon per parcel for the
sales it covers, but lags the official release, so new sales often sit on parcels it has
never seen (only 16 % of 2026 house sales match a known parcel).

Every sale is therefore placed at the median point of its **cadastral section** (commune +
prefix + section, ~13 known parcels each, median 250 m from the parcel), falling back to the
commune. The same rule is used for training and for prediction, so the model never learns on
positions more precise than the ones it will receive.
"""
import json
import re
from pathlib import Path

import duckdb
import httpx

from . import paths
from .ingest import download

GEO_DVF_LISTING = "https://files.data.gouv.fr/geo-dvf/latest/csv/"
GEO_DVF_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv/{year}/full.csv.gz"
GEO_DVF_DIR = paths.RAW / "dvf"
SECTION_KEY_LENGTH = 10  # id_parcelle = commune(5) + prefix(3) + section(2) + plan(4)


def ingest_geo_dvf() -> list[dict]:
    """Download every year geo-DVF currently publishes (skipped when the ETag is unchanged)."""
    with httpx.Client(follow_redirects=True, timeout=600) as client:
        listing = client.get(GEO_DVF_LISTING)
        listing.raise_for_status()
        years = sorted({int(y) for y in re.findall(r"/csv/(\d{4})/", listing.text)})
        results = [
            download(GEO_DVF_URL.format(year=year), GEO_DVF_DIR / f"{year}.csv.gz", client) | {"year": year}
            for year in years
        ]
    (GEO_DVF_DIR / "years.json").write_text(json.dumps(years))
    return results


def geo_dvf_files() -> list[Path]:
    years = json.loads((GEO_DVF_DIR / "years.json").read_text())
    return [GEO_DVF_DIR / f"{year}.csv.gz" for year in years]


def build_location_tables(con: duckdb.DuckDBPyConnection, files: list[Path]) -> None:
    """Create tables section_point(section, longitude, latitude, n_parcels) and
    commune_point(code, longitude, latitude) from geo-DVF parcel coordinates."""
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE parcel_point AS
        SELECT id_parcelle,
               avg(TRY_CAST(longitude AS DOUBLE)) AS longitude,
               avg(TRY_CAST(latitude AS DOUBLE)) AS latitude
        FROM read_csv([{file_list}], header = true, all_varchar = true, union_by_name = true,
                      delim = ',', quote = '"', escape = '"')
        WHERE TRY_CAST(longitude AS DOUBLE) IS NOT NULL
        GROUP BY id_parcelle
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE section_point AS
        SELECT left(id_parcelle, {SECTION_KEY_LENGTH}) AS section,
               median(longitude) AS longitude, median(latitude) AS latitude, count(*) AS n_parcels
        FROM parcel_point GROUP BY 1
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE commune_point AS
        SELECT left(id_parcelle, 5) AS code, median(longitude) AS longitude, median(latitude) AS latitude
        FROM parcel_point GROUP BY 1
        """
    )
    con.execute("DROP TABLE parcel_point")


def export_location_tables(con: duckdb.DuckDBPyConnection, marts_dir: Path) -> None:
    """Publish section and commune points (public cadastral positions, no prices) for the model."""
    marts_dir.mkdir(parents=True, exist_ok=True)
    for table in ("section_point", "commune_point"):
        con.execute(f"COPY {table} TO '{(marts_dir / f'{table}.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
