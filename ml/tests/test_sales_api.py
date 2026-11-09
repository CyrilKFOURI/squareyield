"""Local sales API (docs/features/019-sales-map/spec.md, "Local API contract"): /sales, /building, /sale."""
import json
import threading
import urllib.error
import urllib.request
from datetime import date
from http.server import ThreadingHTTPServer
from pathlib import Path

import pandas as pd
import pytest

from rea_ml import api

P1, P2, P3 = "49007000AB0001", "49007000AB0002", "49007000CD0003"
POINTS = {P1: (4.0, 47.0), P2: (4.001, 47.0005), P3: (4.01, 47.01),
          "75101000AA0001": (2.34, 48.86), "75102000AA0001": (2.345, 48.866)}
STREETS = {P1: ("1", "rue Test", "0001"), P2: ("3", "rue Test", "0001"), P3: ("5", "avenue Autre", "0002"),
           "75101000AA0001": ("2", "rue de Rivoli", "0100"), "75102000AA0001": ("4", "rue Vivienne", "0200")}
# key: (parcel, date, type, rooms, surface, price, first lot, market_excluded)
SALES = {
    "s0": (P1, "2022-03-02", "apartment", 2, 45, 150000, "22", None),
    "s1": (P1, "2026-05-12", "apartment", 2, 45, 189000, "22", None),
    "s2": (P1, "2026-03-01", "apartment", 2, 44, 176000, "23", None),
    "s3": (P1, "2026-01-15", "apartment", 3, 50, 190000, "24", None),
    "s4": (P1, "2025-11-01", "apartment", 2, 46, 202400, "25", None),
    "s5": (P1, "2026-02-01", "house", 5, 100, 300000, None, None),
    "s6": (P1, "2026-04-01", "apartment", 2, 40, 400000, "26", "outbuildings"),
    "s7": (P2, "2026-02-10", "apartment", 2, 47, 188000, "1", None),
    "s8": (P2, "2025-08-01", "apartment", 2, 43, 159100, "2", None),
    "s9": (P3, "2026-06-30", "apartment", 1, 30, 120000, "3", None),
    "s10": (P3, "2024-06-15", "apartment", 2, 45, 135000, "4", None),
    "s11": (P3, "2026-05-20", "apartment", 2, 45, 180000, "5", None),
    "s12": ("75101000AA0001", "2026-01-10", "apartment", 2, 40, 400000, "7", None),
    "s13": ("75102000AA0001", "2026-02-10", "apartment", 2, 50, 500000, "8", None),
}


def sale_id(key: str) -> str:
    return f"{int(key[1:]):032x}"


@pytest.fixture(scope="module")
def sales_path(tmp_path_factory) -> Path:
    rows = []
    for key, (parcel, day, ptype, rooms, surface, price, lot, excluded) in SALES.items():
        number, street, code = STREETS[parcel]
        paris = parcel.startswith("751")
        rows.append({
            "id_mutation": sale_id(key), "date_mutation": pd.Timestamp(day).date(), "is_new_build": False,
            "price": float(price), "surface_m2": float(surface), "price_m2": price / surface,
            "property_type": ptype, "rooms": rooms, "surface_carrez_m2": surface - 0.5 if ptype == "apartment" else None,
            "land_m2": 200.0 if ptype == "house" else 0.0, "n_dependencies": 1, "n_lots": 1,
            "id_parcelle": parcel, "section": parcel[:10],
            "code_commune": "75056" if paris else "49007", "code_arrondissement": parcel[:5] if paris else None,
            "code_departement": parcel[:2], "market_excluded": excluded,
            "street_code": code, "postcode": "75001" if paris else "49100", "street": street,
            "address": f"{number} {street}", "lots": [{"number": lot, "carrez": surface - 0.5}] if lot else [],
            "first_lot": lot, "longitude": POINTS[parcel][0], "latitude": POINTS[parcel][1],
            "location_precision": "parcel", "commune_name": "Paris" if paris else "Angers",
            "arrondissement_name": ("Paris 1er Arrondissement" if parcel.startswith("75101")
                                    else "Paris 2e Arrondissement") if paris else None,
        })
    frame = pd.DataFrame(rows).sort_values(["code_commune", "code_arrondissement", "id_parcelle"])
    path = tmp_path_factory.mktemp("local") / "sales.parquet"
    frame.to_parquet(path, index=False)
    return path


