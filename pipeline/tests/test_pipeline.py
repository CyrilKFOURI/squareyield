"""Cleaning and KPI rules on a hand-made official-DVF fixture (docs/features/001-dvf-pipeline/spec.md)."""
import csv
import json
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import clean, marts, refs, validate

HEADER = ["No disposition", "Date mutation", "Nature mutation", "Valeur fonciere",
          "Code departement", "Code commune", "Prefixe de section", "Section", "No plan",
          "Type local", "Surface reelle bati", "Nombre pieces principales", "1er lot",
          "Surface Carrez du 1er lot", "Nombre de lots", "Nature culture", "Surface terrain"]

COMMUNES = [
    {"code": "01001", "type": "commune-actuelle", "nom": "A", "departement": "01", "region": "84"},
    {"code": "01002", "type": "commune-deleguee", "chefLieu": "01001", "nom": "Old", "departement": "01", "region": "84"},
    # the chef-lieu is also listed as its own delegated commune: must not duplicate sales
    {"code": "01001", "type": "commune-deleguee", "chefLieu": "01001", "nom": "A", "departement": "01", "region": "84"},
    {"code": "75056", "type": "commune-actuelle", "nom": "Paris", "departement": "75", "region": "11"},
    {"code": "75101", "type": "arrondissement-municipal", "commune": "75056", "nom": "Paris 1", "departement": "75", "region": "11"},
    {"code": "97102", "type": "commune-actuelle", "nom": "Anse-Bertrand", "departement": "971", "region": "01"},
]


def row(price, commune, type_local, surface, rooms=2, nature="Vente", date="01/03/2024", plan="1",
        lot="", carrez="", lots=1, culture="", land=""):
    """One line of an official DVF file: unpadded commune code, French decimals, dd/mm/yyyy."""
    dep = commune[:3] if commune.startswith("97") else commune[:2]
    com = str(int(commune[len(dep):]))
    french = lambda v: "" if v in (None, "") else str(v).replace(".", ",")
    return ["000001", date, nature, f"{price},00", dep, com, "", "AB", plan, type_local,
            french(surface), rooms, lot, french(carrez), lots, culture, french(land)]


# Each test sale has a unique price, used as its key in the assertions.
ROWS = [
    # apartment + dependency, price repeated on 2 parcels -> kept once, 200 000 / 50
    row(200000, "01001", "Appartement", 50, plan="1"),
    row(200000, "01001", "Appartement", 50, plan="2"),
    row(200000, "01001", "Dépendance", None, plan="1"),
    # two different dwellings in one sale -> dropped
    row(500001, "01001", "Appartement", 40),
    row(500001, "01001", "Appartement", 60, rooms=3),
    # not a sale -> dropped
    row(100000, "01001", "Maison", 100, nature="Echange"),
    # merged commune 01002 -> remapped to 01001
    row(300000, "01002", "Maison", 100, rooms=4),
    # surface below 9 m² -> dropped
    row(50000, "01001", "Appartement", 8, rooms=1),
    # Paris arrondissement -> commune 75056 + arrondissement 75101
    row(500000, "75101", "Appartement", 50),
    # shop in the sale -> dropped
    row(400000, "01001", "Appartement", 50),
    row(400000, "01001", "Local industriel. commercial ou assimilé", 30),
    # overseas: departement 971 + commune "2" -> 97102; French decimal surface
    row(150000, "97102", "Maison", 75.5, rooms=3, date="15/09/2024"),
    # house on 2 parcels; land rows repeat per premises: 400 + 100 m², not doubled
    row(250000, "01001", "Maison", 90, rooms=4, plan="7", culture="S", land=400),
    row(250000, "01001", "Dépendance", None, plan="7", culture="S", land=400),
    row(250000, "01001", "Maison", 90, rooms=4, plan="8", culture="J", land=100),
    # new build (VEFA): kept, flagged
    row(260000, "01001", "Appartement", 60, rooms=3, nature="Vente en l'état futur d'achèvement",
        carrez=58.4, lot="12", lots=2),
    # two identical flats (different lots) sold together -> dropped, not one flat at double price
    row(333333, "01001", "Appartement", 45, lot="3", plan="5"),
    row(333333, "01001", "Appartement", 45, lot="4", plan="5"),
    # house on a large estate -> kept for the model, out of market cells
    row(444444, "01001", "Maison", 120, rooms=5, plan="9", culture="T", land=60000),
    # flat sold with 3 outbuildings -> kept for the model, out of market cells
    row(222222, "01001", "Appartement", 40, lot="20", plan="6"),
    row(222222, "01001", "Dépendance", None, lot="21", plan="6"),
    row(222222, "01001", "Dépendance", None, lot="22", plan="6"),
    row(222222, "01001", "Dépendance", None, lot="23", plan="6"),
]


