"""Local sale-by-sale file for the sales map and sale sheets (docs/features/019-sales-map/spec.md, "Data").

data/local/sales.parquet: one row per sale of data/clean/dvf/sales.parquet (same id, same market rules), plus
its address, lots with Carrez surfaces and the point of its parcel, sorted by commune for the local API.

- Address and lots come from the official DVF rows clean.py reads (same id and parcel expressions).
- Parcel points come from geo-DVF (every year, current or former parcel id); a parcel geo-DVF has never seen
  keeps the section (or commune) point of the cleaned sale; `location_precision` says which.

Individual sales: local use only (DVF rules, decision 016), never published. The price model never reads this
file: it trains on section points only (CLAUDE.md).
"""
import csv
import re
import tempfile
from pathlib import Path

import duckdb

from . import clean

# DVF "Type de voie" codes -> lowercase French street type
STREET_TYPES = {
    "R": "rue", "RUE": "rue", "AV": "avenue", "BD": "boulevard", "PL": "place", "ALL": "allée", "CHE": "chemin",
    "CHEM": "chemin", "IMP": "impasse", "QU": "quai", "QUAI": "quai", "RTE": "route", "SQ": "square",
    "PAS": "passage", "PASS": "passage", "CRS": "cours", "COUR": "cour", "RES": "résidence", "LOT": "lotissement",
    "CITE": "cité", "PROM": "promenade", "FG": "faubourg", "HAM": "hameau", "VLA": "villa", "SEN": "sente",
    "MAIL": "mail", "ESP": "esplanade", "PARC": "parc", "CLOS": "clos", "VOIE": "voie", "TRA": "traverse",
    "MTE": "montée", "RLE": "ruelle", "GR": "grande rue", "DOM": "domaine", "COTE": "côte", "CHS": "chaussée",
    "QUA": "quartier", "RPT": "rond-point", "CR": "chemin rural", "VC": "voie communale", "TSSE": "terrasse",
    "VEN": "venelle", "CAR": "carrefour", "GAL": "galerie", "ESPA": "espace", "PONT": "pont", "PORT": "port",
    "ZA": "zone d'activité", "ZAC": "ZAC", "ZI": "zone industrielle", "CTRE": "centre", "PTR": "petite rue",
    "PCH": "petit chemin", "COR": "corniche", "CD": "chemin départemental", "GPL": "grande place",
    "PRV": "parvis", "ROC": "rocade", "PLAN": "plan", "VALL": "vallée", "VAL": "val", "DIG": "digue",
    "TOUR": "tour", "JARD": "jardin", "RIVE": "rive", "PLA": "plateau", "ENC": "enclos",
}
STREET_SUFFIXES = {"B": "bis", "T": "ter", "Q": "quater"}
PREPOSITIONS = {"de", "du", "des", "et", "en", "au", "aux", "sur", "sous", "les"}
ARTICLES = {"le", "la", "les"}
ELISIONS = {"d", "l"}
SAINTS = {"ST": "SAINT", "STE": "SAINTE"}
ROMAN = re.compile(r"^X{0,3}(IX|IV|V?I{0,3})$")


def _capitalise(word: str) -> str:
    if len(word) >= 2 and ROMAN.match(word):
        return word  # Louis XIV
    return "-".join(part[:1].upper() + part[1:].lower() for part in word.split("-"))


def _title(name: str, first_is_start: bool) -> str:
    """'DE L INTENDANCE' -> "de l'Intendance", 'SAINT LOUIS' -> 'Saint-Louis', 'LE ROUZIC' -> 'Le Rouzic'."""
    words = [SAINTS.get(w, w) for w in name.split()]
    out: list[str] = []
    i = 0
    while i < len(words):
        lower = words[i].lower()
        at_start = first_is_start and not out
        previous = out[-1].lower() if out else None
        if lower in ELISIONS and i + 1 < len(words):
            elided = (lower.upper() if at_start else lower) + "'" + _capitalise(words[i + 1])
            out.append(elided)
            i += 2
            continue
        if lower in ("saint", "sainte") and i + 1 < len(words) and words[i + 1].lower() not in PREPOSITIONS | ELISIONS:
            out.append(_capitalise(words[i]) + "-" + _capitalise(words[i + 1]))
            i += 2
            continue
        if lower in ARTICLES and previous not in PREPOSITIONS:
            out.append(_capitalise(words[i]))  # rue Le Rouzic, but rue de la Paix
        elif lower in PREPOSITIONS | ARTICLES and not at_start:
            out.append(lower)
        else:
            out.append(_capitalise(words[i]))
        i += 1
    return " ".join(out)


