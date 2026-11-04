"""The parts of the recipe where a silent bug would inflate the metrics: encodings, time index,
intervals and the error metric itself."""
import numpy as np
import pandas as pd
import pytest

from rea_ml.config import Encoding
from rea_ml.features import LocationEncoder, TimeIndex
from rea_ml.modeling import ConformalIntervals, out_of_fold_encodings, price_metrics

LEVELS = ("section", "code_commune", "code_departement")


def _rows(n_per_section: dict[str, int]) -> pd.DataFrame:
    records = []
    for section, n in n_per_section.items():
        records += [{"section": section, "code_commune": section[:5], "code_departement": section[:2],
                     "property_type": "apartment"}] * n
    return pd.DataFrame(records)


def test_encoder_smoothing_shrinks_small_areas_towards_parent():
    rows = _rows({"49007000AB": 80, "49007000CD": 20})
    target = np.r_[np.full(80, 8.0), np.full(20, 9.0)]
    encoder = LocationEncoder.fit(rows, target, LEVELS, smoothing=20.0)
    encoded = encoder.transform(_rows({"49007000CD": 1, "49007000ZZ": 1}))
    commune = encoded["enc_commune"].iloc[0]
    # commune mean 8.2 with 100 sales, shrunk towards the département (same sales) and global mean
    assert commune == pytest.approx(8.2)
    # section CD: (20 × 9 + 20 × 8.2) / 40
    assert encoded["enc_section"].iloc[0] == pytest.approx((20 * 9 + 20 * 8.2) / 40)
    # unknown section falls back to its commune
    assert encoded["enc_section"].iloc[1] == pytest.approx(commune)
    assert encoded["n_section"].iloc[1] == 0


def test_published_encoder_drops_areas_under_threshold():
    rows = _rows({"49007000AB": 12, "49007000CD": 3})
    encoder = LocationEncoder.fit(rows, np.ones(15), LEVELS, 20.0).published(min_sales=10)
    assert encoder.tables["section"]["section"].tolist() == ["49007000AB"]


def test_out_of_fold_encoding_never_sees_its_own_price():
    # each section has a single sale: out of fold, its own price must be invisible
    rows = _rows({f"490070{i:04d}": 1 for i in range(50)})
    target = np.arange(50, dtype=float)
    encodings = out_of_fold_encodings(rows, target, Encoding(levels=LEVELS), seed=0)
    assert (encodings["n_section"] == 0).all()


def test_time_index_reference_is_zero_and_future_periods_too():
    sales = pd.DataFrame({
        "code_departement": ["49"] * 4, "property_type": ["apartment"] * 4, "is_new_build": [False] * 4,
        "period": ["2024-H1", "2024-H1", "2024-H2", "2024-H2"],
        "log_price_m2": np.log([3000, 3000, 3300, 3300]),
    })
    index = TimeIndex.fit(sales)
    assert index.reference_period == "2024-H2"
    query = sales.iloc[[0, 2]].assign(period=["2024-H1", "2026-H1"])
    np.testing.assert_allclose(index.lookup(query), [np.log(3000 / 3300), 0.0])


def test_conformal_interval_covers_the_requested_share():
    rng = np.random.default_rng(0)
    segments = pd.Series(["apartment/dense"] * 20_000)
    intervals = ConformalIntervals.fit(segments, rng.normal(0, 0.2, 20_000), coverage=0.8)
    low, high = intervals.bounds(segments)
    fresh = rng.normal(0, 0.2, 20_000)
    assert np.mean((fresh >= low) & (fresh <= high)) == pytest.approx(0.8, abs=0.01)
    # unknown segment uses the overall quantiles
    assert intervals.bounds(pd.Series(["house/sparse"]))[0][0] == pytest.approx(low[0], abs=0.01)


def test_price_metrics_are_on_prices_not_logs():
    log_true = np.log([100.0, 100.0, 100.0, 100.0])
    log_pred = np.log([105.0, 91.0, 125.0, 100.0])
    metrics = price_metrics(log_true, log_pred)
    assert metrics["mdape"] == pytest.approx(0.07)  # median of 5 %, 9 %, 25 %, 0 %
    assert metrics["within_10pct"] == 0.75 and metrics["within_20pct"] == 0.75
