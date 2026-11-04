"""Shared fixture: a small synthetic model packaged into a real folder."""
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from rea_ml import package
from rea_ml.config import Config, Training
from rea_ml.features import LocationEncoder, TimeIndex, build_features, columns_of
from rea_ml.modeling import ConformalIntervals, fit_lightgbm
from rea_ml.train import TrainingResult

SECTIONS = {"49007000AB": (4.0, 47.0, 8.0), "49007000CD": (4.01, 47.01, 8.3), "75101000AA": (2.34, 48.86, 9.2)}
GROUPS = ["type", "surface", "rooms", "land", "coordinates", "enc_section", "enc_commune"]


def _sales(n: int, rng: np.random.Generator) -> pd.DataFrame:
    sections = rng.choice(list(SECTIONS), n)
    surface = rng.uniform(20, 120, n)
    rows = pd.DataFrame({
        "section": sections, "code_commune": [s[:5] for s in sections], "code_departement": [s[:2] for s in sections],
        "property_type": rng.choice(["apartment", "house"], n), "surface_m2": surface,
        "rooms": np.clip((surface / 22).round(), 1, 6), "land_m2": 0.0, "n_dependencies": 0, "n_lots": 1,
        "is_new_build": False, "surface_carrez_m2": surface, "location_precision": "section",
        "longitude": [SECTIONS[s][0] for s in sections], "latitude": [SECTIONS[s][1] for s in sections],
        "period": "2025-H2",
    })
    base = np.array([SECTIONS[s][2] for s in sections])
    rows["log_price_m2"] = base - 0.002 * (surface - 60) + rng.normal(0, 0.1, n)
    return rows


@pytest.fixture(scope="module")
def model_folder(tmp_path_factory) -> Path:
    rng = np.random.default_rng(0)
    sales = _sales(3000, rng)
    socio = pd.DataFrame({"code_commune": ["49007", "75101"], "population": [159022, 15114],
                          "population_growth_yearly": [0.007, -0.01], "vacancy_rate": [0.06, 0.1],
                          "second_home_share": [0.01, 0.1], "renter_share": [0.68, 0.7],
                          "median_living_standard": [23930, 39320], "jobs_growth_yearly": [0.02, 0.0]})
    index = TimeIndex.fit(sales.assign(is_new_build=False))
    y = sales["log_price_m2"].to_numpy()
    encoder = LocationEncoder.fit(sales, y, ("section", "code_commune", "code_departement"), 20.0)
    columns = columns_of(GROUPS)
    x = build_features(sales, encoder.transform(sales), socio)[columns]
    training = Training(max_rounds=50, params=Training().params | {"num_leaves": 15, "min_data_in_leaf": 20})
    booster = fit_lightgbm(x, y, None, None, training, num_rounds=50)
    segments = pd.Series(["apartment/dense"] * 1000)
    result = TrainingResult(
        final_model=booster, selected_groups=GROUPS, feature_columns=columns, time_index=index,
        encoder=encoder.published(10), intervals=ConformalIntervals.fit(segments, rng.normal(0, 0.1, 1000), 0.8),
        socio=socio,
        report={"split": {k: {"n": 1, "from": "2021-01-01", "to": "2026-06-30"} for k in ("train", "valid", "test")},
                "test": {"mdape": 0.1, "within_10pct": 0.5, "within_20pct": 0.8, "interval_coverage": 0.8,
                         "interval_median_width": 0.3},
                "baselines_test": {"linear_hedonic": {"mdape": 0.2, "within_10pct": 0.3, "within_20pct": 0.6},
                                   "commune_average": {"mdape": 0.3, "within_10pct": 0.2, "within_20pct": 0.4}},
                "test_by_segment": {}, "selection": {"dropped_groups": []}, "best_iteration": 50,
                "final_model": {"n_sales": 3000, "rounds": 50, "reference_period": "2025-H2"}},
    )
    marts = tmp_path_factory.mktemp("marts")
    pd.DataFrame({"section": list(SECTIONS), "longitude": [v[0] for v in SECTIONS.values()],
                  "latitude": [v[1] for v in SECTIONS.values()], "n_parcels": 13}).to_parquet(marts / "section_point.parquet")
    pd.DataFrame({"code": ["49007", "75101"], "longitude": [4.005, 2.34], "latitude": [47.005, 48.86]}).to_parquet(
        marts / "commune_point.parquet")
    package.MARTS_DIR = marts
    return package.write_package(result, Config(), tmp_path_factory.mktemp("models") / "test-version")
