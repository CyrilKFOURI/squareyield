"""Property tax rate from the REI (M15)."""
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import localtax

HEADER = "DEP;DIR;COM;LIBCOM;E11;E12;E22;E32;E52;E52gGEMAPI;E52TASA"


@pytest.fixture
def con(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    csv = tmp_path / "REI.csv"
    # Paris: commune rate only (+ TSE, GEMAPI); Angers: commune + intercommunality; empty cells = 0
    csv.write_bytes("\n".join([
        HEADER,
        "75;0;056;VILLE DE PARIS;1000;20.50000;0.00000;0.00000;0.22100;0.14300;",
        "49;0;007;ANGERS;500;54.24000;0.00000;2.18000;0.00000;0.23300;",
        "971;0;01;LES ABYMES;50;30.00000;;1.00000;;;",
        # merged commune listed under its current code too: that row wins
        "49;0;002;OLD ANGERS PART;10;10.00000;;;;;",
        # a commune merged from two old codes absent under the new code: base-weighted
        "01;0;998;OLD A;100;20.00000;;;;;",
        "01;0;997;OLD B;300;40.00000;;;;;",
    ]).encode("latin-1"))
    connection = duckdb.connect()
    connection.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES
               ('75056', '75056', NULL), ('75101', '75056', '75101'), ('49007', '49007', NULL),
               ('97101', '97101', NULL), ('49002', '49007', NULL), ('01998', '01999', NULL),
               ('01997', '01999', NULL), ('01999', '01999', NULL)) t(code, code_commune, code_arrondissement)"""
    )
    localtax.build_local_tax_kpis(connection, csv, 2025)
    return connection


def rate(con, level, code):
    return con.execute(
        "SELECT tfpb_rate FROM kpi_local_tax WHERE geo_level = ? AND geo_code = ?", [level, code]
    ).fetchone()[0]


def test_global_rate_sums_every_levy(con):
    assert rate(con, "commune", "75056") == pytest.approx(0.20864)
    assert rate(con, "commune", "49007") == pytest.approx(0.56653)


def test_merged_commune_rate_prefers_current_code(con):
    assert rate(con, "commune", "49007") == pytest.approx(0.56653)


def test_merged_commune_without_current_code_is_base_weighted(con):
    assert rate(con, "commune", "01999") == pytest.approx((100 * 0.20 + 300 * 0.40) / 400)


def test_overseas_code_and_arrondissements(con):
    assert rate(con, "commune", "97101") == pytest.approx(0.31)
    assert rate(con, "arrondissement", "75101") == rate(con, "commune", "75056")
