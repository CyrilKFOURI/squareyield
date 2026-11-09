"""Export a packaged model for the browser (docs/features/022-full-frontend/spec.md rule 2).

    uv run rea-ml export-web [model folder]      # default: latest compact model

data/serve/estimate/
  model.json        trees as flat arrays + feature columns, encodings settings, intervals
  <dep>.json        per département: its price level, communes (point, INSEE context, price level)
                    and sections (point, price level) — everything features.py needs for one address
and <model folder>/web_golden.json: 200 properties with python's features, LightGBM's predictions and SHAP
values (the export fails if the JSON trees disagree with LightGBM on them). The app test fixture
(apps/app/src/data/price-model.fixture.json) comes from the synthetic test model: tests/test_web_export.py.

Tree arrays follow LightGBM's own layout: internal nodes 0..n-1, a child index < 0 is leaf ~child.
decision bits: 1 = categorical, 2 = default left, (bits 2-3) missing type 0 None, 1 Zero, 2 NaN.
Nothing here uploads anything.
"""
import json
import math
import shutil
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from .config import COMPACT_MODEL_NAME, DATA_DIR, MODELS_DIR
from .features import build_features
from .inference import PriceCheckModel

SERVE_ESTIMATE = DATA_DIR / "serve" / "estimate"
SOCIO_FIELDS = ("population", "population_growth_yearly", "vacancy_rate", "second_home_share", "renter_share",
                "median_living_standard", "jobs_growth_yearly")
TYPES = ("apartment", "house")
MISSING_TYPES = {"None": 0, "Zero": 1, "NaN": 2}
ZERO_THRESHOLD = 1e-35  # LightGBM kZeroThreshold
GOLDEN_ROWS = 200


def latest_compact_folder() -> Path:
    folders = sorted(p for p in (MODELS_DIR / COMPACT_MODEL_NAME).glob("*") if (p / "model.txt").exists())
    if not folders:
        raise FileNotFoundError(f"No compact model in {MODELS_DIR / COMPACT_MODEL_NAME}: run `uv run rea-ml train --compact`")
    return folders[-1]


def departement_of(code_commune: str) -> str:
    return code_commune[:3] if code_commune.startswith("97") else code_commune[:2]


# ---------------------------------------------------------------- trees

def flatten_tree(structure: dict) -> dict:
    """LightGBM dump_model tree -> flat arrays (same node numbering as LightGBM)."""
    if "leaf_value" in structure and "split_index" not in structure:  # a tree with a single leaf
        return {"f": [], "t": [], "d": [], "l": [], "r": [], "c": [], "v": [structure["leaf_value"]],
                "n": [structure.get("leaf_count", 0)], "cats": []}
    nodes: dict[int, dict] = {}
    leaves: dict[int, dict] = {}

    def visit(node: dict) -> int:
        if "split_index" not in node:
            leaves[node["leaf_index"]] = node
            return ~node["leaf_index"]
        nodes[node["split_index"]] = node
        node["_l"], node["_r"] = visit(node["left_child"]), visit(node["right_child"])
        return node["split_index"]

    visit(structure)
    tree = {"f": [], "t": [], "d": [], "l": [], "r": [], "c": [], "v": [], "n": [], "cats": []}
    for i in range(len(nodes)):
        node = nodes[i]
        categorical = node["decision_type"] == "=="
        flags = (1 if categorical else 0) | (2 if node["default_left"] else 0) | (MISSING_TYPES[node["missing_type"]] << 2)
        if categorical:
            tree["cats"].append([int(c) for c in str(node["threshold"]).split("||")])
            threshold = len(tree["cats"]) - 1
        else:
            threshold = float(node["threshold"])
        tree["f"].append(node["split_feature"])
        tree["t"].append(threshold)
        tree["d"].append(flags)
        tree["l"].append(node["_l"])
        tree["r"].append(node["_r"])
        tree["c"].append(node["internal_count"])
    for i in range(len(leaves)):
        tree["v"].append(leaves[i]["leaf_value"])
        tree["n"].append(leaves[i]["leaf_count"])
    return tree


def goes_left(tree: dict, node: int, value: float) -> bool:
    """LightGBM Tree::NumericalDecision / CategoricalDecision."""
    flags = tree["d"][node]
    missing = (flags >> 2) & 3
    if flags & 1:
        if math.isnan(value):
            if missing == 2:
                return False
            value = 0.0
        category = int(value)
        return category >= 0 and category in tree["cats"][int(tree["t"][node])]
    if math.isnan(value) and missing != 2:
        value = 0.0
    if (missing == 1 and abs(value) <= ZERO_THRESHOLD) or (missing == 2 and math.isnan(value)):
        return bool(flags & 2)
    return value <= tree["t"][node]


def predict_tree(tree: dict, row) -> float:
    if not tree["f"]:
        return tree["v"][0]
    node = 0
    while node >= 0:
        node = tree["l"][node] if goes_left(tree, node, float(row[tree["f"][node]])) else tree["r"][node]
    return tree["v"][~node]


def predict_trees(trees: list[dict], x: np.ndarray) -> np.ndarray:
    return np.array([sum(predict_tree(tree, row) for tree in trees) for row in x])


def booster_trees(booster: lgb.Booster) -> list[dict]:
    return [flatten_tree(info["tree_structure"]) for info in booster.dump_model()["tree_info"]]


# ---------------------------------------------------------------- context per département

def _type_pairs(table: pd.DataFrame, key: str) -> dict[str, list]:
    """key -> [apartment mean, apartment n, house mean, house n] (null when not published)."""
    out: dict[str, list] = {}
    for row in table.itertuples(index=False):
        values = out.setdefault(getattr(row, key), [None, 0, None, 0])
        i = 2 * TYPES.index(row.property_type)
        values[i], values[i + 1] = float(row.mean), int(row.n)
    return out


