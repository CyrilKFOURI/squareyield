"""Dashboard precomputes (docs/features/014-web-dashboard/spec.md §6)."""
import json
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import dashboard
from test_publish import _con, _with_extras


def _sales(con: duckdb.DuckDBPyConnection) -> None:
    """Market sales for section points: section 49007000AB has 12 flats, 49007000AC only 4."""
    con.execute(
        """CREATE TABLE dvf_sales (id_mutation VARCHAR, year INTEGER, half INTEGER, is_new_build BOOLEAN,
               price_m2 DOUBLE, property_type VARCHAR, rooms INTEGER, section VARCHAR, code_commune VARCHAR,
               code_departement VARCHAR, longitude DOUBLE, latitude DOUBLE, location_precision VARCHAR,
               market_excluded VARCHAR)"""
    )
    # both halves of 2025 (a complete year); equal prices so the P1–P99 trim keeps them all
    rows = [(f"a{i}", 2025, 1 + i % 2, False, 3000.0, "apartment", 2, "49007000AB", "49007", "49",
             -0.55, 47.47, "section", None) for i in range(12)]
    rows += [(f"b{i}", 2025, 1, False, 2000.0, "apartment", 2, "49007000AC", "49007", "49",
              -0.56, 47.48, "section", None) for i in range(4)]
    # Paris: DVF files the city code, the section id starts with the arrondissement
    rows += [(f"p{i}", 2025, 1 + i % 2, False, 10000.0, "apartment", 2, "75111000AB", "75056", "75",
              2.38, 48.86, "section", None) for i in range(10)]
    # a new build and an excluded sale never enter section medians
    rows += [("n0", 2025, 1, True, 9000.0, "apartment", 2, "49007000AB", "49007", "49", -0.55, 47.47, "section", None),
             ("x0", 2025, 1, False, 9000.0, "apartment", 2, "49007000AB", "49007", "49", -0.55, 47.47, "section",
              "outbuildings")]
    con.executemany("INSERT INTO dvf_sales VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


@pytest.fixture
def serve(tmp_path: Path) -> Path:
    con = _with_extras(_con())
    _sales(con)
    directory = tmp_path / "serve"
    directory.mkdir()
    dashboard.write(con, directory, min_sales=10)
    return directory


def _load(serve: Path, path: str) -> dict:
    return json.loads((serve / path).read_text(encoding="utf-8"))


def _rows(doc: dict) -> list[dict]:
    return [dict(zip(doc["fields"], r)) for r in doc["rows"]]


def test_series_split_by_level_and_type(serve):
    rows = _rows(_load(serve, "series/france_apartment.json"))
    assert {r["code"] for r in rows} == {"FR"} and all(r["n"] >= 10 for r in rows)
    assert _load(serve, "series/departement_house.json")["rows"] == []


def test_commune_series_yearly_existing_all_sizes_above_min_sales(serve):
    doc = _load(serve, "series/communes/49.json")
    assert doc["departement"] == "49" and doc["fields"] == ["code", "type", "period", "n", "median"]
    rows = _rows(doc)
    angers = [(r["type"], r["period"], r["median"]) for r in rows if r["code"] == "49007"]
    # complete years only (2026 is one half), existing homes, all sizes; new builds and the mixed type left out
    assert angers == [("apartment", "2024", 3000), ("apartment", "2025", 3100), ("house", "2025", 2500)]
    assert {r["code"] for r in rows} == {"49007", "49015", "49020"} and all(r["n"] >= 10 for r in rows)


def test_commune_series_carries_arrondissements_and_drops_small_cells(serve):
    rows = _rows(_load(serve, "series/communes/75.json"))
    # Paris as a whole has 9 sales here (under min_sales): left out; its arrondissement is published
    assert [(r["code"], r["n"]) for r in rows] == [("75101", 300)]


def test_explorer_rows_per_type_and_size_with_typical_deal(serve):
    rows = _rows(_load(serve, "explorer/communes/49.json"))
    angers = {(r["type"], r["size"]): r for r in rows if r["code"] == "49007"}
    assert {("apartment", "all"), ("apartment", "2"), ("house", "all")} <= set(angers)
    assert angers[("apartment", "all")]["cash_flow_monthly"] is not None
    assert angers[("apartment", "all")]["name"] == "Angers" and angers[("apartment", "all")]["parent"] == "49"
    # flats and houses mixed are never a row
    assert not any(r["type"] == "all" for r in rows)


def test_explorer_departements_file_exists(serve):
    assert "rows" in _load(serve, "explorer/departements.json")


def test_commune_points_have_coordinates(serve):
    rows = _rows(_load(serve, "points/communes.json"))
    angers = [r for r in rows if r["code"] == "49007" and r["type"] == "apartment"][0]
    assert angers["lon"] == pytest.approx(-0.5541) and angers["n"] == 1600


def test_section_points_need_ten_sales_and_stay_in_their_commune(serve):
    doc = _load(serve, "points/sections/49.json")
    rows = _rows(doc)
    assert [r["section"] for r in rows] == ["49007000AB"]
    assert rows[0]["n"] == 12 and rows[0]["commune"] == "49007"
    assert rows[0]["median_price_m2"] < 9000  # new build and excluded sale left out


def test_paris_sections_carry_their_arrondissement(serve):
    rows = _rows(_load(serve, "points/sections/75.json"))
    assert [(r["section"], r["commune"]) for r in rows] == [("75111000AB", "75111")]


def test_rent_curve_only_for_single_code_places():
    con = duckdb.connect()
    con.execute("""CREATE TABLE rent_child AS SELECT * FROM (VALUES
                   ('49007', 'apartment', 52, 14.6, -0.3, '49007', NULL),
                   ('75101', 'apartment', 52, 40.0, -0.2, '75056', '75101'),
                   ('75120', 'apartment', 52, 30.0, -0.25, '75056', '75120'))
                   t(code, property_type, ref_surface, ref_rent_m2, slope, code_commune, code_arrondissement)""")
    curves = dashboard.rent_curves(con)
    assert curves[("commune", "49007")]["apartment"] == {"ref_rent_m2": 14.6, "ref_surface": 52, "slope": -0.3}
    # Paris has two ANIL codes (its arrondissements): no single curve for the city
    assert ("commune", "75056") not in curves
    assert curves[("arrondissement", "75120")]["apartment"]["ref_rent_m2"] == 30.0
