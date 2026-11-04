"""Write a self-contained model folder, laid out for a Hugging Face model repository.

Nothing here uploads anything: publishing is a separate, manual decision.

<folder>/
  README.md                 model card (YAML metadata + description, generated from the report)
  model.txt                 LightGBM model (plain text, no pickle)
  feature_spec.json         feature columns, groups, encoding settings, reference period
  intervals.json            conformal residual quantiles per segment
  metrics.json              full evaluation report
  encodings/<level>.parquet location averages (areas with ≥ min_published_sales sales only)
  context/*.parquet         INSEE context per commune, section and commune points
  time_index.parquet        price level per département, type and half-year
  inference.py, features.py standalone code to load and run the model
"""
import json
import shutil
import subprocess
from dataclasses import asdict
from importlib.metadata import version
from pathlib import Path

import duckdb

from .config import MARTS_DIR, MODEL_NAME, PROJECT_ROOT, Config
from .features import FEATURE_GROUPS
from .train import TrainingResult

GROUP_LABELS = {
    "type": "Apartment or house", "new_build": "New build (VEFA)", "surface": "Living area",
    "rooms": "Rooms and area per room", "land": "Land area", "dependencies": "Dependencies (parking, cellar)",
    "lots": "Number of lots in the sale", "carrez": "Carrez area declared", "coordinates": "Coordinates",
    "location_precision": "Location precision", "enc_section": "Price level of the cadastral section",
    "enc_commune": "Price level of the commune", "enc_departement": "Price level of the département",
    "population": "Population and growth", "housing_market": "Vacancy, second homes, renters",
    "income": "Median living standard", "jobs": "Job growth",
}


def _git_commit() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=PROJECT_ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def _latest_data_run() -> str:
    runs = sorted((PROJECT_ROOT / "data" / "runs").glob("*/manifest.json"))
    for manifest in reversed(runs):
        content = json.loads(manifest.read_text(encoding="utf-8"))
        if content.get("status") == "success":
            return content["run_id"]
    return "unknown"


def _pct(value: float) -> str:
    return f"{value * 100:.1f} %"


def _model_card(result: TrainingResult, config: Config, provenance: dict) -> str:
    r = result.report
    test, base = r["test"], r["baselines_test"]
    rows = "\n".join(
        f"| {name} | {_pct(m['mdape'])} | {_pct(m['within_10pct'])} | {_pct(m['within_20pct'])} |"
        for name, m in (("**This model (LightGBM)**", test), ("Linear hedonic", base["linear_hedonic"]),
                        ("Commune average", base["commune_average"]))
    )
    segments = "\n".join(
        f"| {by} | {s[by]} | {s['n']:,} | {_pct(s['mdape'])} | {_pct(s['within_20pct'])} | {_pct(s['interval_coverage'])} |"
        for by, items in r["test_by_segment"].items() for s in items
    )
    kept = ", ".join(GROUP_LABELS[g] for g in result.selected_groups)
    dropped = ", ".join(GROUP_LABELS[g] for g in r["selection"]["dropped_groups"]) or "none"
    split = r["split"]
    return f"""---
language: fr
library_name: lightgbm
pipeline_tag: tabular-regression
license: mit
tags: [real-estate, france, dvf, price-estimation, tabular-regression, lightgbm, shap]
model-index:
- name: {MODEL_NAME}
  results:
  - task: {{type: tabular-regression, name: Price per m² of French residential sales}}
    dataset: {{type: dvf, name: Demandes de valeurs foncières (DGFiP), out-of-time test {split['test']['from']} → {split['test']['to']}}}
    metrics:
    - {{type: mdape, value: {test['mdape']:.4f}, name: Median absolute percentage error}}
    - {{type: within_20pct, value: {test['within_20pct']:.4f}, name: Share within ±20 %}}
    - {{type: interval_coverage, value: {test['interval_coverage']:.4f}, name: P10–P90 interval coverage}}
---

# {MODEL_NAME}

Estimates the market price of a French apartment or house (€/m² and total) from its
characteristics and location, with an 80 % interval and an exact explanation of each estimate.
Built to answer one question: **is the asked price of this property consistent with what the
market has paid for similar properties nearby?**

> Version {provenance['version']}. Part of the Cyfouri project (French rental-investment analytics).

## What it learned from
- **Data:** every single-dwelling residential sale in DVF (signed notarial deeds, DGFiP) from
  {split['train']['from']} to {split['test']['to']}: {r['final_model']['n_sales']:,} sales after cleaning.
  No data for Bas-Rhin, Haut-Rhin, Moselle and Mayotte (not in DVF).
- **Past signed prices, not asking prices.** Listings are usually a few percent higher before negotiation.
- **What DVF cannot see:** condition, floor, view, balcony, exact address, energy rating. Two flats of
  the same size in the same street can differ by 20 % for those reasons: the interval reflects it.

## How it works
- **Target:** log(price per m²), with the département-level price trend removed (half-year index), so
  the trees learn price *levels* and the latest market level ({r['final_model']['reference_period']}) is added back.
- **Location:** every sale is placed at the centre of its cadastral section (median 250 m from the
  parcel), for training and prediction alike, plus smoothed price levels of section, commune and
  département, computed out-of-fold to avoid target leakage.
- **Feature selection:** grouped permutation importance on the validation period; a group is kept only
  if shuffling it hurts more than its own noise. Kept: {kept}. Dropped: {dropped}.
- **One model:** LightGBM, Huber loss, early stopping on the validation period
  ({r['best_iteration']} rounds), retrained on all sales with {r['final_model']['rounds']} rounds.
- **Interval:** split-conformal, from out-of-time residuals per type and data density.
- **Explanation:** exact TreeSHAP values (LightGBM `pred_contrib`), grouped by feature family.

## Out-of-time evaluation
Learned on {split['train']['from']} → {split['train']['to']}, tuned on {split['valid']['from']} → {split['valid']['to']},
measured once on {split['test']['n']:,} later sales ({split['test']['from']} → {split['test']['to']}).

| Model | Median abs. error | Within ±10 % | Within ±20 % |
|---|---|---|---|
{rows}

P10–P90 interval: coverage {_pct(test['interval_coverage'])} (target {_pct(config.training.interval_coverage)}),
median width {_pct(test['interval_median_width'])} of the price.

| Segment | Value | Sales | Median abs. error | Within ±20 % | Interval coverage |
|---|---|---|---|---|---|
{segments}

## Use
```python
from inference import PriceCheckModel
model = PriceCheckModel.load(".")
model.estimate([{{"property_type": "apartment", "surface_m2": 45, "rooms": 2,
                 "code_commune": "49007", "section": "49007000BK", "asked_price": 150000}}])
```
Returns the estimate, P10–P90 bounds, a verdict (below / consistent / above) and the effects.

## Limits and responsible use
- An estimate, not an appraisal. It describes what the data can see; adjust for condition.
- Areas with few sales get wide intervals; the app shows "not enough data" there.
- Published location averages only cover areas with at least {config.encoding.min_published_sales} sales,
  and every tree leaf holds at least {config.training.params['min_data_in_leaf']} sales, so no individual sale
  price can be read back.

## Data licence and conditions
Trained on *Demandes de valeurs foncières* (DGFiP), published on data.gouv.fr under the Licence Ouverte /
Etalab 2.0: « Source : DGFiP, Demandes de valeurs foncières ». The DVF conditions of use apply to any
reuse: no réidentification of the people involved in a sale, and no indexing of the data by search
engines. This model ships aggregates only (see above); do not use it to rebuild individual sales.

## Provenance
Code commit `{provenance['commit']}`, data run `{provenance['data_run']}`, LightGBM {provenance['lightgbm']}.
Full report: `metrics.json`. Training configuration: `feature_spec.json`.
"""


