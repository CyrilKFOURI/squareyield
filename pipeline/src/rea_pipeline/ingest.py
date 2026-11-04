"""S1: download upstream files into data/raw with metadata; skip files whose ETag is unchanged."""
import hashlib
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import paths

# Official DVF (DGFiP) on data.gouv.fr. Resource URLs change at every release (April/October),
# so the current file list is read from the dataset API, never hard-coded.
DVF_DATASET_API = "https://www.data.gouv.fr/api/1/datasets/demandes-de-valeurs-foncieres/"
DVF_DIR = paths.RAW / "dvf_official"
DVF_RELEASE = DVF_DIR / "release.json"
COMMUNES_URL = "https://unpkg.com/@etalab/decoupage-administratif@6.0.0/data/communes.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, dest: Path, client: httpx.Client) -> dict:
    """Download url to dest; `skipped` is True when the content did not change.

    Unchanged is decided by the ETag when the server sends one (no download), else by the
    SHA-256 of the downloaded file (INSEE and unpkg send no ETag)."""
    meta_path = dest.with_name(dest.name + ".meta.json")
    head = client.head(url)
    head.raise_for_status()
    etag = head.headers.get("etag")
    previous = json.loads(meta_path.read_text()) if dest.exists() and meta_path.exists() else None
    if previous and etag and previous.get("etag") == etag:
        return previous | {"skipped": True}

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with client.stream("GET", url) as response:
        response.raise_for_status()
        with tmp.open("wb") as f:
            for chunk in response.iter_bytes(1 << 20):
                f.write(chunk)
    sha256 = _sha256(tmp)
    if previous and previous.get("sha256") == sha256:
        tmp.unlink()
        return previous | {"skipped": True}
    tmp.replace(dest)

    meta = {
        "url": url,
        "etag": etag,
        "sha256": sha256,
        "bytes": dest.stat().st_size,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(meta, indent=2))
    return meta | {"skipped": False}


def _current_dvf_resources(client: httpx.Client) -> list[dict]:
    response = client.get(DVF_DATASET_API)
    response.raise_for_status()
    return [
        r for r in response.json()["resources"]
        if r.get("format") == "txt.zip" and r["title"].startswith("Valeurs fonci")
    ]


def _extract(archive: Path) -> Path:
    """Extract the single .txt of a DVF zip next to it (skipped if already extracted)."""
    with zipfile.ZipFile(archive) as zf:
        member = zf.namelist()[0]
        target = archive.with_name(member)
        if not target.exists() or target.stat().st_mtime < archive.stat().st_mtime:
            zf.extract(member, archive.parent)
    return target


def ingest_dvf() -> list[dict]:
    with httpx.Client(follow_redirects=True, timeout=600) as client:
        resources = _current_dvf_resources(client)
        results = []
        for resource in resources:
            archive = DVF_DIR / resource["url"].rsplit("/", 1)[-1]
            meta = download(resource["url"], archive, client)
            results.append(meta | {"title": resource["title"], "txt": _extract(archive).name})
    # the release file lists exactly the files of the current release: older files left on
    # disk from a previous release are never loaded
    DVF_RELEASE.write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
    return results


def dvf_files() -> list[Path]:
    release = json.loads(DVF_RELEASE.read_text(encoding="utf-8"))
    return [DVF_DIR / item["txt"] for item in release]


def communes_file() -> Path:
    return paths.RAW / "refs" / "communes.json"


def ingest_refs() -> dict:
    with httpx.Client(follow_redirects=True, timeout=120) as client:
        return download(COMMUNES_URL, communes_file(), client)