@pytest.fixture(scope="module")
def levels_dir(tmp_path_factory) -> Path:
    folder = tmp_path_factory.mktemp("levels")
    years = ["2022", "2023", "2024", "2025"]
    (folder / "49.json").write_text(json.dumps({"years": years, "types": {
        "apartment": {"curves": {"departement": [2500, 2600, 2700, 2800]},
                      "communes": [{"code": "49007", "medians": [3000, 3100, 3200, 3300]}]},
        "house": {"curves": {"departement": [2000, 2100, 2200, 2400]}, "communes": []},
    }}), encoding="utf-8")
    return folder


@pytest.fixture(scope="module")
def server(model_folder, sales_path, levels_dir):
    service = api.Service(model_folder, sales_path=sales_path, levels_dir=levels_dir)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), api.make_handler(service))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(server: str, path: str) -> tuple[int, dict, dict]:
    try:
        with urllib.request.urlopen(server + path) as response:
            return response.status, json.load(response), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error), dict(error.headers)


def buildings(body: dict) -> dict[str, dict]:
    return {b["id"]: b for b in body["buildings"]}


def test_sales_map_default_filters(server):
    status, body, headers = get(server, "/sales?commune=49007")
    assert status == 200
    assert headers["X-Robots-Tag"] == "noindex" and headers["Access-Control-Allow-Origin"] == "*"
    assert body["commune"] == {"code": "49007", "name": "Angers"}
    assert body["period"] == {"from": "2024-07-01", "to": "2026-06-30"}
    assert body["reference"] == {"n": 8, "median_m2": 4000}
    found = buildings(body)
    assert set(found) == {P1, P2, P3}
    assert found[P1] == {"id": P1, "lon": 4.0, "lat": 47.0, "addresses": ["1 rue Test"], "n": 4,
                         "median_m2": 4100, "m2": 4100, "last_date": "2026-05-12"}
    assert found[P2]["n"] == 2 and found[P2]["median_m2"] is None  # under 3 sales: no median
    # but the dot is still coloured, from its own sales (s7 4000 €/m², s8 3700 €/m²)
    assert found[P2]["m2"] == 3850


@pytest.mark.parametrize(("query", "expected"), [
    ("rooms=2", {P1: 3, P2: 2, P3: 1}),
    ("rooms=5&type=house", {P1: 1}),
    ("type=all", {P1: 5, P2: 2, P3: 2}),
    ("months=60", {P1: 5, P2: 2, P3: 3}),
    ("months=12", {P1: 4, P2: 2, P3: 2}),
    ("surface_min=45&surface_max=46", {P1: 2, P3: 1}),
    ("price_min=170000&price_max=180000", {P1: 1, P3: 1}),
])
def test_sales_map_filters(server, query, expected):
    status, body, _ = get(server, f"/sales?commune=49007&{query}")
    assert status == 200
    assert {k: b["n"] for k, b in buildings(body).items()} == expected


def test_sales_map_paris_city_and_arrondissement(server):
    _, whole, _ = get(server, "/sales?commune=75056")
    assert whole["commune"] == {"code": "75056", "name": "Paris"} and len(whole["buildings"]) == 2
    _, first, _ = get(server, "/sales?commune=75101")
    assert first["commune"] == {"code": "75101", "name": "Paris 1er Arrondissement"}
    assert [b["id"] for b in first["buildings"]] == ["75101000AA0001"]
    assert first["reference"] == {"n": 1, "median_m2": None}