@pytest.fixture
def con(tmp_path: Path) -> duckdb.DuckDBPyConnection:
    communes = tmp_path / "communes.json"
    communes.write_text(json.dumps(COMMUNES))
    dvf = tmp_path / "ValeursFoncieres-test.txt"
    with dvf.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter="|")
        writer.writerow(HEADER)
        writer.writerows(ROWS)
    connection = duckdb.connect()
    refs.build_commune_map(connection, communes)
    # section 01001000AB has a known point; Paris only has a commune point; 97102 has none
    connection.execute("CREATE TABLE section_point AS SELECT '01001000AB' AS section, 5.0 AS longitude, "
                       "46.0 AS latitude, 13 AS n_parcels")
    connection.execute("CREATE TABLE commune_point AS SELECT * FROM (VALUES ('01001', 5.1::DOUBLE, 46.1::DOUBLE), "
                       "('75101', 2.34::DOUBLE, 48.86::DOUBLE)) t(code, longitude, latitude)")
    clean.load_raw(connection, [dvf])
    clean.build_sales(connection)
    return connection


def sales(con) -> dict[int, tuple]:
    rows = con.execute(
        """SELECT CAST(price AS INTEGER), price_m2, code_commune, code_arrondissement,
                  date_mutation, half, surface_m2
           FROM dvf_sales"""
    ).fetchall()
    return {r[0]: r[1:] for r in rows}


def test_kept_sales(con):
    assert set(sales(con)) == {200000, 300000, 500000, 150000, 250000, 260000, 444444, 222222}
    assert con.execute("SELECT count(*) FROM dvf_sales").fetchone()[0] == 8


def test_identical_flats_sold_together_are_dropped(con):
    assert 333333 not in sales(con)


def test_same_flat_on_two_parcels_kept(con):
    assert 200000 in sales(con)


def test_large_land_house_flagged(con):
    assert _sale(con, 444444, "market_excluded") == ("large_land",)


def test_land_cap_share_counts_every_house(con):
    # houses of département 01: 300000, 250000 and the estate 444444: 1 of 3 is out
    assert marts.land_cap_share(con)["01"] == pytest.approx(1 / 3, abs=1e-4)


def test_many_outbuildings_flagged(con):
    assert _sale(con, 222222, "market_excluded") == ("outbuildings",)
    assert _sale(con, 200000, "market_excluded") == (None,)


def _sale(con, price, columns):
    return con.execute(f"SELECT {columns} FROM dvf_sales WHERE price = ?", [price]).fetchone()


def test_model_features(con):
    assert _sale(con, 250000, "land_m2, n_dependencies, is_new_build") == (500, 1, False)
    assert _sale(con, 260000, "is_new_build, surface_carrez_m2, n_lots") == (True, 58.4, 2)
    assert _sale(con, 200000, "n_dependencies, land_m2") == (1, 0)


def test_location_section_then_commune(con):
    assert _sale(con, 200000, "longitude, latitude, location_precision") == (5.0, 46.0, "section")
    assert _sale(con, 500000, "longitude, location_precision") == (2.34, "commune")
    assert _sale(con, 150000, "longitude, location_precision") == (None, None)


def test_price_counted_once(con):
    assert sales(con)[200000][0] == 4000


def test_merged_commune_remapped(con):
    assert sales(con)[300000][1] == "01001"


def test_arrondissement_mapped_to_parent(con):
    _, commune, arrondissement, *_ = sales(con)[500000]
    assert (commune, arrondissement) == ("75056", "75101")


def test_overseas_code_date_and_decimals(con):
    _, commune, _, date, half, surface = sales(con)[150000]
    assert commune == "97102"
    assert str(date) == "2024-09-15" and half == 2
    assert surface == 75.5


def test_small_cells_not_published(con, tmp_path):
    marts.build_price_kpis(con, "test")
    assert marts.export_published(con, tmp_path / "kpi.parquet") == 0


