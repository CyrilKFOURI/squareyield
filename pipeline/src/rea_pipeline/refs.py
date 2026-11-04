"""S0: commune reference table mapping any historical or sub-commune code to its current commune,
and the communes under rent control."""
import json
import re
import unicodedata
from pathlib import Path

import duckdb

# DVF publishes no data for Alsace-Moselle and Mayotte (Livre foncier regime).
NO_DATA_DEPARTEMENTS = ("57", "67", "68", "976")


def build_commune_map(con: duckdb.DuckDBPyConnection, communes_json: Path) -> None:
    """Create table commune_map(code, code_commune, code_arrondissement, nom, departement, region).

    - commune-actuelle -> itself
    - commune-deleguee / commune-associee -> its chefLieu (merged communes)
    - arrondissement-municipal (Paris/Lyon/Marseille) -> parent commune, own code kept
      as code_arrondissement
    """
    con.execute(
        f"""
        CREATE OR REPLACE TABLE commune_map AS
        SELECT
            code,
            CASE type
                WHEN 'commune-actuelle' THEN code
                WHEN 'arrondissement-municipal' THEN commune
                ELSE chefLieu
            END AS code_commune,
            CASE WHEN type = 'arrondissement-municipal' THEN code END AS code_arrondissement,
            nom,
            departement,
            region
        FROM read_json_auto('{communes_json.as_posix()}')
        -- a merged commune's chef-lieu keeps its code as both actuelle and deleguee:
        -- keep one row per code, current commune first
        QUALIFY row_number() OVER (
            PARTITION BY code ORDER BY type <> 'commune-actuelle', type <> 'arrondissement-municipal'
        ) = 1
        """
    )


RENT_CONTROL_CONFIG = Path(__file__).resolve().parents[2] / "config" / "rent_control.json"


def _normalize(name: str) -> str:
    ascii_name = unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", ascii_name).strip()


def build_rent_control(con: duckdb.DuckDBPyConnection, config_path: Path = RENT_CONTROL_CONFIG) -> int:
    """Create table rent_control(code) with every commune and arrondissement under rent control
    (encadrement des loyers, M16). The config lists names by département (checked yearly); names are
    resolved to INSEE codes here and an unknown name fails the run rather than being skipped."""
    config = json.loads(config_path.read_text(encoding="utf-8"))
    rows = con.execute(
        "SELECT code, code_commune, nom, departement FROM commune_map"
    ).fetchall()
    by_name: dict[tuple[str, str], str] = {}
    for code, code_commune, nom, departement in rows:
        by_name.setdefault((_normalize(nom), departement), code_commune)
    codes = set()
    for commune in config["communes"]:
        key = (_normalize(commune["name"]), commune["departement"])
        if key not in by_name:
            raise ValueError(f"rent_control.json: unknown commune {commune}")
        codes.add(by_name[key])
    con.execute("CREATE OR REPLACE TABLE rent_control (code VARCHAR)")
    con.executemany("INSERT INTO rent_control VALUES (?)", [[c] for c in sorted(codes)])
    # Paris, Lyon, Marseille: the arrondissements of a controlled city are controlled too
    con.execute(
        """INSERT INTO rent_control
           SELECT code_arrondissement FROM commune_map
           WHERE code_arrondissement IS NOT NULL AND code_commune IN (SELECT code FROM rent_control)"""
    )
    return con.execute("SELECT count(*) FROM rent_control").fetchone()[0]
