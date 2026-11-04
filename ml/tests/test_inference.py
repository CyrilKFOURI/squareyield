"""End to end on synthetic data: package a small model, reload it from its folder only, and
check estimate, interval, verdict and that the explanation adds up to the estimate."""
import json
import sys

import numpy as np
import pytest

from conftest import GROUPS
from rea_ml.features import columns_of


def test_package_layout(model_folder):
    for name in ("README.md", "model.txt", "feature_spec.json", "intervals.json", "metrics.json",
                 "inference.py", "features.py", "encodings/section.parquet", "context/section_points.parquet"):
        assert (model_folder / name).exists(), name
    card = (model_folder / "README.md").read_text(encoding="utf-8")
    assert card.startswith("---\nlanguage: fr") and "library_name: lightgbm" in card
    # ready to publish: a licence, the data attribution and its conditions, no "internal" status
    assert "\nlicense: mit\n" in card and "Licence Ouverte" in card and "réidentification" in card
    assert "not published" not in card


def test_folder_runs_standalone(model_folder, monkeypatch):
    # import inference.py from the model folder itself, not from the rea_ml package
    monkeypatch.syspath_prepend(str(model_folder))
    for name in ("inference", "features"):
        sys.modules.pop(name, None)
    import inference  # noqa: PLC0415

    model = inference.PriceCheckModel.load(model_folder)
    expensive, cheap = model.estimate([
        {"property_type": "apartment", "surface_m2": 50, "rooms": 2, "code_commune": "75101",
         "section": "75101000AA", "asked_price": 50 * 9_000},
        {"property_type": "apartment", "surface_m2": 50, "rooms": 2, "code_commune": "49007",
         "section": "49007000AB", "asked_price": 50 * 9_000},
    ])
    assert expensive["price_m2"] > 2.5 * cheap["price_m2"]  # Paris section (~3.3× by construction, shrunk by smoothing)
    assert expensive["price_low"] < expensive["price"] < expensive["price_high"]
    assert cheap["verdict"] == "above"  # 9 000 €/m² where sales are ~3 000

    # the explanation multiplies back to the estimate (exact TreeSHAP)
    explanation = expensive["explanation"]
    product = explanation["base_price_m2"] * np.prod([1 + e["effect_pct"] for e in explanation["effects"]])
    assert product == pytest.approx(expensive["price_m2"], rel=1e-6)


def test_unknown_section_falls_back_to_commune(model_folder):
    from rea_ml.inference import PriceCheckModel

    [result] = PriceCheckModel.load(model_folder).estimate(
        [{"property_type": "house", "surface_m2": 90, "rooms": 4, "code_commune": "49007", "section": "49007000ZZ"}]
    )
    assert result["location_precision"] == "commune"
    assert "verdict" not in result


def test_spec_records_provenance(model_folder):
    spec = json.loads((model_folder / "feature_spec.json").read_text(encoding="utf-8"))
    assert spec["feature_columns"] == columns_of(GROUPS)
    assert {"commit", "data_run", "lightgbm"} <= set(spec["provenance"])