@pytest.mark.parametrize("query", ["", "commune=49007&type=castle", "commune=49007&months=7",
                                   "commune=49007&rooms=0", "commune=49007&rooms=two", "commune=49007&surface_min=x",
                                   "commune=4900"])
def test_sales_map_bad_filters(server, query):
    status, body, _ = get(server, f"/sales?{query}")
    assert status == 400 and body["error"]


def test_sales_map_unknown_commune(server):
    assert get(server, "/sales?commune=99999")[0] == 404


def test_building_panel(server):
    status, body, _ = get(server, f"/building/{P1}")
    assert status == 200
    assert (body["id"], body["lon"], body["lat"], body["addresses"]) == (P1, 4.0, 47.0, ["1 rue Test"])
    assert body["commune"] == {"code": "49007", "name": "Angers", "median_m2": 4000}
    assert body["street"] == {"name": "rue Test", "n": 6, "median_m2": 4000}
    assert body["stats"] == {"n": 4, "median_m2": 4100, "p25_m2": 3950, "p75_m2": 4250}
    sales = body["sales"]
    assert [s["id"] for s in sales] == [sale_id(k) for k in ("s1", "s6", "s2", "s5", "s3", "s4", "s0")]
    assert [s["matches_filters"] for s in sales] == [True, False, True, False, True, True, False]
    first = sales[0]
    assert first == {"id": sale_id("s1"), "date": "2026-05-12", "address": "1 rue Test", "type": "apartment",
                     "rooms": 2, "surface": 45.0, "carrez": 44.5, "land": None, "price": 189000, "price_m2": 4200,
                     "lots": [{"number": "22", "carrez": 44.5}], "n_dependencies": 1, "new": False,
                     "gap_commune": 0.05, "matches_filters": True}
    house = sales[3]
    assert house["land"] == 200 and house["gap_commune"] is None  # one house in the commune: no median


def test_building_filters_and_errors(server):
    _, body, _ = get(server, f"/building/{P1}?rooms=2")
    assert body["stats"]["n"] == 3 and body["stats"]["median_m2"] == 4200
    assert get(server, "/building/49007000ZZ9999")[0] == 404
    assert get(server, f"/building/{P1}?type=castle")[0] == 400


def test_sale_sheet(server):
    status, body, _ = get(server, f"/sale/{sale_id('s1')}")
    assert status == 200
    sale = body["sale"]
    assert sale["id"] == sale_id("s1") and sale["price_m2"] == 4200 and sale["gap_commune"] == 0.05
    assert (sale["postcode"], sale["section"], sale["parcel"], sale["lon"], sale["lat"],
            sale["location_precision"], sale["departement"]) == ("49100", "49007000AB", P1, 4.0, 47.0, "parcel", "49")
    assert sale["commune"] == {"code": "49007", "name": "Angers"}
    assert body["similar_rule"] == {"surface_ratio": 0.2, "rooms": 1, "months": 6}
    position = {p["level"]: p for p in body["position"]}
    assert [p["level"] for p in body["position"]] == ["building", "street", "section", "commune"]
    assert position["building"] == {"level": "building", "n": 2, "median_m2": None, "gap": None, "percentile": None}
    assert position["street"] == {"level": "street", "n": 3, "median_m2": 4000, "gap": 0.05, "percentile": 1.0}
    assert position["commune"]["n"] == 4 and position["commune"]["median_m2"] == 4000
    comparables = body["comparables"]
    assert [c["id"] for c in comparables] == [sale_id(k) for k in ("s2", "s3", "s7", "s11")]
    assert comparables[0]["km"] == 0 and 0 < comparables[2]["km"] < comparables[3]["km"]
    assert set(comparables[0]) == {"id", "date", "address", "lon", "lat", "rooms", "surface", "price", "price_m2", "km"}
    assert body["value_today"] == {"level": "commune", "from_year": "2025", "to_year": "2025", "factor": 1.0,
                                   "value": 189000, "gain": 0}
    assert body["model"]["as_of"] == "today" and body["model"]["estimate_m2"] > 0
    assert body["model"]["low_m2"] <= body["model"]["estimate_m2"] <= body["model"]["high_m2"]
    resale = body["resale"]
    assert resale["previous"] == {"id": sale_id("s0"), "date": "2022-03-02", "price": 150000}
    assert resale["next"] is None
    assert resale["holding_years"] == 4.2 and resale["gain"] == 39000
    assert resale["annual_rate"] == pytest.approx((189000 / 150000) ** (365.25 / 1532) - 1, abs=1e-4)
    assert [s["id"] for s in body["building_sales"]] == [sale_id(k) for k in ("s6", "s2", "s5", "s3", "s4", "s0")]
    assert set(body["building_sales"][0]) == {"id", "date", "type", "rooms", "surface", "price_m2"}


