"""Level page files (docs/features/018-speed-and-map/spec.md): everything the France and département pages show,
precomputed, so a page reads one small file and draws."""
import json
from pathlib import Path

import pytest

from rea_pipeline import dashboard
from test_dashboard import _sales
from test_publish import _con, _with_extras


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


def test_france_file_has_every_departement_row_ready_to_draw(serve):
    doc = _load(serve, "levels/france.json")
    assert doc["period"] == "2025" and doc["years"] == ["2024", "2025"]
    flats = doc["types"]["apartment"]
    assert flats["france"]["price"] > 0 and flats["france"]["n"] == 800000
    [maine] = flats["rows"]
    assert maine["code"] == "49" and maine["region"] == "52" and maine["n"] == 9000
    # index France = 100 and the yearly arrays are computed here, not in the browser
    assert maine["index"] == round(maine["price"] / flats["france"]["price"] * 100)
    assert len(maine["medians"]) == len(doc["years"]) and len(maine["changes"]) == len(doc["years"])
    assert maine["changes"][0] is None
    assert doc["types"]["house"]["rows"] == []


def test_france_curve_is_the_national_half_year_series(serve):
    curve = _load(serve, "levels/france.json")["types"]["apartment"]["curve"]
    assert len(curve["periods"]) == len(curve["median"]) == len(curve["p25"]) == len(curve["p75"])
    assert all("-H" in p for p in curve["periods"])


def test_departement_file_ranks_it_and_lists_its_communes_with_their_years(serve):
    doc = _load(serve, "levels/departements/49.json")
    assert doc["code"] == "49" and doc["region"]["code"] == "52"
    flats = doc["types"]["apartment"]
    assert flats["kpis"]["rank"] == 1 and flats["kpis"]["ranked"] == 1
    assert set(flats["curves"]) == {"departement", "region", "france"}
    communes = {c["code"]: c for c in flats["communes"]}
    assert set(communes) == {"49007", "49015", "49020"}
    angers = communes["49007"]
    # 2024 → 2025 change from the yearly medians; the partial 2026 never enters
    assert angers["medians"][0] is not None and angers["changes"][1] is not None
    assert angers["growth"] == pytest.approx(angers["medians"][1] / angers["medians"][0] - 1, abs=1e-4)


def test_split_city_is_listed_by_arrondissement_only(serve):
    flats = _load(serve, "levels/departements/75.json")["types"]["apartment"]
    codes = {c["code"] for c in flats["communes"]}
    assert "75101" in codes and "75056" not in codes


def test_every_departement_gets_a_file_even_without_sales(serve):
    assert (serve / "levels" / "departements" / "75.json").exists()
    assert _load(serve, "levels/departements/75.json")["types"]["house"]["communes"] == []