def write_package(result: TrainingResult, config: Config, folder: Path) -> Path:
    if folder.exists():
        shutil.rmtree(folder)
    (folder / "encodings").mkdir(parents=True)
    (folder / "context").mkdir()
    provenance = {"version": folder.name, "commit": _git_commit(), "data_run": _latest_data_run(),
                  "lightgbm": version("lightgbm")}

    result.final_model.save_model(str(folder / "model.txt"))
    for level, table in result.encoder.tables.items():
        table.to_parquet(folder / "encodings" / f"{level}.parquet", index=False)
    result.time_index.table.to_parquet(folder / "time_index.parquet", index=False)
    result.socio.to_parquet(folder / "context" / "commune_socio.parquet", index=False)
    for table, name in (("section_point", "section_points"), ("commune_point", "commune_points")):
        duckdb.sql(f"SELECT * FROM '{(MARTS_DIR / f'{table}.parquet').as_posix()}'").df().to_parquet(
            folder / "context" / f"{name}.parquet", index=False
        )

    spec = {
        "model": MODEL_NAME,
        "target": "log(price_m2) minus département half-year index; prediction = latest market level",
        "reference_period": result.time_index.reference_period,
        "feature_columns": result.feature_columns,
        "feature_groups": {g: FEATURE_GROUPS[g] for g in result.selected_groups},
        "encoding": {"levels": list(result.encoder.levels), "smoothing": result.encoder.smoothing,
                     "global_means": result.encoder.global_means.to_dict(),
                     "min_published_sales": config.encoding.min_published_sales},
        "interval_coverage": config.training.interval_coverage,
        "config": asdict(config),
        "provenance": provenance,
    }
    (folder / "feature_spec.json").write_text(json.dumps(spec, indent=2, default=str), encoding="utf-8")
    (folder / "intervals.json").write_text(
        json.dumps({"coverage": result.intervals.coverage, "table": result.intervals.table.to_dict("records")},
                   indent=2), encoding="utf-8")
    (folder / "metrics.json").write_text(json.dumps(result.report, indent=2, default=str), encoding="utf-8")
    source = Path(__file__).parent
    for module in ("inference.py", "features.py"):
        shutil.copy(source / module, folder / module)
    (folder / "README.md").write_text(_model_card(result, config, provenance), encoding="utf-8")
    return folder