def test_sale_value_today_and_next_resale(server):
    _, body, _ = get(server, f"/sale/{sale_id('s0')}")
    assert body["value_today"] == {"level": "commune", "from_year": "2022", "to_year": "2025", "factor": 1.1,
                                   "value": 165000, "gain": 15000}
    assert body["resale"]["previous"] is None and body["resale"]["next"]["id"] == sale_id("s1")
    assert body["resale"]["gain"] == 39000
    _, house, _ = get(server, f"/sale/{sale_id('s5')}")
    assert house["value_today"]["level"] == "departement" and house["resale"] is None
    _, alone, _ = get(server, f"/sale/{sale_id('s2')}")
    assert alone["resale"] is None


def test_sale_not_found(server):
    assert get(server, f"/sale/{'f' * 32}")[:2] == (404, {"error": "vente introuvable"})
    assert get(server, "/sale/not-an-id")[:2] == (404, {"error": "vente introuvable"})


def test_health_still_answers(server):
    status, body, _ = get(server, "/health")
    assert status == 200 and body["status"] == "ok"


def test_without_the_local_file_the_api_says_how_to_build_it(model_folder, tmp_path, levels_dir):
    service = api.Service(model_folder, sales_path=tmp_path / "missing.parquet", levels_dir=levels_dir)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), api.make_handler(service))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        status, body, _ = get(f"http://127.0.0.1:{httpd.server_address[1]}", "/sales?commune=49007")
        assert status == 503 and "rea sales" in body["error"]
    finally:
        httpd.shutdown()


def test_period_counts_back_from_the_latest_sale():
    from rea_ml import sales

    assert sales.period_start(date(2026, 6, 30), 24) == date(2024, 7, 1)
    assert sales.period_start(date(2026, 6, 30), 12) == date(2025, 7, 1)
    assert sales.period_start(date(2026, 3, 31), 1) == date(2026, 3, 1)
    assert sales.period_start(date(2026, 5, 15), 60) == date(2021, 5, 16)


def test_places_leave_memory_and_come_back(sales_path, levels_dir):
    from rea_ml import sales

    store = sales.SalesStore(sales_path, levels_dir, model=None, cached_places=1)
    first = store.sales_map("49007", sales.Filters())
    store.sales_map("75101", sales.Filters())  # evicts Angers
    assert json.loads(sales.dumps(store.sales_map("49007", sales.Filters()))) == json.loads(sales.dumps(first))
    sheet = store.sale(sale_id("s12"), sales.Filters())  # a Paris sale, by its arrondissement
    assert sheet["sale"]["commune"] == {"code": "75101", "name": "Paris 1er Arrondissement"}
    assert sheet["model"] is None  # no model loaded: the sheet still answers


def test_dumps_inserts_raw_json():
    from rea_ml import sales

    text = sales.dumps({"a": sales.RawJson('[{"x":1}]'), "b": [date(2026, 1, 2), "é"]})
    assert json.loads(text) == {"a": [{"x": 1}], "b": ["2026-01-02", "é"]}
