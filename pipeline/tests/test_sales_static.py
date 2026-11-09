"""Static per-commune sales files (docs/features/022-full-frontend/spec.md, rule 1).

The fixture is the one of the local API tests (ml/tests/test_sales_api.py). Its export is committed in
apps/app/src/data/sales-static-fixture/, where the app tests check that the TypeScript port gives the API's numbers:
this test fails when the export changes without that copy (REA_REGEN_FIXTURE=1 rewrites it)."""
import json
import os
from datetime import date
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import sales_static

APP_FIXTURE = Path(__file__).resolve().parents[2] / "apps" / "app" / "src" / "data" / "sales-static-fixture"

P1, P2, P3 = "49007000AB0001", "49007000AB0002", "49007000CD0003"
POINTS = {P1: (4.0, 47.0), P2: (4.001, 47.0005), P3: (4.01, 47.01),
          "75101000AA0001": (2.34, 48.86), "75102000AA0001": (2.345, 48.866)}
STREETS = {P1: ("1", "rue Test", "0001"), P2: ("3", "rue Test", "0001"), P3: ("5", "avenue Autre", "0002"),
           "75101000AA0001": ("2", "rue de Rivoli", "0100"), "75102000AA0001": ("4", "rue Vivienne", "0200")}
# key: (parcel, date, type, rooms, surface, price, first lot, market_excluded) — same as the API tests
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

COLUMNS = """id_mutation VARCHAR, date_mutation DATE, is_new_build BOOLEAN, price DOUBLE, surface_m2 DOUBLE,
    price_m2 DOUBLE, property_type VARCHAR, rooms INTEGER, surface_carrez_m2 DOUBLE, land_m2 DOUBLE,
    n_dependencies BIGINT, n_lots INTEGER, id_parcelle VARCHAR, section VARCHAR, code_commune VARCHAR,
    code_arrondissement VARCHAR, code_departement VARCHAR, market_excluded VARCHAR, street_code VARCHAR,
    postcode VARCHAR, street VARCHAR, address VARCHAR, lots STRUCT(number VARCHAR, carrez DOUBLE)[],
    first_lot VARCHAR, longitude DOUBLE, latitude DOUBLE, location_precision VARCHAR, commune_name VARCHAR,
    arrondissement_name VARCHAR"""


def sale_id(key: str) -> str:
    return f"{int(key[1:]):032x}"


@pytest.fixture(scope="module")
def exported(tmp_path_factory) -> Path:
    work = tmp_path_factory.mktemp("static")
    con = duckdb.connect()
    con.execute(f"CREATE TABLE s ({COLUMNS})")
    for key, (parcel, day, ptype, rooms, surface, price, lot, excluded) in SALES.items():
        number, street, code = STREETS[parcel]
        paris = parcel.startswith("751")
        carrez = surface - 0.5 if ptype == "apartment" else None
        con.execute(
            "INSERT INTO s VALUES (" + ", ".join(["?"] * 29) + ")",
            [sale_id(key), date.fromisoformat(day), False, float(price), float(surface), price / surface, ptype,
             rooms, carrez, 200.0 if ptype == "house" else 0.0, 1, 1, parcel, parcel[:10],
             "75056" if paris else "49007", parcel[:5] if paris else None, parcel[:2], excluded, code,
             "75001" if paris else "49100", street, f"{number} {street}",
             [{"number": lot, "carrez": surface - 0.5}] if lot else [], lot, *POINTS[parcel], "parcel",
             "Paris" if paris else "Angers",
             ("Paris 1er Arrondissement" if parcel.startswith("75101") else "Paris 2e Arrondissement")
             if paris else None])
    source = work / "sales.parquet"
    con.execute(f"COPY s TO '{source.as_posix()}' (FORMAT parquet)")
    dest = work / "sales"
    stats = sales_static.export(source, dest)
    assert stats["files"] == 3 and stats["biggest"] == "49007"
    return dest


def load(folder: Path, code: str) -> dict:
    return json.loads((folder / code[:2] / f"{code}.json").read_text(encoding="utf-8"))


def test_one_file_per_commune_and_arrondissement(exported):
    assert sorted(p.name for p in exported.glob("*/*.json")) == ["49007.json", "75101.json", "75102.json"]
    paris = load(exported, "75101")
    assert (paris["code"], paris["name"], paris["city"], paris["city_name"], paris["dep"]) == (
        "75101", "Paris 1er Arrondissement", "75056", "Paris", "75")
    assert paris["latest"] == "2026-06-30"  # the latest sale of France, not of the place
    assert paris["parcels"]["id"] == ["000AA0001"]  # the place code is not repeated


def test_columns_dates_and_flags(exported):
    doc = load(exported, "49007")
    sales = doc["sales"]
    assert len(sales["id"]) == 12 and all(len(sales[k]) == 12 for k in sales)
    days = [sum(sales["d"][: i + 1]) for i in range(12)]
    assert days == sorted(days) and days[0] == (date(2022, 3, 2) - date(1970, 1, 1)).days
    assert sales["id"][0] == sale_id("s0")[-12:]
    i6 = sales["id"].index(sale_id("s6")[-12:])
    assert sales["x"][i6] == 1 and sum(sales["x"]) == 1  # kept (the building lists it) but flagged
    i5 = sales["id"].index(sale_id("s5")[-12:])
    assert (sales["t"][i5], sales["l"][i5], sales["c"][i5], sales["lk"][i5]) == (1, 200, None, 0)
    i1 = sales["id"].index(sale_id("s1")[-12:])
    assert (sales["p"][i1], sales["s"][i1], sales["c"][i1], sales["no"][i1]) == (189000, 45, 44.5, "1")
    assert doc["streets"]["name"][sales["st"][i1]] == "rue Test"
    assert doc["streets"]["key"][sales["st"][i1]] == "49007|0001"
    assert doc["postcodes"][sales["pc"][i1]] == "49100"
    # s0 and s1 are the same flat (lot 22): same rank; s2 (lot 23) another one
    i0, i2 = sales["id"].index(sale_id("s0")[-12:]), sales["id"].index(sale_id("s2")[-12:])
    assert sales["lk"][i0] == sales["lk"][i1] != sales["lk"][i2]


def test_lot_numbers_are_not_published(exported):
    text = (exported / "49" / "49007.json").read_text(encoding="utf-8")
    assert '"lots"' not in text and '"first_lot"' not in text and '"number"' not in text


def test_app_fixture_is_this_export(exported):
    if os.environ.get("REA_REGEN_FIXTURE"):
        APP_FIXTURE.mkdir(parents=True, exist_ok=True)
        for path in exported.glob("*/*.json"):  # the app fixture stays flat
            (APP_FIXTURE / path.name).write_bytes(path.read_bytes())
    for path in exported.glob("*/*.json"):  # the app fixture stays flat
        assert json.loads((APP_FIXTURE / path.name).read_text(encoding="utf-8")) == load(exported, path.stem)


def test_short_ids_must_be_unique(tmp_path):
    rows = [{"id_parcelle": None, "street_code": None, "postcode": None, "first_lot": None,
             "date_mutation": date(2026, 1, 1), "id_mutation": prefix + "0" * 12, "price": 1.0, "surface_m2": 1.0,
             "surface_carrez_m2": None, "rooms": None, "property_type": "house", "land_m2": None,
             "is_new_build": False, "address_number_label": None, "n_lots": 0, "n_dependencies": 0,
             "excluded": False} for prefix in ("a" * 20, "b" * 20)]
    with pytest.raises(ValueError):
        sales_static._place_doc("49007", rows, {"name": "A", "city_name": "A", "dep": "49"}, date(2026, 1, 1))
