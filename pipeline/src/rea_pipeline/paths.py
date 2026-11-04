"""Filesystem layout of the data layers (see docs/PIPELINE_RUN_SPEC.md §1)."""
import os
from pathlib import Path

ROOT = Path(os.environ.get("REA_DATA_DIR", Path(__file__).resolve().parents[3] / "data"))
RAW = ROOT / "raw"
CLEAN = ROOT / "clean"
MARTS = ROOT / "marts"
SERVE = ROOT / "serve"
RUNS = ROOT / "runs"
