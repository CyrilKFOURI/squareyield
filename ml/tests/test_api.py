"""Local API: address resolution to a section, comparables, and the estimate payload."""
from pathlib import Path

import pandas as pd
import pytest

from rea_ml import api

SECTIONS = pd.DataFrame({"section": ["49007000AB", "49007000CD", "75101000AA"],
                         "longitude": [4.0, 4.01, 2.34], "latitude": [47.0, 47.01, 48.86]})


def test_nearest_section_stays_in_the_commune():
    assert api.nearest_section(SECTIONS, "49007", 4.009, 47.009) == "49007000CD"
    # a point closer to Paris still gets an Angers section if the address is in Angers
    assert api.nearest_section(SECTIONS, "49007", 2.34, 48.86).startswith("49007")
    assert api.nearest_section(SECTIONS, "13055", 5.4, 43.3) is None


@pytest.fixture
def sales_path(tmp_path: Path) -> Path:
    rows = [  # (section, surface, date, type, new)
        ("49007000AB", 45, "2026-05-01", "apartment", False),
        ("49007000CD", 44, "2026-04-01", "apartment", False),
        ("49007000AB", 90, "2026-03-01", "apartment", False),  # surface too far
        ("49007000AB", 46, "2023-01-01", "apartment", False),  # too old
        ("49007000AB", 45, "2026-02-01", "house", False),  # other type
        ("49007000AB", 45, "2026-02-01", "apartment", True),  # new build
    ]
    frame = pd.DataFrame([
        {"section": s, "surface_m2": float(m), "date_mutation": pd.Timestamp(d), "property_type": t,
         "is_new_build": n, "code_commune": "49007", "code_arrondissement": None, "rooms": 2,
         "land_m2": 0.0, "price": 3000.0 * m, "price_m2": 3000.0}
        for s, m, d, t, n in rows
    ])
    path = tmp_path / "sales.parquet"
    frame.to_parquet(path)
    return path


def test_comparables_same_section_first_and_filtered(sales_path):
    prop = {"code_commune": "49007", "property_type": "apartment", "surface_m2": 45}
    found = api.comparables(prop, "49007000AB", sales_path)
    assert [c["month"] for c in found] == ["2026-05", "2026-04"]
    assert found[0]["same_section"] is True and found[1]["same_section"] is False


def test_service_resolves_address_and_returns_comparables(model_folder, sales_path, monkeypatch):
    monkeypatch.setattr(api, "geocode", lambda address: {
        "label": "12 Rue Test 49100 Angers", "code_commune": "49007", "longitude": 4.0, "latitude": 47.0})
    monkeypatch.setattr(api, "SALES_PATH", sales_path)
    result = api.Service(model_folder).estimate(
        {"address": "12 rue Test Angers", "property_type": "apartment", "surface_m2": 45, "rooms": 2,
         "asked_price": 140000})
    assert result["section"] == "49007000AB" and result["code_commune"] == "49007"
    assert result["verdict"] in {"below", "consistent", "above"}
    assert [c["month"] for c in result["comparables"]] == ["2026-05", "2026-04"]


def test_service_requires_a_location(model_folder):
    with pytest.raises(ValueError):
        api.Service(model_folder).estimate({"property_type": "apartment", "surface_m2": 45})
