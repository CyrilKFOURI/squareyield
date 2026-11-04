"""Observatoires Locaux des Loyers (OLL): rents in place of the private rental stock, by type,
rooms, construction period and tenancy length, in ~50 agglomerations, yearly since 2014
(docs/features/013-comparable-segments/spec.md §2.4).

Unlike ANIL (asking rents of new lettings, one edition at a time), OLL figures are comparable
from one year to the next: they give a real rent trend. They are shown next to ANIL, never
mixed with it.

The national files name agglomerations but carry no commune codes. Each agglomeration's own zip
has a zoning file (commune × IRIS → zone) and its own copy of the figures: the national rows
are matched to an agglomeration code by a fingerprint (observatory, year, number of
observations of the agglomeration-wide row), and only the two small members of each zip are
read (HTTP Range requests), not the 1.5 MB of map files around them.
"""
import csv
import io
import re
import zipfile
from datetime import datetime
from pathlib import Path

import duckdb
import httpx

from . import paths
from .ingest import download
from .rents import _as_utf8

NATIONAL_URL = "https://www.observatoires-des-loyers.org/datagouv/{year}/Base_OP_{year}_Nationale.csv"
AGGLOMERATIONS_DATASET = (
    "https://www.data.gouv.fr/api/1/datasets/resultats-des-observatoires-locaux-des-loyers-par-agglomeration/"
)
FIRST_YEAR = 2014
OLL_DIR = paths.RAW / "oll"
# agglomeration codes become file names (serve/oll/<code>.json): only this shape is accepted
AGGLOMERATION_CODE = re.compile(r"L[0-9][0-9AB][0-9]{2}")
DIMENSIONS = ("Zone_complementaire", "Type_habitat", "epoque_construction_homogene",
              "anciennete_locataire_homogene", "nombre_pieces_homogene")


class _HttpRangeFile(io.RawIOBase):
    """Seekable read-only view of a remote file, fetched by HTTP Range requests."""

    def __init__(self, client: httpx.Client, url: str):
        self.client, self.url, self.position = client, url, 0
        # total size from Content-Range ("bytes 0-0/1554971"): a HEAD may describe a redirect
        probe = client.get(url, headers={"Range": "bytes=0-0"}, follow_redirects=True)
        probe.raise_for_status()
        self.size = int(probe.headers["content-range"].rsplit("/", 1)[1])

    def seekable(self) -> bool:
        return True

    def readable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        self.position = base + offset
        return self.position

    def readinto(self, buffer) -> int:
        end = min(self.position + len(buffer), self.size) - 1
        if end < self.position:
            return 0
        response = self.client.get(self.url, headers={"Range": f"bytes={self.position}-{end}"},
                                   follow_redirects=True)
        response.raise_for_status()
        if response.status_code != 206:
            raise RuntimeError(f"{self.url}: server ignored the Range request")
        data = response.content
        buffer[: len(data)] = data
        self.position += len(data)
        return len(data)


def _is_agglomeration_row(row: dict) -> bool:
    return all(not (row.get(d) or "").strip() for d in DIMENSIONS if d in row)


def _rows(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text), delimiter=";"))


def _decode(raw: bytes) -> str:
    """Most OLL files are Windows-1252, a few UTF-8 with a byte-order mark, one at least in a DOS
    code page: codes are ASCII in all of them, so an odd letter in a name is replaced, not fatal."""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


# the commune code column of a zoning file, by observatory
ZONING_COMMUNE_COLUMNS = ("commune", "insee", "code_insee")


def zoning_rows(code: str, raw: bytes) -> list[tuple[str, str]]:
    """(agglomeration code, commune code) pairs of a zoning file, whatever its header."""
    rows = _rows(_decode(raw))
    if not rows:
        return []
    column = next(k for k in rows[0] if k.strip().lower() in ZONING_COMMUNE_COLUMNS)
    return sorted({(code, row[column].strip()) for row in rows if row[column].strip()})


def _local_fingerprint(code: str, base_csv: str) -> tuple[str, str, int, int] | None:
    """(code, observatory, year, observations) of the agglomeration-wide row of a local file."""
    for row in _rows(base_csv):
        local_dims = [k for k in row if k.endswith(("_local", "_homogene")) or k in ("Zone_calcul", "Zone_complementaire", "Type_habitat")]
        if all(not (row[k] or "").strip() for k in local_dims):
            return code, row["Observatory"], int(row["Data_year"]), int(row["nombre_observations"])
    return None


