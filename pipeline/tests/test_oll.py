"""OLL rents in place (docs/features/013-comparable-segments/spec.md §2.4)."""
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import oll

NATIONAL_HEADER = (
    "Observatory;Data_year;agglomeration;Zone_complementaire;Type_habitat;epoque_construction_homogene;"
    "anciennete_locataire_homogene;nombre_pieces_homogene;loyer_1_decile;loyer_1_quartile;loyer_median;"
    "loyer_3_quartile;loyer_9_decile;loyer_moyen;loyer_mensuel_1_decile;loyer_mensuel_1_quartile;"
    "loyer_mensuel_median;loyer_mensuel_3_quartile;loyer_mensuel_9_decile;moyenne_loyer_mensuel;"
    "surface_moyenne;nombre_observations;nombre_logements;methodologie_production"
)


def nat(obs, year, agglo, zone="", habitat="", period="", tenancy="", rooms="", median="12,0", n="500"):
    return (f"{obs};{year};{agglo};{zone};{habitat};{period};{tenancy};{rooms};9,1;10,3;{median};14,3;17,8;11,7;"
            f"430;510;615;753;975;671;57;{n};;Estimation directe")


ROWS_2025 = [
    nat("B3500", 2025, "Agglomération de Rennes", n="17534"),
    nat("B3500", 2025, "Agglomération de Rennes", rooms="Appart 2P", median="13,5", n="4000"),
    # the same cell repeated with the habitat column filled in
    nat("B3500", 2025, "Agglomération de Rennes", habitat="Appartement", rooms="Appart 2P", median="13,5", n="4000"),
    nat("B3500", 2025, "Agglomération de Rennes", rooms="Maison 1-3P", median="9,6", n="106"),
    nat("B3500", 2025, "Agglomération de Rennes", rooms="Ensemble 4P+", median="9,9", n="2210"),
    # older files spell the open bucket "4P et plus"
    nat("B3500", 2025, "Agglomération de Rennes", rooms="Appart 4P et plus", median="9,2", n="900"),
    nat("B3500", 2025, "Agglomération de Rennes", habitat="Appartement", period="1. Avant 1946", median="14,0"),
    nat("B3500", 2025, "Agglomération de Rennes", habitat="Appartement", tenancy="1. Moins de 1 an", median="14,8"),
    # centre / outskirts split: not used (agglomeration-wide figures only)
    nat("B3500", 2025, "Agglomération de Rennes", zone="Ville centre", median="13,0"),
    # Paris zones coded in a dimension column: skipped and counted
    nat("B7500", 2025, "L7500", period="L7501.4.1", median="25,0"),
    nat("B3500", 2025, "Agglomération de Vitré", n="900"),
]
ROWS_2024 = [nat("B3500", 2024, "Agglomération de Rennes", n="16000", median="11,5")]

# what the per-agglomeration zips say: code, observatory, observations of the agglomeration-wide row
LOCAL_FINGERPRINTS = [("L3500", "B3500", 2025, 17534), ("L3501", "B3500", 2025, 900)]
ZONING = [("L3500", "35238"), ("L3500", "35051"), ("L3501", "35360")]


def _write(path: Path, header: str, rows: list[str]) -> None:
    path.write_bytes("\r\n".join([header, *rows]).encode("cp1252"))