def format_street(street_type: str | None, street: str | None) -> str | None:
    """Official DVF 'Type de voie' + 'Voie' -> 'cours Saint-Louis' (type lowercase, names capitalised)."""
    if not street or not street.strip():
        return None
    code = (street_type or "").strip().upper()
    kind = STREET_TYPES.get(code, code.lower()) if code else ""
    name = _title(street.strip().upper(), first_is_start=not kind)
    return f"{kind} {name}" if kind else name


def format_number(number: str | None, suffix: str | None) -> str | None:
    """'108' + 'B' -> '108 bis'; other suffix letters stick to the number ('15A')."""
    digits = (number or "").strip().lstrip("0")
    if not digits:
        return None
    letter = (suffix or "").strip().upper()
    if letter in STREET_SUFFIXES:
        return f"{digits} {STREET_SUFFIXES[letter]}"
    return digits + letter


def _load_address_rows(con: duckdb.DuckDBPyConnection, dvf_files: list[Path]) -> None:
    """Dwelling rows of the official files that belong to a cleaned sale, on the sale's own parcel."""
    dwellings = ", ".join(f"'{t}'" for t in clean.DWELLING_TYPES)
    natures = ", ".join("'" + n.replace("'", "''") + "'" for n in clean.SALE_NATURES)
    lots = ",\n".join(
        f'"{rank} lot" AS lot{i}, {clean._decimal(f"Surface Carrez du {rank} lot")} AS carrez{i}'
        for i, rank in enumerate(("1er", "2eme", "3eme", "4eme", "5eme"), start=1)
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE local_rows AS
        WITH raw AS (
            SELECT {clean.MUTATION_ID} AS id_mutation, {clean.PARCEL} AS id_parcelle,
                   "No voie" AS address_number, "B/T/Q" AS address_suffix, "Type de voie" AS street_type,
                   "Code voie" AS street_code, "Voie" AS street_name, "Code postal" AS postcode,
                   {lots}
            FROM {clean.read_official(dvf_files)}
            WHERE "Nature mutation" IN ({natures}) AND "Type local" IN ({dwellings})
        )
        SELECT raw.* FROM raw
        JOIN dvf_sales s ON s.id_mutation = raw.id_mutation AND s.id_parcelle = raw.id_parcelle
        """
    )


def _build_address_and_lots(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE OR REPLACE TEMP TABLE local_address AS
        SELECT id_mutation,
               first(struct_pack(address_number, address_suffix, street_type, street_code, street_name,
                                 postcode := lpad(postcode, 5, '0'))
                     ORDER BY street_name IS NULL, address_number IS NULL, address_number, street_name) AS addr,
               first(lot1 ORDER BY lot1 IS NULL, lot1) AS first_lot
        FROM local_rows GROUP BY id_mutation
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE local_lots AS
        WITH unpacked AS (
            {" UNION ALL ".join(f"SELECT id_mutation, {i} AS pos, lot{i} AS number, carrez{i} AS carrez FROM local_rows"
                                for i in range(1, 6))}
        ),
        per_lot AS (
            SELECT id_mutation, number, min(pos) AS pos, max(carrez) AS carrez
            FROM unpacked WHERE number IS NOT NULL AND trim(number) <> '' GROUP BY id_mutation, number
        )
        SELECT id_mutation, list(struct_pack(number, carrez) ORDER BY pos, number) AS lots
        FROM per_lot GROUP BY id_mutation
        """
    )
    # title-case each distinct street and number once, in Python
    _label_table(con, "local_street", ("street_type", "street_name"), "street", format_street)
    _label_table(con, "local_number", ("address_number", "address_suffix"), "number_label", format_number)