def match_agglomerations(national_csv: Path, fingerprints: list[tuple[str, str, int, int]]) -> dict[str, str]:
    """National agglomeration name -> agglomeration code (e.g. 'L3500'), by fingerprint."""
    by_key = {(obs, year, n): code for code, obs, year, n in fingerprints}
    names = {}
    for row in _rows(national_csv.read_bytes().decode("cp1252")):
        if _is_agglomeration_row(row):
            key = (row["Observatory"], int(row["Data_year"]), int(row["nombre_observations"]))
            if key in by_key:
                names[row["agglomeration"]] = by_key[key]
    return names


def match_all(directory: Path, fingerprints: list[tuple[str, str, int, int]]) -> dict[str, str]:
    """match_agglomerations year by year: each zip is matched against the national file of its
    own year (an agglomeration may have no zip for the latest year)."""
    names: dict[str, str] = {}
    for year in sorted({f[2] for f in fingerprints}):
        national = directory / f"Base_OP_{year}_Nationale.csv"
        if national.exists():
            names |= match_agglomerations(national, [f for f in fingerprints if f[2] == year])
    return names


def is_agglomeration_code(code: str) -> bool:
    return AGGLOMERATION_CODE.fullmatch(code) is not None


def write_zones(dest: Path, names: dict[str, str], zoning: list[tuple[str, str]]) -> None:
    """zones.csv: agglo_code, agglomeration (national name), code_commune. Codes that do not
    look like an OLL agglomeration code (they come from download URLs) are left out."""
    code_to_name = {code: name for name, code in names.items() if is_agglomeration_code(code)}
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["agglo_code", "agglomeration", "code_commune"])
        for code, commune in sorted(set(zoning)):
            if code in code_to_name:
                writer.writerow([code, code_to_name[code], commune])


def national_dir() -> Path:
    return OLL_DIR / "national"


def zones_file() -> Path:
    return OLL_DIR / "zones.csv"


def ingest_oll() -> dict:
    """Download every yearly national file, then the zoning of the latest year's agglomerations."""
    files = {}
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        for year in range(FIRST_YEAR, datetime.now().year + 1):
            url = NATIONAL_URL.format(year=year)
            if client.head(url).status_code != 200:
                continue
            files[str(year)] = download(url, national_dir() / f"Base_OP_{year}_Nationale.csv", client)
        dataset = client.get(AGGLOMERATIONS_DATASET)
        dataset.raise_for_status()
        # every zip of every agglomeration, newest first ("…/2024/Base_OP_2024_L1300.zip")
        zips: dict[str, list[tuple[int, str]]] = {}
        for resource in dataset.json()["resources"]:
            url = resource["url"]
            if not url.endswith(".zip") or "Base_OP_" not in url:
                continue
            year, code = url.rsplit("Base_OP_", 1)[1].removesuffix(".zip").split("_", 1)
            if not is_agglomeration_code(code) or not year.isdigit():
                continue
            zips.setdefault(code, []).append((int(year), url))
        fingerprints, zoning, unreadable = [], [], {}
        for code, versions in sorted(zips.items()):
            # some zips are unreadable or ship an empty zoning file: fall back to older ones
            fingerprint, communes = None, []
            for _, url in sorted(versions, reverse=True):
                try:
                    with zipfile.ZipFile(io.BufferedReader(_HttpRangeFile(client, url), 1 << 16)) as zf:
                        names = zf.namelist()
                        if fingerprint is None:
                            base = next(n for n in names
                                        if n.rsplit("/", 1)[-1].startswith("Base_OP_") and n.endswith(".csv"))
                            fingerprint = _local_fingerprint(code, _decode(zf.read(base)))
                        if not communes:
                            zones = next(n for n in names if "Zonage" in n and n.endswith(".csv"))
                            communes = zoning_rows(code, zf.read(zones))
                except (zipfile.BadZipFile, StopIteration, httpx.HTTPError, RuntimeError) as error:
                    unreadable[url.rsplit("/", 1)[-1]] = f"{type(error).__name__}: {error}"
                if fingerprint and communes:
                    break
            if fingerprint:
                fingerprints.append(fingerprint)
            zoning += communes
    names = match_all(national_dir(), fingerprints)
    write_zones(zones_file(), names, zoning)
    return {"files": files, "agglomerations": len(names), "communes": len({c for _, c in zoning}),
            "unreadable_zips": unreadable}


def _num(column: str) -> str:
    return f"TRY_CAST(replace({column}, ',', '.') AS DOUBLE)"