def _clean(value):
    return None if value is None or (isinstance(value, float) and math.isnan(value)) else value


def departement_files(model: PriceCheckModel) -> dict[str, dict]:
    tables = model.encoder.tables
    deps = _type_pairs(tables["code_departement"], "code_departement")
    communes_enc = _type_pairs(tables["code_commune"], "code_commune")
    sections_enc = _type_pairs(tables["section"], "section")
    socio = model.socio.set_index("code_commune")
    files: dict[str, dict] = {}

    def file_of(dep: str) -> dict:
        return files.setdefault(dep, {
            "departement": dep, "enc": deps.get(dep, [None, 0, None, 0]),
            "commune_fields": ["longitude", "latitude", *SOCIO_FIELDS, "ap_mean", "ap_n", "ho_mean", "ho_n"],
            "communes": {},
            "section_fields": ["section", "longitude", "latitude", "ap_mean", "ap_n", "ho_mean", "ho_n"],
            "sections": [],
        })

    codes = set(model.commune_points["code"]) | set(socio.index) | set(communes_enc)
    points = model.commune_points.set_index("code")
    for code in sorted(codes):
        point = points.loc[code] if code in points.index else None
        context = [_clean(float(socio.at[code, f])) if code in socio.index else None for f in SOCIO_FIELDS]
        file_of(departement_of(code))["communes"][code] = [
            None if point is None else float(point["longitude"]), None if point is None else float(point["latitude"]),
            *context, *communes_enc.get(code, [None, 0, None, 0]),
        ]
    for row in model.section_points.sort_values("section").itertuples(index=False):
        section = row.section
        file_of(departement_of(section[:5]))["sections"].append(
            [section, float(row.longitude), float(row.latitude), *sections_enc.get(section, [None, 0, None, 0])])
    for section in sorted(set(sections_enc) - set(model.section_points["section"])):  # encoding without point
        file_of(departement_of(section[:5]))["sections"].append([section, None, None, *sections_enc[section]])
    return files


# ---------------------------------------------------------------- golden vectors

def golden_rows(model: PriceCheckModel, n: int = GOLDEN_ROWS, seed: int = 0) -> list[dict]:
    """Random properties in random sections (some with missing context), as the app would send them."""
    rng = np.random.default_rng(seed)
    points = model.section_points
    sections = points.sample(n, random_state=seed, replace=len(points) < n)["section"].tolist()
    rows = []
    for i, section in enumerate(sections):
        house = bool(rng.random() < 0.5)
        surface = float(np.round(rng.uniform(12, 220), 1))
        rows.append({
            "property_type": "house" if house else "apartment", "surface_m2": surface,
            "rooms": None if i % 17 == 0 else int(rng.integers(0 if i % 23 == 0 else 1, 8)),
            "land_m2": float(np.round(rng.uniform(0, 2000))) if house else 0.0,
            "n_dependencies": int(rng.integers(0, 3)), "n_lots": int(rng.integers(1, 4)),
            "is_new_build": bool(rng.random() < 0.1), "code_commune": section[:5],
            "section": None if i % 11 == 0 else section,
        })
    return rows


def golden(model: PriceCheckModel, trees: list[dict], n: int = GOLDEN_ROWS) -> dict:
    """Properties, every candidate feature python builds for them, LightGBM predictions and SHAP values."""
    props = golden_rows(model, n)
    rows = model._rows(props)
    encodings = model.encoder.transform(rows)
    columns = model.spec["feature_columns"]
    every = build_features(rows, encodings, model.socio)
    x = every[columns].to_numpy(dtype=np.float64)
    predicted = model.booster.predict(x)
    ours = predict_trees(trees, x)
    if not np.allclose(predicted, ours, rtol=0, atol=1e-9):
        raise AssertionError(f"JSON trees disagree with LightGBM: max gap {np.max(np.abs(predicted - ours))}")
    contributions = model.booster.predict(x, pred_contrib=True)
    clean = lambda values: [None if math.isnan(v) else float(v) for v in values]  # noqa: E731
    return {"properties": props, "feature_names": list(every.columns),
            "all_features": [clean(r) for r in every.to_numpy(dtype=np.float64)],
            "features": [clean(r) for r in x], "predictions": predicted.tolist(),
            "contributions": contributions.tolist(),
            "estimates": model.estimate(props, explain=True)}


# ---------------------------------------------------------------- write

def _dump(path: Path, content: dict) -> int:
    text = json.dumps(content, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.write_text(text, encoding="utf-8")
    return len(text)


def export_web(folder: Path, out: Path = SERVE_ESTIMATE) -> Path:
    model = PriceCheckModel.load(folder)
    trees = booster_trees(model.booster)
    staging = out.with_name(out.name + ".staging")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    spec = model.spec
    _dump(staging / "model.json", {
        "model_version": f"{spec['model']}/{folder.name}",
        "reference_period": spec["reference_period"],
        "feature_columns": spec["feature_columns"],
        "feature_groups": spec["feature_groups"],
        "encoding": {"smoothing": spec["encoding"]["smoothing"], "global_means": spec["encoding"]["global_means"]},
        "interval_coverage": spec["interval_coverage"],
        "intervals": {r["segment"]: [r["low"], r["high"]] for r in model.intervals.to_dict("records")},
        "trees": trees,
    })
    for dep, content in departement_files(model).items():
        _dump(staging / f"{dep}.json", content)
    _dump(folder / "web_golden.json", golden(model, trees))  # checks the export; not served
    shutil.rmtree(out, ignore_errors=True)
    staging.rename(out)
    return out