def _label_table(con: duckdb.DuckDBPyConnection, table: str, keys: tuple[str, str], label: str, fn) -> None:
    """Create `table`(keys..., label) from the distinct address keys, labelled by a Python function.
    Through a CSV file: the pipeline has no numpy for DuckDB Python functions."""
    pairs = con.execute(f"SELECT DISTINCT addr.{keys[0]}, addr.{keys[1]} FROM local_address").fetchall()
    with tempfile.TemporaryDirectory() as work:
        path = Path(work) / f"{table}.csv"
        with path.open("w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow([*keys, label])
            writer.writerows([a, b, fn(a, b)] for a, b in pairs)
        con.execute(
            f"""CREATE OR REPLACE TEMP TABLE {table} AS
                SELECT * FROM read_csv('{path.as_posix()}', header = true, all_varchar = true, delim = ',',
                                       quote = '"', escape = '"')"""
        )


def _build_parcel_points(con: duckdb.DuckDBPyConnection, geo_files: list[Path]) -> None:
    """Mean point of every parcel of a cleaned sale, by current or former geo-DVF parcel id."""
    file_list = ", ".join(f"'{f.as_posix()}'" for f in geo_files)
    con.execute(
        f"""
        CREATE OR REPLACE TEMP TABLE local_parcel AS
        WITH geo AS (
            SELECT id_parcelle, ancien_id_parcelle,
                   TRY_CAST(longitude AS DOUBLE) AS longitude, TRY_CAST(latitude AS DOUBLE) AS latitude
            FROM read_csv([{file_list}], header = true, all_varchar = true, union_by_name = true,
                          delim = ',', quote = '"', escape = '"')
        ),
        keyed AS (
            SELECT id_parcelle AS id, longitude, latitude FROM geo
            UNION ALL
            SELECT ancien_id_parcelle AS id, longitude, latitude FROM geo
            WHERE ancien_id_parcelle IS NOT NULL AND ancien_id_parcelle <> ''
        )
        SELECT id AS id_parcelle, avg(longitude) AS longitude, avg(latitude) AS latitude
        FROM keyed
        WHERE longitude IS NOT NULL AND latitude IS NOT NULL
          AND id IN (SELECT id_parcelle FROM dvf_sales)
        GROUP BY id
        """
    )


def build(con: duckdb.DuckDBPyConnection, dvf_files: list[Path], geo_files: list[Path], dest: Path) -> int:
    """Write dest from table dvf_sales (cleaned sales), commune_map, the official DVF and geo-DVF files.
    Returns the number of sales written."""
    _load_address_rows(con, dvf_files)
    _build_address_and_lots(con)
    _build_parcel_points(con, geo_files)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.stem + ".next.parquet")
    con.execute(
        f"""
        COPY (
            SELECT s.* EXCLUDE (longitude, latitude, location_precision),
                   ad.addr.address_number, ad.addr.address_suffix, ad.addr.street_type, ad.addr.street_code,
                   ad.addr.street_name, ad.addr.postcode,
                   st.street,
                   CASE WHEN st.street IS NULL THEN NULL
                        WHEN n.number_label IS NULL THEN st.street
                        ELSE n.number_label || ' ' || st.street END AS address,
                   coalesce(l.lots, []) AS lots,
                   ad.first_lot,
                   coalesce(p.longitude, s.longitude) AS longitude,
                   coalesce(p.latitude, s.latitude) AS latitude,
                   CASE WHEN p.id_parcelle IS NOT NULL THEN 'parcel' ELSE s.location_precision END
                       AS location_precision,
                   cm.nom AS commune_name,
                   am.nom AS arrondissement_name
            FROM dvf_sales s
            LEFT JOIN local_address ad USING (id_mutation)
            LEFT JOIN local_street st ON st.street_type IS NOT DISTINCT FROM ad.addr.street_type
                                      AND st.street_name IS NOT DISTINCT FROM ad.addr.street_name
            LEFT JOIN local_number n ON n.address_number IS NOT DISTINCT FROM ad.addr.address_number
                                     AND n.address_suffix IS NOT DISTINCT FROM ad.addr.address_suffix
            LEFT JOIN local_lots l USING (id_mutation)
            LEFT JOIN local_parcel p ON p.id_parcelle = s.id_parcelle
            LEFT JOIN commune_map cm ON cm.code = s.code_commune
            LEFT JOIN commune_map am ON am.code = s.code_arrondissement
            ORDER BY s.code_commune, s.code_arrondissement NULLS FIRST, s.id_parcelle, s.date_mutation, s.id_mutation
        ) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 16384)
        """
    )
    tmp.replace(dest)
    for table in ("local_rows", "local_address", "local_lots", "local_street", "local_number", "local_parcel"):
        con.execute(f"DROP TABLE IF EXISTS {table}")
    return con.execute(f"SELECT count(*) FROM '{dest.as_posix()}'").fetchone()[0]
