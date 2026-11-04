"""DPE shares per geo level (M14)."""
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import dpe


def test_shares_per_level_and_merged_communes(tmp_path: Path):
    counts = tmp_path / "counts.csv"
    counts.write_text("code,type,label,n\n49007,appartement,C,60\n49007,appartement,F,30\n49007,appartement,G,10\n"
                      "49002,appartement,G,100\n49099,appartement,X,5\n", encoding="utf-8")
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES
               ('49007', '49007', NULL, '49', '52'), ('49002', '49007', NULL, '49', '52'))
           t(code, code_commune, code_arrondissement, departement, region)"""
    )
    dpe.build_dpe_kpis(con, counts)
    n, share_fg, share_g = con.execute(
        "SELECT n_dpe, share_fg, share_g FROM kpi_dpe WHERE geo_level = 'commune' AND geo_code = '49007' "
        "AND property_type = 'all'"
    ).fetchone()
    # merged commune 49002 adds up into 49007; unknown commune and invalid label are ignored
    assert n == 200 and share_fg == pytest.approx(0.7) and share_g == pytest.approx(0.55)
    assert con.execute(
        "SELECT n_dpe FROM kpi_dpe WHERE geo_level = 'france' AND property_type = 'all'").fetchone()[0] == 200


def test_shares_by_type(tmp_path: Path):
    counts = tmp_path / "counts.csv"
    counts.write_text(
        "code,type,label,n\n49007,appartement,C,60\n49007,appartement,F,40\n"
        "49007,maison,G,50\n49007,maison,C,50\n49007,immeuble,E,10\n", encoding="utf-8")
    con = duckdb.connect()
    con.execute(
        """CREATE TABLE commune_map AS SELECT * FROM (VALUES ('49007', '49007', NULL, '49', '52'))
           t(code, code_commune, code_arrondissement, departement, region)"""
    )
    dpe.build_dpe_kpis(con, counts)
    shares = dict(con.execute(
        "SELECT property_type, share_fg FROM kpi_dpe WHERE geo_level = 'commune' AND geo_code = '49007'"
    ).fetchall())
    assert shares["apartment"] == pytest.approx(0.4) and shares["house"] == pytest.approx(0.5)
    # whole-building certificates only count in "all"
    assert con.execute(
        "SELECT n_dpe FROM kpi_dpe WHERE geo_code = '49007' AND geo_level = 'commune' AND property_type = 'all'"
    ).fetchone()[0] == 210
