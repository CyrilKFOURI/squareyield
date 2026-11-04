"""Training, feature selection, baselines, conformal intervals and metrics."""
from dataclasses import dataclass

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.model_selection import KFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .config import Encoding, Training
from .features import FEATURE_GROUPS, LocationEncoder, columns_of


def out_of_fold_encodings(rows: pd.DataFrame, target: np.ndarray, config: Encoding, seed: int) -> pd.DataFrame:
    """Encodings of training rows computed without their own fold, so the model cannot learn
    to read a sale's price back from the average it is part of."""
    parts = []
    folds = KFold(n_splits=config.n_folds, shuffle=True, random_state=seed)
    for fit_idx, apply_idx in folds.split(rows):
        encoder = LocationEncoder.fit(rows.iloc[fit_idx], target[fit_idx], config.levels, config.smoothing)
        parts.append(encoder.transform(rows.iloc[apply_idx]))
    return pd.concat(parts).sort_index()


def fit_lightgbm(
    x_train: pd.DataFrame, y_train: np.ndarray, x_valid: pd.DataFrame | None, y_valid: np.ndarray | None,
    training: Training, num_rounds: int | None = None,
) -> lgb.Booster:
    """Early stopping on the validation period when given, else a fixed number of rounds."""
    params = training.params | {"seed": training.seed, "deterministic": True, "num_threads": 0}
    train_set = lgb.Dataset(x_train, y_train, free_raw_data=False)
    if x_valid is None:
        return lgb.train(params, train_set, num_boost_round=num_rounds or training.max_rounds)
    valid_set = lgb.Dataset(x_valid, y_valid, reference=train_set)
    return lgb.train(
        params,
        train_set,
        num_boost_round=training.max_rounds,
        valid_sets=[valid_set],
        callbacks=[lgb.early_stopping(training.early_stopping_rounds, verbose=False), lgb.log_evaluation(100)],
    )


def mean_abs_log_error(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(y_true - y_pred)))


@dataclass
class GroupImportance:
    group: str
    increase_mean: float
    increase_std: float

    @property
    def useful(self) -> bool:
        # keep a group only if shuffling it hurts more than its own noise
        return self.increase_mean - self.increase_std > 0


def permutation_importance(
    booster: lgb.Booster, x: pd.DataFrame, y: np.ndarray, groups: list[str], repeats: int, seed: int
) -> list[GroupImportance]:
    """Increase of validation error when a whole feature group is shuffled."""
    rng = np.random.default_rng(seed)
    base = mean_abs_log_error(y, booster.predict(x))
    results = []
    for group in groups:
        increases = []
        for _ in range(repeats):
            shuffled = x.copy()
            order = rng.permutation(len(x))
            for column in FEATURE_GROUPS[group]:
                shuffled[column] = x[column].to_numpy()[order]
            increases.append(mean_abs_log_error(y, booster.predict(shuffled)) - base)
        results.append(GroupImportance(group, float(np.mean(increases)), float(np.std(increases))))
    return sorted(results, key=lambda r: -r.increase_mean)


def select_groups(
    x_train: pd.DataFrame, y_train: np.ndarray, x_valid: pd.DataFrame, y_valid: np.ndarray, training: Training
) -> tuple[list[str], list[GroupImportance], dict, lgb.Booster]:
    """One backward step: drop groups whose permutation importance is not above noise, then
    keep the reduced set only if the validation error does not get worse."""
    all_groups = list(FEATURE_GROUPS)
    if len(x_train) > training.selection_train_sample:
        rows = np.random.default_rng(training.seed).choice(len(x_train), training.selection_train_sample, replace=False)
        x_train, y_train = x_train.iloc[rows], y_train[rows]
    full = fit_lightgbm(x_train[columns_of(all_groups)], y_train, x_valid[columns_of(all_groups)], y_valid, training)
    sample = x_valid.sample(min(training.selection_sample, len(x_valid)), random_state=training.seed)
    importances = permutation_importance(
        full, sample[columns_of(all_groups)], y_valid[sample.index], all_groups, training.selection_repeats, training.seed
    )
    kept = [imp.group for imp in importances if imp.useful]
    full_error = mean_abs_log_error(y_valid, full.predict(x_valid[columns_of(all_groups)]))
    if set(kept) == set(all_groups):
        return all_groups, importances, {"full": full_error, "reduced": full_error, "best_iteration": full.best_iteration}, full
    reduced = fit_lightgbm(x_train[columns_of(kept)], y_train, x_valid[columns_of(kept)], y_valid, training)
    reduced_error = mean_abs_log_error(y_valid, reduced.predict(x_valid[columns_of(kept)]))
    # simpler model wins ties (within 0.1 % relative)
    chosen = kept if reduced_error <= full_error * 1.001 else all_groups
    best = reduced if chosen is kept else full
    return chosen, importances, {"full": full_error, "reduced": reduced_error, "best_iteration": best.best_iteration}, best