def _add_sales(con, year: int, half: int, price_m2: float, n: int = 12, property_type: str = "apartment",
               rooms: int = 2, new_build: bool = False, excluded: str | None = None) -> None:
    month = 3 if half == 1 else 9
    for i in range(n):
        con.execute(
            """INSERT INTO dvf_sales BY NAME
               SELECT ? AS id_mutation, CAST(? AS DATE) AS date_mutation, ? AS year, ? AS half,
                      ? AS is_new_build, ? AS price, 50 AS surface_m2, ? AS price_m2,
                      ? AS property_type, ? AS rooms, '01001' AS code_commune,
                      '01' AS code_departement, '84' AS code_region, ? AS market_excluded""",
            [f"{year}-{half}-{property_type}-{rooms}-{new_build}-{excluded}-{price_m2}-{i}",
             f"{year}-{month:02d}-01", year, half, new_build, price_m2 * 50, price_m2,
             property_type, rooms, excluded],
        )


def _cells(con, period: str, property_type: str, condition: str = "existing") -> dict[str, tuple]:
    rows = con.execute(
        """SELECT rooms_bucket, n_sales, reliability, new_premium FROM kpi_price
           WHERE geo_level = 'commune' AND geo_code = '01001' AND period = ?
             AND property_type = ? AND condition = ?""",
        [period, property_type, condition],
    ).fetchall()
    return {r[0]: r[1:] for r in rows}


def test_house_buckets(con):
    for rooms in (2, 3, 4, 5, 7):
        _add_sales(con, 2025, 1, 2000, n=10, property_type="house", rooms=rooms)
    marts.build_price_kpis(con, "test")
    cells = _cells(con, "2025-H1", "house")
    assert set(cells) == {"1-3", "4", "5", "6+", "all"}
    assert cells["1-3"][0] == 20 and cells["all"][0] == 50


def test_unknown_rooms_out_of_all(con):
    _add_sales(con, 2025, 1, 3000, n=12)
    _add_sales(con, 2025, 1, 3000, n=5, rooms=0)
    marts.build_price_kpis(con, "test")
    cells = _cells(con, "2025-H1", "apartment")
    assert cells["all"][0] == cells["2"][0] == 12


def test_market_excluded_out_of_cells(con):
    _add_sales(con, 2025, 1, 3000, n=12)
    _add_sales(con, 2025, 1, 3000, n=3, excluded="outbuildings")
    marts.build_price_kpis(con, "test")
    assert _cells(con, "2025-H1", "apartment")["all"][0] == 12


def test_new_build_cell(con):
    _add_sales(con, 2025, 1, 3000, n=10)
    _add_sales(con, 2025, 1, 4000, n=10, new_build=True)
    marts.build_price_kpis(con, "test")
    new = _cells(con, "2025-H1", "apartment", "new")
    assert set(new) == {"all"} and new["all"][0] == 10
    assert _cells(con, "2025-H1", "apartment")["all"][2] == pytest.approx(4000 / 3000 - 1)
    assert _cells(con, "2025-H1", "all", "new") == {}


def test_land_and_outbuilding_context_per_cell(con):
    for i in range(10):
        con.execute(
            """INSERT INTO dvf_sales BY NAME SELECT ? AS id_mutation, DATE '2025-03-01' AS date_mutation,
                   2025 AS year, 1 AS half, false AS is_new_build, 200000 AS price, 100 AS surface_m2,
                   2000.0 AS price_m2, 'house' AS property_type, 4 AS rooms, '01001' AS code_commune,
                   '01' AS code_departement, '84' AS code_region, ? AS land_m2, ? AS n_dependencies""",
            [f"land-{i}", 500 + 100 * i, 1 if i < 4 else 0],
        )
    marts.build_price_kpis(con, "test")
    land, share = con.execute(
        """SELECT median_land_m2, share_with_outbuilding FROM kpi_price WHERE geo_level = 'commune'
           AND geo_code = '01001' AND period = '2025-H1' AND property_type = 'house' AND rooms_bucket = '4'"""
    ).fetchone()
    assert land == pytest.approx(950) and share == pytest.approx(0.4)


def test_reliability(con):
    _add_sales(con, 2025, 1, 3000, n=12)
    _add_sales(con, 2025, 2, 3000, n=30)
    marts.build_price_kpis(con, "test")
    assert _cells(con, "2025-H1", "apartment")["all"][1] == "low"
    assert _cells(con, "2025-H2", "apartment")["all"][1] == "ok"


def test_bucket_sums_gate(con):
    _add_sales(con, 2025, 1, 3000, n=12)
    _add_sales(con, 2025, 1, 3000, n=12, rooms=3)
    marts.build_price_kpis(con, "test")
    assert all(ok for _, ok, _ in validate.check_bucket_sums(con))
    con.execute("DELETE FROM kpi_price WHERE rooms_bucket = '3'")
    assert not all(ok for _, ok, _ in validate.check_bucket_sums(con))


