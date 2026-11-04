"""Typical deal precomputed per market cell: same numbers as core-kpi (shared fixture)."""
import json
from pathlib import Path

import pytest

from rea_pipeline import deals

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "typical_deal_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda c: c["name"])
def test_matches_core_kpi(case):
    i = case["input"]
    result = deals.typical_deal(i["price"], i["surface_m2"], i["rent_m2"], i["property_type"], i["tfpb_rate"])
    for key, value in case["expected"].items():
        assert result[key] == pytest.approx(value, abs=0.01), key


def test_rent_excludes_charges_provision():
    assert deals.typical_deal(100000, 40, 12, "apartment", None)["rent_monthly"] == (12 - 1.5) * 40
