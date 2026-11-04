"""Feature engineering: time index, location target encodings, property and context features.

Everything that learns from prices (time index, encodings) is fitted on training rows only
and stored, so the exact same transformation is replayed at prediction time.

This module only needs numpy and pandas: it is shipped inside the published model folder
next to inference.py.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

KEY = ["property_type"]  # every learned table is per property type

# Feature groups: selection keeps or drops a whole group (correlated columns move together).
FEATURE_GROUPS: dict[str, list[str]] = {
    "type": ["is_house"],
    "new_build": ["is_new_build"],
    "surface": ["log_surface"],
    "rooms": ["rooms", "surface_per_room"],
    "land": ["log_land", "has_land"],
    "dependencies": ["n_dependencies"],
    "lots": ["n_lots"],
    "carrez": ["has_carrez"],
    "coordinates": ["longitude", "latitude", "diag_a", "diag_b"],
    "location_precision": ["coarse_location"],
    "enc_section": ["enc_section", "log_n_section"],
    "enc_commune": ["enc_commune", "log_n_commune"],
    "enc_departement": ["enc_departement"],
    "population": ["log_population", "population_growth_yearly"],
    "housing_market": ["vacancy_rate", "second_home_share", "renter_share"],
    "income": ["median_living_standard"],
    "jobs": ["jobs_growth_yearly"],
}
ENCODED_LEVELS = {"section": "enc_section", "code_commune": "enc_commune", "code_departement": "enc_departement"}


@dataclass
class TimeIndex:
    """log price/m² level of each (département, type, half-year) relative to the reference period."""

    table: pd.DataFrame  # columns: code_departement, property_type, period, index
    reference_period: str

    @classmethod
    def fit(cls, sales: pd.DataFrame) -> "TimeIndex":
        existing = sales[~sales["is_new_build"]]
        medians = (
            existing.groupby(["code_departement", "property_type", "period"])["log_price_m2"]
            .median()
            .rename("level")
            .reset_index()
        )
        reference = medians["period"].max()
        last = medians[medians["period"] == reference].drop(columns="period").rename(columns={"level": "ref"})
        table = medians.merge(last, on=["code_departement", "property_type"], how="left")
        table["index"] = (table["level"] - table["ref"]).fillna(0.0)
        return cls(table[["code_departement", "property_type", "period", "index"]], reference)

    def lookup(self, rows: pd.DataFrame) -> np.ndarray:
        """Index of each row's own period; periods after the reference (future) count as 0."""
        merged = rows[["code_departement", "property_type", "period"]].merge(
            self.table, on=["code_departement", "property_type", "period"], how="left"
        )
        return merged["index"].fillna(0.0).to_numpy()


@dataclass
class LocationEncoder:
    """Smoothed hierarchical mean of the time-adjusted target: département ← commune ← section."""

    tables: dict[str, pd.DataFrame]  # level -> columns: level key, property_type, mean, n
    global_means: pd.Series  # per property type
    levels: tuple[str, ...]  # fine to coarse
    smoothing: float

    @classmethod
    def fit(cls, rows: pd.DataFrame, target: np.ndarray, levels: tuple[str, ...], smoothing: float) -> "LocationEncoder":
        frame = rows[["property_type", *levels]].copy()
        frame["y"] = target
        tables = {
            level: frame.groupby([level, *KEY])["y"].agg(mean="mean", n="size").reset_index()
            for level in levels
        }
        return cls(tables, frame.groupby("property_type")["y"].mean(), levels, smoothing)

    def transform(self, rows: pd.DataFrame) -> pd.DataFrame:
        """Each level shrinks towards the level above it: (n·mean + m·parent) / (n + m)."""
        out = pd.DataFrame(index=rows.index)
        parent = rows["property_type"].map(self.global_means).fillna(self.global_means.mean()).to_numpy()
        m = self.smoothing
        # coarse to fine, so each level's prior is the smoothed level above
        for level in reversed(self.levels):
            stats = rows[[level, *KEY]].merge(self.tables[level], on=[level, *KEY], how="left")
            n = stats["n"].fillna(0.0).to_numpy()
            mean = stats["mean"].fillna(0.0).to_numpy()
            encoded = (n * mean + m * parent) / (n + m)
            out[ENCODED_LEVELS[level]] = encoded
            out[f"n_{level}"] = n
            parent = encoded
        return out

    def published(self, min_sales: int) -> "LocationEncoder":
        """Copy without areas under min_sales: a published average of 1–9 sales would reveal
        individual prices (DVF re-identification rule). Those areas fall back to the level above."""
        tables = {level: t[t["n"] >= min_sales].reset_index(drop=True) for level, t in self.tables.items()}
        return LocationEncoder(tables, self.global_means, self.levels, self.smoothing)


def build_features(rows: pd.DataFrame, encodings: pd.DataFrame, socio: pd.DataFrame) -> pd.DataFrame:
    """Model matrix with every candidate column of FEATURE_GROUPS."""
    context = rows[["code_commune"]].merge(socio, on="code_commune", how="left")
    lat_scale = np.cos(np.radians(rows["latitude"].to_numpy()))
    features = pd.DataFrame(
        {
            "is_house": (rows["property_type"] == "house").astype(np.int8),
            "is_new_build": rows["is_new_build"].astype(np.int8),
            "log_surface": np.log(rows["surface_m2"]),
            "rooms": rows["rooms"].astype("float64"),
            "surface_per_room": rows["surface_m2"] / rows["rooms"].where(rows["rooms"] > 0),
            "log_land": np.log1p(rows["land_m2"]),
            "has_land": (rows["land_m2"] > 0).astype(np.int8),
            "n_dependencies": rows["n_dependencies"].astype("float64"),
            "n_lots": rows["n_lots"].astype("float64"),
            "has_carrez": rows["surface_carrez_m2"].notna().astype(np.int8),
            "longitude": rows["longitude"],
            "latitude": rows["latitude"],
            # rotated coordinates let trees draw diagonal boundaries with fewer splits
            "diag_a": rows["longitude"] * lat_scale + rows["latitude"],
            "diag_b": rows["longitude"] * lat_scale - rows["latitude"],
            "coarse_location": (rows["location_precision"] != "section").astype(np.int8),
            "log_population": np.log1p(context["population"].to_numpy()),
            "population_growth_yearly": context["population_growth_yearly"].to_numpy(),
            "vacancy_rate": context["vacancy_rate"].to_numpy(),
            "second_home_share": context["second_home_share"].to_numpy(),
            "renter_share": context["renter_share"].to_numpy(),
            "median_living_standard": context["median_living_standard"].to_numpy(),
            "jobs_growth_yearly": context["jobs_growth_yearly"].to_numpy(),
        },
        index=rows.index,
    )
    for column in ENCODED_LEVELS.values():
        features[column] = encodings[column].to_numpy()
    features["log_n_section"] = np.log1p(encodings["n_section"].to_numpy())
    features["log_n_commune"] = np.log1p(encodings["n_code_commune"].to_numpy())
    return features


def columns_of(groups: list[str]) -> list[str]:
    return [column for group in groups for column in FEATURE_GROUPS[group]]
