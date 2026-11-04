"""S2: DVF cleaning (docs/PIPELINE_RUN_SPEC.md §3).

Output table dvf_sales: one row per kept mutation = one single-dwelling residential sale,
with the characteristics the price model needs (docs/features/011-price-check-ml/spec.md §3).
"""
from pathlib import Path

import duckdb

from .geo import SECTION_KEY_LENGTH

DWELLING_TYPES = ("Appartement", "Maison")
SALE_NATURES = {"Vente": False, "Vente en l'état futur d'achèvement": True}  # nature -> is_new_build
MIN_SURFACE_M2 = 9
MIN_PRICE_EUR = 1_000
# Kept for the price model but left out of market cells (docs/research/segmentation_study.md §4.2):
# an estate's price is mostly land, a flat with many outbuildings is not a bare flat.
# 5 ha: in rural départements (Gers, Lot, Creuse) a fifth of houses stand on more than 5 000 m²,
# so a lower cap would remove the normal market there; at 5 ha no département loses 3 % (2026-10-21).
MAX_HOUSE_LAND_M2 = 50_000
MAX_OUTBUILDINGS = 2


def _decimal(column: str) -> str:
    return f"TRY_CAST(replace(\"{column}\", ',', '.') AS DOUBLE)"


def load_raw(con: duckdb.DuckDBPyConnection, files: list[Path]) -> None:
    """Load official DVF files (data.gouv.fr 'ValeursFoncieres-*.txt') into table dvf_raw.

    The official format has no mutation id, unpadded commune codes, French decimals
    ("130000,00") and dd/mm/yyyy dates; this normalises them.
    """
    file_list = ", ".join(f"'{f.as_posix()}'" for f in files)
    commune = (
        '"Code departement" || lpad("Code commune", CAST(5 - length("Code departement") AS INTEGER), \'0\')'
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE dvf_raw AS
        SELECT
            -- no id in the official files: every row of a sale shares these fields
            md5(concat_ws('|', "Date mutation", "Nature mutation", "Valeur fonciere",
                          "Code departement", "Code commune", "No disposition")) AS id_mutation,
            TRY_CAST(strptime("Date mutation", '%d/%m/%Y') AS DATE) AS date_mutation,
            "Nature mutation" AS nature_mutation,
            {_decimal("Valeur fonciere")} AS valeur_fonciere,
            {commune} AS code_commune,
            {commune} || lpad(coalesce("Prefixe de section", ''), 3, '0')
                || lpad("Section", 2, '0') || lpad("No plan", 4, '0') AS id_parcelle,
            "1er lot" AS lot_1,
            "Type local" AS type_local,
            {_decimal("Surface reelle bati")} AS surface_reelle_bati,
            {_decimal("Surface Carrez du 1er lot")} AS surface_carrez,
            TRY_CAST("Nombre pieces principales" AS DOUBLE) AS nombre_pieces_principales,
            TRY_CAST("Nombre de lots" AS INTEGER) AS nombre_lots,
            "Nature culture" AS nature_culture,
            {_decimal("Surface terrain")} AS surface_terrain
        FROM read_csv([{file_list}], header = true, all_varchar = true, union_by_name = true,
                      delim = '|', quote = '')
        """
    )


def build_sales(con: duckdb.DuckDBPyConnection) -> None:
    """Create table dvf_sales from dvf_raw + commune_map + section_point + commune_point."""
    dwellings = ", ".join(f"'{t}'" for t in DWELLING_TYPES)
    natures = ", ".join("'" + n.replace("'", "''") + "'" for n in SALE_NATURES)
    new_build = " ".join(
        "WHEN '" + n.replace("'", "''") + f"' THEN {str(v).lower()}" for n, v in SALE_NATURES.items()
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE dvf_sales AS
        WITH sales_rows AS (
            SELECT * FROM dvf_raw WHERE nature_mutation IN ({natures})
        ),
        -- land: rows repeat per premises, so count each (parcel, land type, surface) once
        land AS (
            SELECT id_mutation, sum(surface_terrain) AS land_m2
            FROM (SELECT DISTINCT id_mutation, id_parcelle, nature_culture, surface_terrain
                  FROM sales_rows WHERE surface_terrain > 0)
            GROUP BY id_mutation
        ),
        per_mutation AS (
            SELECT
                id_mutation,
                min(date_mutation) AS date_mutation,
                any_value(CASE nature_mutation {new_build} END) AS is_new_build,
                -- the sale price is repeated on every row of a mutation: take it once
                min(valeur_fonciere) AS price,
                max(valeur_fonciere) AS price_max,
                count(DISTINCT code_commune) AS n_communes,
                -- rows repeat per parcel/lot: count distinct dwellings, not rows. Flats are told
                -- apart by their lot too (two identical flats sold together are two dwellings);
                -- a house has no lot and repeats once per parcel.
                count(DISTINCT CASE WHEN type_local IN ({dwellings})
                      THEN concat_ws('|', type_local, surface_reelle_bati, nombre_pieces_principales,
                                     CASE WHEN type_local = 'Appartement' THEN nullif(lot_1, '') END)
                      END) AS n_dwellings,
                count(*) FILTER (WHERE type_local IS NOT NULL
                                 AND type_local NOT IN ({dwellings}, 'Dépendance')) AS n_other_premises,
                count(DISTINCT CASE WHEN type_local = 'Dépendance'
                      THEN concat_ws('|', id_parcelle, lot_1) END) AS n_dependencies,
                any_value(type_local) FILTER (WHERE type_local IN ({dwellings})) AS property_type,
                max(surface_reelle_bati) FILTER (WHERE type_local IN ({dwellings})) AS surface_m2,
                max(surface_carrez) FILTER (WHERE type_local IN ({dwellings})) AS surface_carrez_m2,
                max(nombre_pieces_principales) FILTER (WHERE type_local IN ({dwellings})) AS rooms,
                max(nombre_lots) AS n_lots,
                any_value(id_parcelle) FILTER (WHERE type_local IN ({dwellings})) AS id_parcelle,
                any_value(code_commune) AS code_commune_raw
            FROM sales_rows
            GROUP BY id_mutation
        )
        SELECT
            m.id_mutation,
            m.date_mutation,
            year(m.date_mutation) AS year,
            CASE WHEN month(m.date_mutation) <= 6 THEN 1 ELSE 2 END AS half,
            m.is_new_build,
            m.price,
            m.surface_m2,
            m.price / m.surface_m2 AS price_m2,
            CASE m.property_type WHEN 'Appartement' THEN 'apartment' ELSE 'house' END AS property_type,
            CAST(m.rooms AS INTEGER) AS rooms,
            m.surface_carrez_m2,
            coalesce(l.land_m2, 0) AS land_m2,
            m.n_dependencies,
            m.n_lots,
            m.id_parcelle,
            left(m.id_parcelle, {SECTION_KEY_LENGTH}) AS section,
            coalesce(c.code_commune, m.code_commune_raw) AS code_commune,
            c.code_arrondissement,
            CASE WHEN m.code_commune_raw LIKE '97%' THEN left(m.code_commune_raw, 3)
                 ELSE left(m.code_commune_raw, 2) END AS code_departement,
            c.region AS code_region,
            -- section point for every sale (see geo.py), commune point as fallback
            coalesce(s.longitude, cp.longitude) AS longitude,
            coalesce(s.latitude, cp.latitude) AS latitude,
            CASE WHEN s.section IS NOT NULL THEN 'section'
                 WHEN cp.code IS NOT NULL THEN 'commune' END AS location_precision,
            CASE WHEN m.property_type = 'Maison' AND coalesce(l.land_m2, 0) > {MAX_HOUSE_LAND_M2} THEN 'large_land'
                 WHEN m.n_dependencies > {MAX_OUTBUILDINGS} THEN 'outbuildings' END AS market_excluded
        FROM per_mutation m
        LEFT JOIN commune_map c ON c.code = m.code_commune_raw
        LEFT JOIN land l USING (id_mutation)
        LEFT JOIN section_point s ON s.section = left(m.id_parcelle, {SECTION_KEY_LENGTH})
        LEFT JOIN commune_point cp ON cp.code = m.code_commune_raw
        WHERE m.n_dwellings = 1
          AND m.n_other_premises = 0
          AND m.n_communes = 1
          AND m.price = m.price_max
          AND m.surface_m2 >= {MIN_SURFACE_M2}
          AND m.price >= {MIN_PRICE_EUR}
        """
    )


def export(con: duckdb.DuckDBPyConnection, dest: Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    con.execute(f"COPY dvf_sales TO '{dest.as_posix()}' (FORMAT parquet, COMPRESSION zstd)")
    return con.execute("SELECT count(*) FROM dvf_sales").fetchone()[0]