def _kpi(con, period: str):
    return con.execute(
        """SELECT median_price_m2, yoy_change, is_partial FROM kpi_price
           WHERE geo_level = 'commune' AND geo_code = '01001' AND period = ?
             AND property_type = 'apartment' AND rooms_bucket = 'all' AND condition = 'existing'""",
        [period],
    ).fetchone()


def test_yoy_on_full_years_and_half_years(con):
    # release window 2023-H2 → 2026-H1, like a real DVF release
    _add_sales(con, 2023, 2, 3000)
    for year, price in ((2024, 3000), (2025, 3300)):
        _add_sales(con, year, 1, price)
        _add_sales(con, year, 2, price)
    _add_sales(con, 2026, 1, 3465)
    marts.build_price_kpis(con, "test")

    median, yoy, partial = _kpi(con, "2025")
    assert median == pytest.approx(3300) and yoy == pytest.approx(0.10) and not partial

    # 2026 only has its first half: flagged partial, no year-on-year
    _, yoy, partial = _kpi(con, "2026")
    assert partial and yoy is None
    # but the half-year compares with the same half of 2025: 3465 / 3300 - 1 = +5%
    _, yoy, partial = _kpi(con, "2026-H1")
    assert yoy == pytest.approx(0.05) and not partial

    # 2024 compared with partial 2023: no year-on-year
    assert _kpi(con, "2024")[1] is None


def test_region_and_france_levels(con):
    _add_sales(con, 2025, 1, 3000)
    marts.build_price_kpis(con, "test")
    levels = {
        (level, code) for level, code in con.execute(
            "SELECT DISTINCT geo_level, geo_code FROM kpi_price WHERE period = '2025-H1'"
        ).fetchall()
    }
    assert ("region", "84") in levels and ("france", "FR") in levels


def test_cagr_since_first_complete_year_and_median_surface(con):
    _add_sales(con, 2023, 2, 3000)  # 2023 partial: not a base year
    for year, price in ((2024, 3000), (2025, 3630)):
        _add_sales(con, year, 1, price)
        _add_sales(con, year, 2, price)
    marts.build_price_kpis(con, "test")
    cagr, since, surface = con.execute(
        """SELECT cagr, cagr_since, median_surface_m2 FROM kpi_price
           WHERE geo_level = 'commune' AND geo_code = '01001' AND period = '2025'
             AND property_type = 'apartment' AND rooms_bucket = 'all'"""
    ).fetchone()
    assert since == 2024 and cagr == pytest.approx(0.21)
    assert surface == 50


def test_price_bands_share_sums_to_one(con):
    _add_sales(con, 2025, 1, 1000)  # 12 sales at 50 000 €
    _add_sales(con, 2025, 2, 5000)  # 12 sales at 250 000 €
    marts.build_price_band_kpis(con)
    shares = dict(con.execute(
        """SELECT band, share FROM kpi_price_bands WHERE geo_level = 'commune' AND geo_code = '01001'
           AND year = 2025 AND property_type = 'apartment' ORDER BY band_order"""
    ).fetchall())
    assert shares["0-100k"] == pytest.approx(0.5) and shares["200-300k"] == pytest.approx(0.5)
    assert shares["500k+"] == 0 and sum(shares.values()) == pytest.approx(1)


def test_bands_every_year_no_type_all(con):
    _add_sales(con, 2024, 1, 3000)
    _add_sales(con, 2025, 1, 3000)
    marts.build_price_band_kpis(con)
    keys = set(con.execute(
        "SELECT DISTINCT year, property_type FROM kpi_price_bands WHERE geo_level = 'commune' AND geo_code = '01001'"
    ).fetchall())
    assert {(2024, "apartment"), (2025, "apartment")} <= keys
    assert not any(t == "all" for _, t in keys)


def test_rent_control_resolves_names_and_arrondissements(con, tmp_path):
    config = tmp_path / "rent_control.json"
    config.write_text(json.dumps({"communes": [{"name": "Paris", "departement": "75"},
                                               {"name": "Old", "departement": "01"}]}), encoding="utf-8")
    refs.build_rent_control(con, config)
    codes = {c for (c,) in con.execute("SELECT code FROM rent_control").fetchall()}
    # a merged commune name resolves to its current commune; Paris brings its arrondissements
    assert codes == {"75056", "75101", "01001"}


def test_rent_control_unknown_name_fails(con, tmp_path):
    config = tmp_path / "rent_control.json"
    config.write_text(json.dumps({"communes": [{"name": "Atlantis", "departement": "01"}]}), encoding="utf-8")
    with pytest.raises(ValueError):
        refs.build_rent_control(con, config)
