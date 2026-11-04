"""INSEE comparateur reshaping and socio KPIs (docs/KPI_SPEC.md M11–M13)."""
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import insee

HEADER = "GEO_REF;GEO_OBJECT;GEO;TIME_PERIOD;DS;TAB_MEASURE;OBS_VALUE;OBS_STATUS;UNIT_MEASURE;UNIT_MULT;CONF_STATUS"


def line(obj, geo, year, measure, value):
    return f"2026;{obj};{geo};{year};DS;{measure};{value};A;;;"


ROWS = [
    # commune 49007: +1 %/year over 2017→2023, 10 % → 12 % vacancy
    line("COM", "49007", 2017, "POP", 100000),
    line("COM", "49007", 2023, "POP", round(100000 * 1.01 ** 6)),
    line("COM", "49007", 2017, "DWELLINGS", 50000),
    line("COM", "49007", 2017, "DWELLINGS_OCS_DW_VAC", 5000),
    line("COM", "49007", 2023, "DWELLINGS", 60000),
    line("COM", "49007", 2023, "DWELLINGS_OCS_DW_VAC", 7200),
    line("COM", "49007", 2023, "DWELLINGS_OCS_DW_MAIN", 50000),
    line("COM", "49007", 2023, "DWELLINGS_OCS_DW_MAIN_TSH_100", 20000),
    line("COM", "49007", 2023, "MED_SL", 23930),
    # same code at another geo level ("bassin de vie"): must be ignored
    line("BV2022", "49007", 2023, "POP", 999999),
    # France: only the 'F' code is kept, 'FM' (metropolitan) is not
    line("FRANCE", "F", 2023, "POP", 68000000),
    line("FRANCE", "FM", 2023, "POP", 66000000),
    # Filosofi value under statistical secrecy: empty
    line("COM", "01001", 2023, "POP", 800),
    line("COM", "01001", 2023, "MED_SL", ""),
]


@pytest.fixture
def con(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    csv = tmp_path / "comparateur.csv"
    csv.write_text("\n".join([HEADER, *ROWS]), encoding="utf-8")
    connection = duckdb.connect()
    insee.build_socio_kpis(connection, csv, "test")
    return connection


def kpi(con, level, code, column):
    return con.execute(
        f"SELECT {column} FROM kpi_socio WHERE geo_level = ? AND geo_code = ?", [level, code]
    ).fetchone()[0]


def test_geo_level_filtering(con):
    assert kpi(con, "commune", "49007", "population") == round(100000 * 1.01 ** 6)
    assert kpi(con, "france", "FR", "population") == 68000000
    assert con.execute("SELECT count(*) FROM kpi_socio").fetchone()[0] == 3


def test_rates(con):
    assert kpi(con, "commune", "49007", "population_growth_yearly") == pytest.approx(0.01, abs=1e-4)
    assert kpi(con, "commune", "49007", "vacancy_rate") == pytest.approx(0.12)
    assert kpi(con, "commune", "49007", "vacancy_change_pts") == pytest.approx(0.02)
    assert kpi(con, "commune", "49007", "renter_share") == pytest.approx(0.6)


def test_flags(con):
    assert kpi(con, "commune", "49007", "flag_high_vacancy") is True
    assert kpi(con, "commune", "49007", "flag_population_decline") is False


def test_secret_value_is_null(con):
    assert kpi(con, "commune", "01001", "median_living_standard") is None


def test_rental_homes(con):
    # main homes 50 000 − owner homes 20 000
    assert kpi(con, "commune", "49007", "rental_homes") == 30000


STOCK_HEADER = ("CODGEO;P22_LOG;P22_RP;P22_MAISON;P22_APPART;P22_RP_1P;P22_RP_2P;P22_RP_3P;P22_RP_4P;P22_RP_5PP;"
                "P22_RPMAISON;P22_NBPI_RPMAISON;P22_RPAPPART;P22_NBPI_RPAPPART;"
                "P22_RPMAISON_ACH1919;P22_RPMAISON_ACH1945;P22_RPMAISON_ACH1970;P22_RPMAISON_ACH1990;"
                "P22_RPMAISON_ACH2005;P22_RPMAISON_ACH2019;"
                "P22_RPAPPART_ACH1919;P22_RPAPPART_ACH1945;P22_RPAPPART_ACH1970;P22_RPAPPART_ACH1990;"
                "P22_RPAPPART_ACH2005;P22_RPAPPART_ACH2019;P22_RP_LOC;P22_RP_LOCHLMV")


def test_stock_by_type(tmp_path):
    csv = tmp_path / "logement.csv"
    csv.write_text("\n".join([
        STOCK_HEADER,
        # 1000 homes: 200 houses, 800 flats; flats 2.5 rooms on average; 40 % of flats built before 1946
        "49007;1000;900;200;800;100;200;300;200;100;180;900;720;1800;"
        "10;10;40;40;50;30;200;88;100;100;100;132;500;100",
        "49002;100;90;80;20;0;10;20;30;30;72;360;18;54;0;0;10;10;20;32;0;0;0;0;10;8;30;0",
    ]), encoding="utf-8")
    connection = duckdb.connect()
    connection.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES
               ('49007', '49007', NULL, '49', '52'), ('49002', '49002', NULL, '49', '52'))
           t(code, code_commune, code_arrondissement, departement, region)"""
    )
    insee.build_stock_kpis(connection, csv)

    def stock(level, code, column):
        return connection.execute(
            f"SELECT {column} FROM kpi_stock WHERE geo_level = ? AND geo_code = ?", [level, code]
        ).fetchone()[0]

    assert stock("commune", "49007", "share_houses") == pytest.approx(0.2)
    assert stock("commune", "49007", "avg_rooms_apartment") == pytest.approx(2.5)
    assert stock("commune", "49007", "apartments_before_1946_share") == pytest.approx(288 / 720)
    assert stock("commune", "49007", "tenant_share") == pytest.approx(500 / 900)
    assert stock("commune", "49007", "main_homes_5p_share") == pytest.approx(100 / 900)
    # départements add their communes up
    assert stock("departement", "49", "share_houses") == pytest.approx(280 / 1100)
