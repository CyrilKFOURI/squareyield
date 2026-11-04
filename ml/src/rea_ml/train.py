"""Training recipe in two phases (docs/features/011-price-check-ml/spec.md §4–6).

1. Evaluate the recipe out of time: learn on ≤ 2024, select features and stop early on
   2025-H1, then measure once on 2025-H2 + 2026-H1 against two baselines.
2. Final model: replay the same recipe on every sale, with the number of rounds found in
   phase 1, and calibrate its intervals on phase 1's out-of-time residuals.
The metrics published with the model are those of phase 1: they describe how the recipe
does on sales it has never seen.
"""
import logging
import time
from dataclasses import asdict, dataclass, field

import lightgbm as lgb
import numpy as np
import pandas as pd

from .config import Config
from .dataset import load_sales, load_socio, split_by_time
from .features import LocationEncoder, TimeIndex, build_features, columns_of
from .modeling import (
    ConformalIntervals,
    fit_lightgbm,
    fit_ridge_baseline,
    metrics_by_segment,
    out_of_fold_encodings,
    price_metrics,
    select_groups,
)

log = logging.getLogger("rea_ml")

# Final model learns from ~25 % more sales than the evaluated one: give it proportionally more rounds.
FINAL_ROUNDS_FACTOR = 1.15


@dataclass
class TrainingResult:
    final_model: lgb.Booster
    selected_groups: list[str]
    feature_columns: list[str]
    time_index: TimeIndex
    encoder: LocationEncoder
    intervals: ConformalIntervals
    socio: pd.DataFrame
    report: dict = field(default_factory=dict)


def _timer():
    start = time.perf_counter()
    return lambda: round(time.perf_counter() - start, 1)


def evaluate_recipe(config: Config, sales: pd.DataFrame, socio: pd.DataFrame) -> dict:
    elapsed = _timer()
    splits = split_by_time(sales, config.split.train_until, config.split.valid_until)
    train, valid, test = splits["train"], splits["valid"], splits["test"]
    log.info("split sizes: train %d, valid %d, test %d", len(train), len(valid), len(test))

    index = TimeIndex.fit(train)  # valid/test periods are after its reference: index 0
    y = {name: rows["log_price_m2"].to_numpy() - index.lookup(rows) for name, rows in splits.items()}

    enc = config.encoding
    encodings = {"train": out_of_fold_encodings(train, y["train"], enc, config.training.seed)}
    encoder = LocationEncoder.fit(train, y["train"], enc.levels, enc.smoothing)
    encodings["valid"], encodings["test"] = encoder.transform(valid), encoder.transform(test)
    x = {name: build_features(splits[name], encodings[name], socio) for name in splits}
    log.info("features built in %ss", elapsed())

    groups, importances, selection, _ = select_groups(x["train"], y["train"], x["valid"], y["valid"], config.training)
    columns = columns_of(groups)
    log.info("selected %d groups: %s (%ss)", len(groups), groups, elapsed())
    # the evaluated model learns from the whole training period with the selected groups
    model = fit_lightgbm(x["train"][columns], y["train"], x["valid"][columns], y["valid"], config.training)
    log.info("evaluated model: best iteration %d (%ss)", model.best_iteration, elapsed())

    # intervals of the evaluated model: calibrated on valid, checked on test
    valid_segments = ConformalIntervals.segment(valid, encodings["valid"])
    test_segments = ConformalIntervals.segment(test, encodings["test"])
    valid_residuals = y["valid"] - model.predict(x["valid"][columns], num_iteration=model.best_iteration)
    calibration = ConformalIntervals.fit(valid_segments, valid_residuals, config.training.interval_coverage)
    low, high = calibration.bounds(test_segments)

    log_pred = model.predict(x["test"][columns], num_iteration=model.best_iteration)
    ridge = fit_ridge_baseline(x["train"][columns], y["train"])
    baselines = {
        "commune_average": price_metrics(y["test"], encodings["test"]["enc_commune"].to_numpy()),
        "linear_hedonic": price_metrics(y["test"], ridge.predict(x["test"][columns])),
    }
    frame = pd.DataFrame({
        "log_true": y["test"], "log_pred": log_pred, "low": low, "high": high,
        "property_type": test["property_type"].to_numpy(),
        "data_density": test_segments.str.split("/").str[1].to_numpy(),
        "new_build": np.where(test["is_new_build"], "new", "existing"),
        "location_precision": test["location_precision"].to_numpy(),
    })
    report = {
        "split": {name: {"n": len(rows), "from": str(rows["date_mutation"].min().date()),
                         "to": str(rows["date_mutation"].max().date())} for name, rows in splits.items()},
        "selection": {
            "kept_groups": groups,
            "dropped_groups": [i.group for i in importances if i.group not in groups],
            "importances": [asdict(i) for i in importances],
            "valid_mean_abs_log_error": {"all_groups": selection["full"], "kept_groups": selection["reduced"]},
        },
        "best_iteration": int(model.best_iteration),
        "test": price_metrics(y["test"], log_pred, low, high),
        "baselines_test": baselines,
        "test_by_segment": {
            by: metrics_by_segment(frame, by)
            for by in ("property_type", "data_density", "new_build", "location_precision")
        },
        "seconds": elapsed(),
    }
    test_residuals = y["test"] - log_pred
    return {"report": report, "groups": groups, "columns": columns, "best_iteration": int(model.best_iteration),
            "test_segments": test_segments, "test_residuals": test_residuals}


def train(config: Config) -> TrainingResult:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    sales, socio = load_sales(config.cleaning), load_socio()
    log.info("loaded %d sales", len(sales))
    evaluation = evaluate_recipe(config, sales, socio)
    report = evaluation["report"]
    log.info("test metrics: %s", report["test"])

    elapsed = _timer()
    index = TimeIndex.fit(sales)
    y = sales["log_price_m2"].to_numpy() - index.lookup(sales)
    enc = config.encoding
    oof = out_of_fold_encodings(sales, y, enc, config.training.seed)
    x = build_features(sales, oof, socio)[evaluation["columns"]]
    rounds = int(evaluation["best_iteration"] * FINAL_ROUNDS_FACTOR)
    final = fit_lightgbm(x, y, None, None, config.training, num_rounds=rounds)
    report["final_model"] = {"n_sales": len(sales), "rounds": rounds, "reference_period": index.reference_period,
                             "seconds": elapsed()}
    log.info("final model trained on %d sales in %ss", len(sales), report["final_model"]["seconds"])

    return TrainingResult(
        final_model=final,
        selected_groups=evaluation["groups"],
        feature_columns=evaluation["columns"],
        time_index=index,
        encoder=LocationEncoder.fit(sales, y, enc.levels, enc.smoothing).published(enc.min_published_sales),
        # out-of-time residuals of the evaluated recipe: an honest width for the final model
        intervals=ConformalIntervals.fit(
            evaluation["test_segments"], evaluation["test_residuals"], config.training.interval_coverage
        ),
        socio=socio,
        report=report,
    )
