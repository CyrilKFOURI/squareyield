"""Browser export (docs/features/022-full-frontend/spec.md rule 2): JSON trees evaluate exactly like
LightGBM, including missing values and categorical splits, and the app fixture stays up to date.

REA_UPDATE_FIXTURE=1 uv run pytest tests/test_web_export.py   # rewrite the app fixture
"""
import json
import os
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pytest

from rea_ml.inference import PriceCheckModel
from rea_ml.web_export import booster_trees, departement_files, export_web, golden, predict_trees

APP_FIXTURE = Path(__file__).resolve().parents[2] / "apps" / "app" / "src" / "data" / "price-model.fixture.json"


def _tricky_booster() -> tuple[lgb.Booster, np.ndarray]:
    """NaN-heavy numeric column, a zero-as-missing column, a categorical column with NaN."""
    rng = np.random.default_rng(1)
    n = 3000
    x = np.column_stack([rng.normal(size=n), rng.choice([0.0, 1.0, 2.5, -1.0], n), rng.integers(0, 12, n).astype(float),
                         rng.uniform(size=n)])
    y = np.where(np.isnan(x[:, 0]), 1.0, x[:, 0]) + (x[:, 2] % 3) * 0.7 - (x[:, 1] == 0) + rng.normal(0, 0.1, n)
    x[rng.random(n) < 0.2, 0] = np.nan
    x[rng.random(n) < 0.1, 2] = np.nan
    params = {"objective": "huber", "num_leaves": 15, "min_data_in_leaf": 10, "verbose": -1, "seed": 0,
              "deterministic": True, "num_threads": 1, "max_cat_to_onehot": 4, "cat_smooth": 1}
    booster = lgb.train(params, lgb.Dataset(x, y, categorical_feature=[2]), num_boost_round=30)
    zero_missing = lgb.train(params | {"zero_as_missing": True}, lgb.Dataset(x[:, [1, 3]], y), num_boost_round=10)
    return booster, x, zero_missing


def test_json_trees_equal_lightgbm_with_missing_and_categorical():
    booster, x, zero_missing = _tricky_booster()
    trees = booster_trees(booster)
    assert any(t["cats"] for t in trees), "the test model should have categorical splits"
    rows = x[:200]
    np.testing.assert_allclose(predict_trees(trees, rows), booster.predict(rows), rtol=0, atol=1e-9)
    z_trees = booster_trees(zero_missing)
    assert any(((d >> 2) & 3) == 1 for t in z_trees for d in t["d"])
    np.testing.assert_allclose(predict_trees(z_trees, x[:200, [1, 3]]), zero_missing.predict(x[:200, [1, 3]]),
                               rtol=0, atol=1e-9)


def test_export_web_writes_model_and_departement_files(model_folder, tmp_path):
    out = export_web(model_folder, tmp_path / "estimate")
    model = json.loads((out / "model.json").read_text(encoding="utf-8"))
    assert model["feature_columns"] and len(model["trees"]) == 50 and "*" in model["intervals"]
    dep49 = json.loads((out / "49.json").read_text(encoding="utf-8"))
    assert {s[0] for s in dep49["sections"]} == {"49007000AB", "49007000CD"}
    assert set(json.loads((out / "75.json").read_text(encoding="utf-8"))["communes"]) == {"75101"}
    # the export checked its own trees on 200 rows against LightGBM
    assert len(json.loads((model_folder / "web_golden.json").read_text(encoding="utf-8"))["predictions"]) == 200


def _app_fixture(model_folder: Path) -> dict:
    booster, x, _ = _tricky_booster()
    rows = x[:40]
    model = PriceCheckModel.load(model_folder)
    trees = booster_trees(model.booster)
    reference = golden(model, trees, n=24)
    nan = lambda r: [None if np.isnan(v) else float(v) for v in r]  # noqa: E731
    exported = json.loads(json.dumps(departement_files(model)))
    return {
        "walker": {"trees": booster_trees(booster), "x": [nan(r) for r in rows], "predictions": booster.predict(rows).tolist(),
                   "contributions": booster.predict(rows, pred_contrib=True).tolist()},
        "model": {"model_version": "test", "reference_period": model.spec["reference_period"],
                  "feature_columns": model.spec["feature_columns"], "feature_groups": model.spec["feature_groups"],
                  "encoding": {"smoothing": model.spec["encoding"]["smoothing"],
                               "global_means": model.spec["encoding"]["global_means"]},
                  "interval_coverage": model.spec["interval_coverage"],
                  "intervals": {r["segment"]: [r["low"], r["high"]] for r in model.intervals.to_dict("records")},
                  "trees": trees},
        "departements": exported,
        "golden": reference,
    }


def test_app_fixture_is_up_to_date(model_folder):
    fixture = json.loads(json.dumps(_app_fixture(model_folder)))
    if os.environ.get("REA_UPDATE_FIXTURE"):
        APP_FIXTURE.write_text(json.dumps(fixture, separators=(",", ":")), encoding="utf-8")
    committed = json.loads(APP_FIXTURE.read_text(encoding="utf-8"))
    assert committed["walker"]["x"] == fixture["walker"]["x"]
    np.testing.assert_allclose(committed["walker"]["predictions"], fixture["walker"]["predictions"], atol=1e-9)
    np.testing.assert_allclose(committed["golden"]["predictions"], fixture["golden"]["predictions"], atol=1e-9)
    assert committed["golden"]["properties"] == fixture["golden"]["properties"]


@pytest.mark.parametrize("missing_rooms", [True])
def test_golden_rows_cover_missing_values(model_folder, missing_rooms):
    model = PriceCheckModel.load(model_folder)
    reference = golden(model, booster_trees(model.booster), n=24)
    assert any(p["rooms"] is None for p in reference["properties"]) == missing_rooms
    assert any(p["section"] is None for p in reference["properties"])
