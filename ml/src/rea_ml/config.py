"""Every choice of the training recipe lives here, so a run is fully described by this file,
the data run_id and the code commit (written to the model card)."""
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = PROJECT_ROOT / "data"
SALES_PATH = DATA_DIR / "clean" / "dvf" / "sales.parquet"
MARTS_DIR = DATA_DIR / "marts"
MODELS_DIR = DATA_DIR / "models"

MODEL_NAME = "rea-price-check-fr"


@dataclass(frozen=True)
class Split:
    """Out-of-time split: the model is always judged on sales after the ones it learned from."""

    train_until: str = "2024-12-31"
    valid_until: str = "2025-06-30"  # 2025-H1: early stopping, feature selection, calibration of the recipe
    # test = everything after valid_until (2025-H2 and 2026-H1): looked at once, at the end


@dataclass(frozen=True)
class Cleaning:
    """Rules applied identically to every split (they never use the test labels)."""

    min_price_m2: float = 300.0
    max_price_m2: float = 30_000.0
    min_surface_m2: float = 9.0
    max_surface_m2: float = 1_000.0
    max_land_m2: float = 100_000.0
    max_rooms: int = 20


@dataclass(frozen=True)
class Encoding:
    """Target encodings of location (mean log price/m² of the area, per property type)."""

    levels: tuple[str, ...] = ("section", "code_commune", "code_departement")
    smoothing: float = 20.0  # pseudo-sales pulling small areas towards the level above
    n_folds: int = 5  # out-of-fold encodings on training rows (no target leakage)
    min_published_sales: int = 10  # areas with fewer sales are not shipped with the model (DVF re-identification rule)


@dataclass(frozen=True)
class Training:
    seed: int = 42
    params: dict = field(
        default_factory=lambda: {
            "objective": "huber",  # robust to the non-market sales that cleaning cannot catch
            "alpha": 0.35,  # huber threshold on log price: errors above ~40 % count linearly
            "learning_rate": 0.1,
            "num_leaves": 127,
            "min_data_in_leaf": 200,
            "feature_fraction": 0.8,
            "bagging_fraction": 0.8,
            "bagging_freq": 1,
            "lambda_l2": 1.0,
            "verbose": -1,
        }
    )
    max_rounds: int = 8_000  # 3 000 was hit by the first run (best iteration 2 998): early stopping decides
    early_stopping_rounds: int = 100
    # feature selection compares groups: a 1 M-sale subsample of the training period is enough
    selection_train_sample: int = 1_000_000
    selection_sample: int = 300_000  # validation rows used for permutation importance
    selection_repeats: int = 3
    interval_coverage: float = 0.80  # P10–P90


@dataclass(frozen=True)
class Config:
    split: Split = Split()
    cleaning: Cleaning = Cleaning()
    encoding: Encoding = Encoding()
    training: Training = Training()
