"""Local HTTP API for the property dashboard (docs/features/012-property-dashboard/spec.md).

    uv run rea-ml serve            # http://localhost:8787

POST /estimate  {"address": "12 rue Lenepveu Angers", "property_type": "apartment",
                 "surface_m2": 45, "rooms": 2, "asked_price": 150000}
GET  /health

Standard library only (http.server). Comparables read the local cleaned DVF sales: they are
individual sales, so this API is for local use; never expose it publicly or let pages built
from it be indexed (DVF rules, LPF art. L112 A).
"""
import json
import logging
import math
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

from .config import MODEL_NAME, MODELS_DIR, SALES_PATH
from .inference import PriceCheckModel

log = logging.getLogger("rea_ml.api")

BAN_URL = "https://api-adresse.data.gouv.fr/search/?{query}"
MIN_ADDRESS_SCORE = 0.5
COMPARABLES = 5
COMPARABLE_SURFACE_RATIO = 0.25  # ±25 %
COMPARABLE_MONTHS = 24


def latest_model_folder() -> Path:
    folders = sorted(p for p in (MODELS_DIR / MODEL_NAME).glob("*") if (p / "model.txt").exists())
    if not folders:
        raise FileNotFoundError(f"No trained model in {MODELS_DIR / MODEL_NAME}: run `uv run rea-ml train`")
    return folders[-1]


def geocode(address: str) -> dict:
    """Address -> point + INSEE code (arrondissement code in Paris/Lyon/Marseille), via the BAN."""
    query = urllib.parse.urlencode({"q": address, "limit": 1})
    with urllib.request.urlopen(BAN_URL.format(query=query), timeout=10) as response:
        features = json.load(response)["features"]
    if not features or features[0]["properties"]["score"] < MIN_ADDRESS_SCORE:
        raise ValueError(f"Adresse introuvable : {address}")
    feature = features[0]
    lon, lat = feature["geometry"]["coordinates"]
    return {"label": feature["properties"]["label"], "code_commune": feature["properties"]["citycode"],
            "longitude": lon, "latitude": lat}


def nearest_section(sections: pd.DataFrame, code_commune: str, lon: float, lat: float) -> str | None:
    """Closest section point of the commune: the same location rule the model was trained on."""
    candidates = sections[sections["section"].str.startswith(code_commune)]
    if candidates.empty:
        return None
    dx = (candidates["longitude"].to_numpy() - lon) * math.cos(math.radians(lat))
    dy = candidates["latitude"].to_numpy() - lat
    return str(candidates["section"].iloc[int(np.argmin(dx * dx + dy * dy))])


def comparables(prop: dict, section: str | None, sales_path: Path | None = None) -> list[dict]:
    """Recent sales of the same type and similar surface: same section first, then the commune."""
    sales_path = sales_path or SALES_PATH
    surface = float(prop["surface_m2"])
    rows = duckdb.execute(
        f"""
        WITH latest AS (SELECT max(date_mutation) AS d FROM '{sales_path.as_posix()}')
        SELECT strftime(date_mutation, '%Y-%m') AS month, surface_m2, rooms, land_m2, price, price_m2,
               section = ? AS same_section
        FROM '{sales_path.as_posix()}', latest
        WHERE (code_commune = ? OR code_arrondissement = ?) AND property_type = ?
          AND is_new_build = ?
          AND surface_m2 BETWEEN ? AND ?
          AND date_mutation >= latest.d - INTERVAL {COMPARABLE_MONTHS} MONTH
        ORDER BY same_section DESC, abs(surface_m2 - ?) / ?, date_mutation DESC
        LIMIT {COMPARABLES}
        """,
        [section, prop["code_commune"], prop["code_commune"], prop["property_type"],
         bool(prop.get("is_new_build", False)),
         surface * (1 - COMPARABLE_SURFACE_RATIO), surface * (1 + COMPARABLE_SURFACE_RATIO), surface, surface],
    ).fetchall()
    keys = ("month", "surface_m2", "rooms", "land_m2", "price", "price_m2", "same_section")
    return [dict(zip(keys, row)) for row in rows]


class Service:
    def __init__(self, folder: Path):
        self.folder = folder
        self.model = PriceCheckModel.load(folder)

    def estimate(self, payload: dict) -> dict:
        prop = dict(payload)
        location = None
        if prop.get("address"):
            location = geocode(prop.pop("address"))
            prop["code_commune"] = location["code_commune"]
            prop["section"] = nearest_section(
                self.model.section_points, location["code_commune"], location["longitude"], location["latitude"]
            )
        if not prop.get("code_commune"):
            raise ValueError("Donnez une adresse ou un code commune")
        [result] = self.model.estimate([prop])
        return result | {
            "location": location,
            "code_commune": prop["code_commune"],
            "section": prop.get("section"),
            "comparables": comparables(prop, prop.get("section")),
            "model_version": self.folder.name,
        }


def make_handler(service: Service):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Access-Control-Allow-Origin", "*")  # local dev app on another port
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("X-Robots-Tag", "noindex")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self) -> None:  # CORS preflight
            self._send(204, {})

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send(200, {"status": "ok", "model_version": service.folder.name})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            if self.path != "/estimate":
                self._send(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length", 0))
                self._send(200, service.estimate(json.loads(self.rfile.read(length) or b"{}")))
            except (ValueError, KeyError) as error:
                self._send(400, {"error": str(error)})
            except Exception:  # noqa: BLE001 — never leak a traceback to the client
                log.exception("estimate failed")
                self._send(500, {"error": "erreur interne"})

    return Handler


def serve(port: int = 8787, folder: Path | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    service = Service(folder or latest_model_folder())
    log.info("model %s loaded, listening on http://localhost:%d", service.folder.name, port)
    ThreadingHTTPServer(("127.0.0.1", port), make_handler(service)).serve_forever()