def fit_ridge_baseline(x_train: pd.DataFrame, y_train: np.ndarray):
    """Hedonic linear model on the same features (the classic method behind price indices)."""
    model = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), Ridge(alpha=1.0))
    return model.fit(x_train, y_train)


@dataclass
class ConformalIntervals:
    """Residual quantiles per segment, measured out of time, added to the log prediction."""

    table: pd.DataFrame  # columns: segment, low, high, n
    coverage: float

    @staticmethod
    def segment(rows: pd.DataFrame, encodings: pd.DataFrame) -> pd.Series:
        density = pd.cut(encodings["n_section"], [-1, 9, 99, np.inf], labels=["sparse", "medium", "dense"])
        return rows["property_type"].astype(str) + "/" + density.astype(str)

    @classmethod
    def fit(cls, segments: pd.Series, residuals: np.ndarray, coverage: float) -> "ConformalIntervals":
        tail = (1 - coverage) / 2
        frame = pd.DataFrame({"segment": segments.to_numpy(), "r": residuals})
        table = frame.groupby("segment")["r"].agg(
            low=lambda r: r.quantile(tail), high=lambda r: r.quantile(1 - tail), n="size"
        ).reset_index()
        overall = pd.DataFrame(
            {"segment": ["*"], "low": [np.quantile(residuals, tail)], "high": [np.quantile(residuals, 1 - tail)],
             "n": [len(residuals)]}
        )
        return cls(pd.concat([table, overall], ignore_index=True), coverage)

    def bounds(self, segments: pd.Series) -> tuple[np.ndarray, np.ndarray]:
        lookup = self.table.set_index("segment")
        fallback = lookup.loc["*"]
        low = segments.map(lookup["low"]).fillna(fallback["low"]).to_numpy()
        high = segments.map(lookup["high"]).fillna(fallback["high"]).to_numpy()
        return low, high


def price_metrics(log_true: np.ndarray, log_pred: np.ndarray, low=None, high=None) -> dict:
    """Errors on the price itself (not the log): MdAPE, share within ±10 % / ±20 %, coverage."""
    ape = np.abs(np.exp(log_pred - log_true) - 1)
    metrics = {
        "n": int(len(ape)),
        "mdape": float(np.median(ape)),
        "within_10pct": float(np.mean(ape <= 0.10)),
        "within_20pct": float(np.mean(ape <= 0.20)),
        "bias_median": float(np.median(np.exp(log_pred - log_true) - 1)),
    }
    if low is not None:
        metrics["interval_coverage"] = float(np.mean((log_true >= log_pred + low) & (log_true <= log_pred + high)))
        metrics["interval_median_width"] = float(np.median(np.exp(high) - np.exp(low)))
    return metrics


def metrics_by_segment(frame: pd.DataFrame, by: str) -> list[dict]:
    rows = []
    for key, part in frame.groupby(by, observed=True):
        rows.append({by: str(key)} | price_metrics(
            part["log_true"].to_numpy(), part["log_pred"].to_numpy(), part["low"].to_numpy(), part["high"].to_numpy()
        ))
    return rows
