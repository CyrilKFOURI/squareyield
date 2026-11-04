"""Load a packaged price-check model and estimate properties.

Standalone on purpose (numpy, pandas, lightgbm only): this file and features.py are copied
into the model folder, so the published model works without the rest of the project:

    from inference import PriceCheckModel
    model = PriceCheckModel.load("path/to/model")
    model.estimate([{"property_type": "apartment", "surface_m2": 45, "rooms": 2,
                     "code_commune": "49007", "section": "49007000BK", "asked_price": 150000}])
"""
import json
from dataclasses import dataclass
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

try:  # inside the rea_ml package
    from .features import FEATURE_GROUPS, LocationEncoder, build_features
except ImportError:  # inside a published model folder
    from features import FEATURE_GROUPS, LocationEncoder, build_features

ASSUMPTIONS = {"land_m2": 0.0, "n_dependencies": 0, "n_lots": 1, "is_new_build": False, "rooms": None}


@dataclass
class PriceCheckModel:
    booster: lgb.Booster
    spec: dict
    encoder: LocationEncoder
    socio: pd.DataFrame
    section_points: pd.DataFrame
    commune_points: pd.DataFrame
    intervals: pd.DataFrame

    @classmethod
    def load(cls, folder: str | Path) -> "PriceCheckModel":
        folder = Path(folder)
        spec = json.loads((folder / "feature_spec.json").read_text(encoding="utf-8"))
        encoding = spec["encoding"]
        encoder = LocationEncoder(
            tables={level: pd.read_parquet(folder / "encodings" / f"{level}.parquet") for level in encoding["levels"]},
            global_means=pd.Series(encoding["global_means"]),
            levels=tuple(encoding["levels"]),
            smoothing=encoding["smoothing"],
        )
        return cls(
            booster=lgb.Booster(model_file=str(folder / "model.txt")),
            spec=spec,
            encoder=encoder,
            socio=pd.read_parquet(folder / "context" / "commune_socio.parquet"),
            section_points=pd.read_parquet(folder / "context" / "section_points.parquet"),
            commune_points=pd.read_parquet(folder / "context" / "commune_points.parquet"),
            intervals=pd.DataFrame(json.loads((folder / "intervals.json").read_text(encoding="utf-8"))["table"]),
        )

    def _rows(self, properties: list[dict]) -> pd.DataFrame:
        # user coordinates are ignored on purpose: the model was trained on section points
        rows = pd.DataFrame([ASSUMPTIONS | p for p in properties]).drop(
            columns=["longitude", "latitude"], errors="ignore"
        )
        rows["code_departement"] = rows["code_commune"].str.slice(0, 3).where(
            rows["code_commune"].str.startswith("97"), rows["code_commune"].str.slice(0, 2)
        )
        rows["surface_carrez_m2"] = np.where(rows["property_type"] == "apartment", rows["surface_m2"], np.nan)
        if "section" not in rows:
            rows["section"] = None
        # same location rule as training: the section's point, else the commune's point
        rows = rows.merge(self.section_points, on="section", how="left")
        rows = rows.merge(self.commune_points, left_on="code_commune", right_on="code", how="left",
                          suffixes=("", "_commune"))
        on_section = rows["longitude"].notna()
        rows["location_precision"] = np.where(on_section, "section", "commune")
        rows["longitude"] = rows["longitude"].fillna(rows["longitude_commune"])
        rows["latitude"] = rows["latitude"].fillna(rows["latitude_commune"])
        if rows["longitude"].isna().any():
            unknown = rows.loc[rows["longitude"].isna(), "code_commune"].tolist()
            raise ValueError(f"No location known for communes {unknown} (Alsace-Moselle and Mayotte are not in DVF)")
        return rows

    def estimate(self, properties: list[dict]) -> list[dict]:
        rows = self._rows(properties)
        encodings = self.encoder.transform(rows)
        columns = self.spec["feature_columns"]
        x = build_features(rows, encodings, self.socio)[columns]
        log_pred = self.booster.predict(x)
        contributions = self.booster.predict(x, pred_contrib=True)

        density = pd.cut(encodings["n_section"], [-1, 9, 99, np.inf], labels=["sparse", "medium", "dense"])
        segments = rows["property_type"].astype(str) + "/" + density.astype(str)
        lookup = self.intervals.set_index("segment")
        low = segments.map(lookup["low"]).fillna(lookup.loc["*", "low"]).to_numpy()
        high = segments.map(lookup["high"]).fillna(lookup.loc["*", "high"]).to_numpy()

        results = []
        for i, prop in enumerate(properties):
            surface = float(rows.at[i, "surface_m2"])
            result = {
                "price_m2": float(np.exp(log_pred[i])),
                "price": float(np.exp(log_pred[i]) * surface),
                "price_low": float(np.exp(log_pred[i] + low[i]) * surface),
                "price_high": float(np.exp(log_pred[i] + high[i]) * surface),
                "interval_coverage": self.spec["interval_coverage"],
                "location_precision": rows.at[i, "location_precision"],
                "data_density": str(density.iloc[i]),
                "explanation": self._explain(contributions[i], columns),
                "reference_period": self.spec["reference_period"],
            }
            if prop.get("asked_price"):
                gap = np.log(prop["asked_price"] / surface) - log_pred[i]
                result["asked_vs_estimate"] = float(np.exp(gap) - 1)
                result["verdict"] = "below" if gap < low[i] else "above" if gap > high[i] else "consistent"
            results.append(result)
        return results

    def _explain(self, contribution: np.ndarray, columns: list[str]) -> dict:
        """Exact TreeSHAP values grouped like the features, as multiplicative effects on €/m²:
        base × Π(1 + effect) = estimate."""
        by_column = dict(zip(columns, contribution[:-1]))
        groups = {
            group: float(sum(by_column.get(c, 0.0) for c in cols))
            for group, cols in FEATURE_GROUPS.items()
            if any(c in by_column for c in cols)
        }
        ordered = sorted(groups.items(), key=lambda item: -abs(item[1]))
        return {
            "base_price_m2": float(np.exp(contribution[-1])),
            "effects": [{"group": g, "log_effect": v, "effect_pct": float(np.exp(v) - 1)} for g, v in ordered],
        }
