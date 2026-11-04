"""ADEME energy performance certificates (DPE) per commune (M14).

The ADEME open-data API aggregates the 15+ M certificates of existing homes (since July 2021)
by commune and label, one call per département, so nothing heavy is downloaded.

Read the shares as "among homes that got a DPE since 2021" (mostly homes sold or let), not
the whole housing stock: that is the market an investor actually meets.

Certificates are split by building type (type_batiment: appartement / maison / immeuble) so a
flat is compared with flats and a house with houses; whole-building certificates (immeuble)
only count in "all". The aggregation API nests code × type × label in one call per
département (checked 2026-10-21 on Pas-de-Calais: 890 communes, nothing truncated).
"""
import csv
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import httpx

from . import paths

DATASET = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant"
AGG_URL = DATASET + "/values_agg"
DPE_DIR = paths.RAW / "dpe"
LABELS = ("A", "B", "C", "D", "E", "F", "G")
TYPES = {"appartement": "apartment", "maison": "house"}
MAX_COMMUNES_PER_DEPARTEMENT = 1_000  # API maximum; Pas-de-Calais, the largest, has ~890


PAUSE_SECONDS = 1.0  # be polite: the API rate-limits bursts (HTTP 429)
MAX_RETRIES = 6


def _get(client: httpx.Client, url: str, params: dict) -> dict:
    """GET with backoff on 429/5xx, honouring Retry-After."""
    for attempt in range(MAX_RETRIES):
        response = client.get(url, params=params)
        if response.status_code == 429 or response.status_code >= 500:
            wait = float(response.headers.get("retry-after", 0) or 0) or 2 ** (attempt + 1)
            time.sleep(min(wait, 120))
            continue
        response.raise_for_status()
        return response.json()
    response.raise_for_status()
    raise RuntimeError(f"{url}: still failing after {MAX_RETRIES} attempts")


def _departements(con: duckdb.DuckDBPyConnection) -> list[str]:
    return [d for (d,) in con.execute(
        "SELECT DISTINCT departement FROM commune_map WHERE departement IS NOT NULL ORDER BY 1"
    ).fetchall()]


def ingest_dpe(con: duckdb.DuckDBPyConnection) -> dict:
    """Fetch counts per commune × building type × label for every département, unless the
    dataset is unchanged since the last fetch of the same shape."""
    with httpx.Client(timeout=120) as client:
        meta = client.get(DATASET)
        meta.raise_for_status()
        updated_at = meta.json()["updatedAt"]
        state = DPE_DIR / "state.json"
        previous = json.loads(state.read_text()) if state.exists() else {}
        if previous.get("updated_at") == updated_at and previous.get("by_type"):
            return {"updated_at": updated_at, "skipped": True}

        rows = []
        for departement in _departements(con):
            body = _get(client, AGG_URL, {
                "field": "code_insee_ban;type_batiment;etiquette_dpe",
                "agg_size": MAX_COMMUNES_PER_DEPARTEMENT,
                "qs": f'code_departement_ban:"{departement}"',
                "size": 0,
            })
            time.sleep(PAUSE_SECONDS)
            if body["total_other"]:
                raise RuntimeError(f"DPE {departement}: more than {MAX_COMMUNES_PER_DEPARTEMENT} communes")
            rows += [[commune["value"], building["value"], label["value"], label["total"]]
                     for commune in body["aggs"] for building in commune["aggs"]
                     for label in building["aggs"]]

    DPE_DIR.mkdir(parents=True, exist_ok=True)
    with counts_file().open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["code", "type", "label", "n"])
        writer.writerows(rows)
    state.write_text(json.dumps({"updated_at": updated_at, "by_type": True,
                                 "fetched_at": datetime.now(timezone.utc).isoformat(), "rows": len(rows)}))
    return {"updated_at": updated_at, "rows": len(rows), "skipped": False}


def counts_file() -> Path:
    return DPE_DIR / "counts.csv"


def build_dpe_kpis(con: duckdb.DuckDBPyConnection, counts_csv: Path) -> None:
    """Create table kpi_dpe: certificates and share of each label per geo level and
    property_type ('all', 'apartment', 'house'). Codes are mapped to current communes
    (merged communes add up)."""
    labels = ", ".join(
        f"sum(n) FILTER (WHERE label = '{l}')::DOUBLE / sum(n) AS share_{l.lower()}" for l in LABELS
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE kpi_dpe AS
        WITH raw AS (
            SELECT code, type, label, n
            FROM read_csv('{counts_csv.as_posix()}', header = true,
                          columns = {{'code': 'VARCHAR', 'type': 'VARCHAR', 'label': 'VARCHAR', 'n': 'BIGINT'}})
        ),
        typed AS (
            SELECT code, 'all' AS property_type, label, n FROM raw
            UNION ALL
            SELECT code, CASE type {" ".join(f"WHEN '{k}' THEN '{v}'" for k, v in TYPES.items())} END, label, n
            FROM raw WHERE type IN ({", ".join(f"'{k}'" for k in TYPES)})
        ),
        located AS (
            SELECT m.code_commune, m.code_arrondissement, m.departement, m.region, r.property_type, r.label, r.n
            FROM typed r JOIN commune_map m ON m.code = r.code
            WHERE r.label IN ({", ".join(f"'{l}'" for l in LABELS)})
        ),
        geo AS (
            SELECT 'commune' AS geo_level, code_commune AS geo_code, property_type, label, n FROM located
            UNION ALL SELECT 'arrondissement', code_arrondissement, property_type, label, n FROM located
                      WHERE code_arrondissement IS NOT NULL
            UNION ALL SELECT 'departement', departement, property_type, label, n FROM located
            UNION ALL SELECT 'region', region, property_type, label, n FROM located
            UNION ALL SELECT 'france', 'FR', property_type, label, n FROM located
        )
        SELECT geo_level, geo_code, property_type, sum(n) AS n_dpe, {labels},
               sum(n) FILTER (WHERE label IN ('F', 'G'))::DOUBLE / sum(n) AS share_fg
        FROM geo GROUP BY geo_level, geo_code, property_type
        """
    )


def export_published(con: duckdb.DuckDBPyConnection, dest: Path, min_dpe: int = 10) -> int:
    query = f"SELECT * FROM kpi_dpe WHERE n_dpe >= {min_dpe}"
    con.execute(f"COPY ({query} ORDER BY ALL) TO '{dest.as_posix()}' (FORMAT parquet)")
    return con.execute(f"SELECT count(*) FROM ({query})").fetchone()[0]
