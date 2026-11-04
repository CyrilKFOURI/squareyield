"""Change detection of the scheduled run."""
from rea_pipeline.cli import _changed


def test_changed_detects_any_new_download():
    assert _changed({"skipped": False}) is True
    assert _changed({"skipped": True}) is False
    assert _changed([{"skipped": True}, {"skipped": False}]) is True
    assert _changed({"edition": 2025, "files": {"a": {"skipped": True}}}) is False
    assert _changed({"edition": 2026, "files": {"a": {"skipped": False}}}) is True