@pytest.fixture
def con(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    national = tmp_path / "national"
    national.mkdir()
    _write(national / "Base_OP_2025_Nationale.csv", NATIONAL_HEADER, ROWS_2025)
    _write(national / "Base_OP_2024_Nationale.csv", NATIONAL_HEADER, ROWS_2024)
    zones = tmp_path / "zones.csv"
    names = oll.match_agglomerations(national / "Base_OP_2025_Nationale.csv", LOCAL_FINGERPRINTS)
    oll.write_zones(zones, names, ZONING)
    connection = duckdb.connect()
    connection.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES
               ('35238', '35238', NULL, '35', '53'), ('35051', '35051', NULL, '35', '53'),
               ('35360', '35360', NULL, '35', '53')) t(code, code_commune, code_arrondissement, departement, region)"""
    )
    oll.build_oll_kpis(connection, national, zones)
    return connection


def _rent(con, agglo, year=2025, ptype="all", rooms="all", period="all", tenancy="all"):
    row = con.execute(
        """SELECT rent_m2_median, n_obs FROM kpi_rent_oll WHERE agglo_code = ? AND year = ? AND property_type = ?
           AND rooms = ? AND period_built = ? AND tenancy = ?""",
        [agglo, year, ptype, rooms, period, tenancy],
    ).fetchone()
    return row


def test_fingerprint_matching(tmp_path):
    national = tmp_path / "n.csv"
    _write(national, NATIONAL_HEADER, ROWS_2025)
    assert oll.match_agglomerations(national, LOCAL_FINGERPRINTS) == {
        "Agglomération de Rennes": "L3500", "Agglomération de Vitré": "L3501"}


def test_one_row_per_cell(con):
    dupes = con.execute(
        """SELECT count(*) FROM (SELECT agglo_code, year, property_type, rooms, period_built, tenancy
           FROM kpi_rent_oll GROUP BY ALL HAVING count(*) > 1)"""
    ).fetchone()[0]
    assert dupes == 0


def test_dimensions_parsed(con):
    assert _rent(con, "L3500") == (12.0, 17534)
    assert _rent(con, "L3500", ptype="apartment", rooms="2")[0] == 13.5
    assert _rent(con, "L3500", ptype="house", rooms="1-3")[0] == 9.6
    assert _rent(con, "L3500", rooms="4+")[0] == 9.9
    assert _rent(con, "L3500", ptype="apartment", rooms="4+")[0] == 9.2
    assert _rent(con, "L3500", ptype="apartment", period="<1946")[0] == 14.0
    assert _rent(con, "L3500", ptype="apartment", tenancy="new")[0] == 14.8


def test_yearly_series_by_name(con):
    # 2024 has no fingerprint of its own: the 2025 name → code match applies
    assert _rent(con, "L3500", year=2024)[0] == 11.5


def test_centre_and_zone_rows_skipped(con):
    assert con.execute("SELECT count(*) FROM kpi_rent_oll WHERE rent_m2_median IN (13.0, 25.0)").fetchone()[0] == 0
    assert oll.last_skipped(con) >= 1


def test_communes_attached(con):
    rows = dict(con.execute("SELECT geo_code, agglo_code FROM oll_commune WHERE geo_level = 'commune'").fetchall())
    assert rows == {"35238": "L3500", "35051": "L3500", "35360": "L3501"}


@pytest.mark.parametrize("raw", [
    "Commune;Lib_com;Iris;Zone\r\n35238;Rennes;101;1".encode("cp1252"),
    "INSEE;LIBCOM;IRIS;ZONE;LIB_ZONE\r\n35238;Rennes;101;1;A".encode("cp1252"),
    "code_insee;lib_com;code_iris;zone;lib_zone\r\n35238;Rennes;101;1;A".encode("cp1252"),
    "\ufeffINSEE;Lib_com;Iris;Zone;Lib_zone\r\n35238;Rennés;101;1;A".encode("utf-8"),
])
def test_zoning_header_variants(raw):
    assert oll.zoning_rows("L3500", raw) == [("L3500", "35238")]


def test_match_uses_the_national_file_of_each_zip_year(tmp_path):
    directory = tmp_path / "national"
    directory.mkdir()
    _write(directory / "Base_OP_2025_Nationale.csv", NATIONAL_HEADER, ROWS_2025)
    _write(directory / "Base_OP_2024_Nationale.csv", NATIONAL_HEADER, ROWS_2024)
    # Rennes only has a 2024 zip: matched on the 2024 national figures
    names = oll.match_all(directory, [("L3500", "B3500", 2024, 16000), ("L3501", "B3500", 2025, 900)])
    assert names == {"Agglomération de Rennes": "L3500", "Agglomération de Vitré": "L3501"}


def test_zoning_in_an_unexpected_encoding():
    raw = b"Commune;Lib_com;Iris;Zone\r\n35238;Renn\x8fs;101;1"
    assert oll.zoning_rows("L3500", raw) == [("L3500", "35238")]


@pytest.mark.parametrize("code,ok", [("L3500", True), ("L2A00", True), ("../x", False), ("L35/0", False), ("L350", False)])
def test_agglomeration_code_pattern(code, ok):
    assert oll.is_agglomeration_code(code) is ok


def test_zones_reject_unsafe_codes(tmp_path):
    dest = tmp_path / "zones.csv"
    oll.write_zones(dest, {"Rennes": "L3500", "Evil": "../../x"}, [("L3500", "35238"), ("../../x", "35051")])
    assert "../" not in dest.read_text(encoding="utf-8")