def build_oll_kpis(con: duckdb.DuckDBPyConnection, directory: Path, zones_csv: Path) -> None:
    """Create kpi_rent_oll (agglomeration-wide figures per year × type × rooms × construction
    period × tenancy), oll_commune (commune -> agglomeration) and oll_skipped (rows left out:
    centre/outskirts splits and zone-coded rows)."""
    files = ", ".join(f"'{_as_utf8(f).as_posix()}'" for f in sorted(directory.glob("Base_OP_*_Nationale.csv")))
    con.execute(
        f"""
        CREATE OR REPLACE TABLE oll_raw AS
        SELECT r.*, z.agglo_code
        FROM read_csv([{files}], delim = ';', header = true, all_varchar = true, union_by_name = true) r
        JOIN (SELECT DISTINCT agglo_code, agglomeration FROM read_csv('{zones_csv.as_posix()}', header = true,
                                                                    all_varchar = true)) z
          USING (agglomeration)
        """
    )
    coded = " OR ".join(f"coalesce({d}, '') LIKE 'L%'" for d in DIMENSIONS[2:])
    skip = f"coalesce(Zone_complementaire, '') <> '' OR coalesce(Type_habitat, '') = 'ALL' OR {coded}"
    con.execute(f"CREATE OR REPLACE TABLE oll_skipped AS SELECT count(*) AS n FROM oll_raw WHERE {skip}")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_rent_oll AS
        SELECT agglo_code, agglomeration, Observatory AS observatory, CAST(Data_year AS INTEGER) AS year,
               CASE WHEN nombre_pieces_homogene LIKE 'Appart%' THEN 'apartment'
                    WHEN nombre_pieces_homogene LIKE 'Maison%' THEN 'house'
                    WHEN Type_habitat = 'Appartement' THEN 'apartment'
                    WHEN Type_habitat = 'Maison' THEN 'house' ELSE 'all' END AS property_type,
               coalesce(nullif(replace(regexp_extract(regexp_replace(nombre_pieces_homogene, 'P et plus$', 'P+'),
                                                      '([0-9][-0-9]*P\\+?)$'), 'P', ''), ''),
                        'all') AS rooms,
               CASE left(coalesce(epoque_construction_homogene, ''), 1)
                    WHEN '1' THEN '<1946' WHEN '2' THEN '1946-1970' WHEN '3' THEN '1971-1990'
                    WHEN '4' THEN '1991-2005' WHEN '5' THEN '>2005' ELSE 'all' END AS period_built,
               CASE left(coalesce(anciennete_locataire_homogene, ''), 1)
                    WHEN '1' THEN 'new' WHEN '2' THEN 'long' ELSE 'all' END AS tenancy,
               {_num("loyer_median")} AS rent_m2_median,
               {_num("loyer_1_decile")} AS rent_m2_d1,
               {_num("loyer_9_decile")} AS rent_m2_d9,
               {_num("loyer_mensuel_median")} AS rent_monthly_median,
               {_num("surface_moyenne")} AS surface_mean,
               TRY_CAST(nombre_observations AS INTEGER) AS n_obs
        FROM oll_raw WHERE NOT ({skip}) AND {_num("loyer_median")} IS NOT NULL
        -- some files repeat a cell (with and without Type_habitat filled in): keep the best-observed row
        QUALIFY row_number() OVER (PARTITION BY agglo_code, year, property_type, rooms, period_built, tenancy
                                   ORDER BY n_obs DESC NULLS LAST, rent_m2_median) = 1
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE oll_commune AS
        WITH located AS (
            SELECT m.code_commune, m.code_arrondissement, z.agglo_code
            FROM read_csv('{zones_csv.as_posix()}', header = true, all_varchar = true) z
            JOIN commune_map m ON m.code = z.code_commune
        )
        SELECT DISTINCT 'commune' AS geo_level, code_commune AS geo_code, agglo_code FROM located
        UNION
        SELECT DISTINCT 'arrondissement', code_arrondissement, agglo_code FROM located
        WHERE code_arrondissement IS NOT NULL
        """
    )


def last_skipped(con: duckdb.DuckDBPyConnection) -> int:
    return con.execute("SELECT n FROM oll_skipped").fetchone()[0]


def export_published(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    con.execute(f"COPY (SELECT * FROM kpi_rent_oll ORDER BY ALL) TO '{dest.as_posix()}' (FORMAT parquet)")
    return con.execute("SELECT count(*) FROM kpi_rent_oll").fetchone()[0]
