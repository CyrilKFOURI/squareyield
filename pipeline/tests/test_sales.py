"""Local sale-by-sale file for the sales map (docs/features/019-sales-map/spec.md, "Data").

Built from a hand-made official DVF file (address and lot columns), a geo-DVF file (parcel points, quoted
fields with commas) and the cleaned sales of the same file, so ids and market rules are those of clean.py."""
import csv
import gzip
import json
from pathlib import Path

import duckdb
import pytest

from rea_pipeline import clean, refs, sales

HEADER = ["No disposition", "Date mutation", "Nature mutation", "Valeur fonciere", "No voie", "B/T/Q",
          "Type de voie", "Code voie", "Voie", "Code postal", "Code departement", "Code commune",
          "Prefixe de section", "Section", "No plan", "1er lot", "Surface Carrez du 1er lot", "2eme lot",
          "Surface Carrez du 2eme lot", "3eme lot", "Surface Carrez du 3eme lot", "4eme lot",
          "Surface Carrez du 4eme lot", "5eme lot", "Surface Carrez du 5eme lot", "Nombre de lots", "Type local",
          "Surface reelle bati", "Nombre pieces principales", "Nature culture", "Surface terrain"]

COMMUNES = [
    {"code": "33063", "type": "commune-actuelle", "nom": "Bordeaux", "departement": "33", "region": "75"},
    {"code": "01001", "type": "commune-actuelle", "nom": "A", "departement": "01", "region": "84"},
    {"code": "01002", "type": "commune-deleguee", "chefLieu": "01001", "nom": "Old", "departement": "01",
     "region": "84"},
    {"code": "75056", "type": "commune-actuelle", "nom": "Paris", "departement": "75", "region": "11"},
    {"code": "75115", "type": "arrondissement-municipal", "commune": "75056", "nom": "Paris 15e Arrondissement",
     "departement": "75", "region": "11"},
]


def row(price, commune, type_local, surface, *, date="25/05/2026", number="108", suffix="B", street_type="CRS",
        street_code="8285", street="SAINT LOUIS", postcode="33300", section="RO", plan="55", lots=(),
        rooms=2, culture="", land=""):
    """One line of an official DVF file: unpadded commune and postcode, French decimals, dd/mm/yyyy."""
    dep = commune[:2]
    french = lambda v: "" if v in (None, "") else str(v).replace(".", ",")
    lot_cells = []
    for i in range(5):
        number_i, carrez_i = lots[i] if i < len(lots) else ("", "")
        lot_cells += [number_i, french(carrez_i)]
    return ["000001", date, "Vente", f"{price},00", number, suffix, street_type, street_code, street,
            str(int(postcode)) if postcode else "", dep, str(int(commune[2:])), "", section, plan, *lot_cells,
            len(lots), type_local, french(surface), rooms if type_local != "Dépendance" else "", culture,
            french(land)]


# Each test sale has a unique price, used as its key in the assertions.
ROWS = [
    # Bordeaux flat, lot 22 with Carrez + a cellar (lot 30): parcel known to geo-DVF
    row(189000, "33063", "Appartement", 45, lots=[("22", 44.8)]),
    row(189000, "33063", "Dépendance", None, lots=[("30", "")]),
    # same flat sold before: same parcel, same first lot
    row(150000, "33063", "Appartement", 45, date="02/03/2022", lots=[("22", 44.8)]),
    # Bordeaux house on a parcel geo-DVF has never seen: section point
    row(300000, "33063", "Maison", 90, number="7", suffix="", street_type="IMP", street_code="8290",
        plan="99", rooms=4, culture="S", land=200),
    # flat over two lots, no street number (lieu-dit)
    row(210000, "33063", "Appartement", 60, number="", suffix="", street_type="", street_code="B078",
        street="LE VILLAGE", plan="56", lots=[("5", 30.5), ("6", 28.1)], rooms=3),
    # merged commune 01002: geo-DVF knows the parcel under its new id, the old one in ancien_id_parcelle
    row(250000, "01002", "Maison", 100, number="454", suffix="", street_type="RUE", street_code="0090",
        street="DE LA REPUBLIQUE", postcode="01550", section="AB", plan="1", rooms=4),
    # commune 01001, section without a point: commune point
    row(260000, "01001", "Maison", 110, number="3", suffix="T", street_type="CHE", street_code="0100",
        street="DU MOULIN", postcode="01550", section="ZZ", plan="9", rooms=5),
    # Paris 15e flat
    row(500000, "75115", "Appartement", 50, number="12", suffix="", street_type="RUE", street_code="1234",
        street="DE L ABBE GROULT", postcode="75015", section="DJ", plan="98", lots=[("101", 49.5)]),
    # two flats sold together: not a sale of clean, not in the file
    row(333333, "33063", "Appartement", 45, plan="57", lots=[("3", 44)]),
    row(333333, "33063", "Appartement", 45, plan="57", lots=[("4", 44)]),
    # flat with 3 outbuildings: kept with its market flag
    row(222222, "33063", "Appartement", 40, plan="58", lots=[("20", 39)]),
    row(222222, "33063", "Dépendance", None, plan="58", lots=[("21", "")]),
    row(222222, "33063", "Dépendance", None, plan="58", lots=[("22", "")]),
    row(222222, "33063", "Dépendance", None, plan="58", lots=[("23", "")]),
]

GEO_HEADER = ["id_mutation", "nom_commune", "id_parcelle", "ancien_id_parcelle", "longitude", "latitude"]
GEO_ROWS = [
    # two rows of the same parcel: averaged; the commune name holds a quoted comma
    ["2025-1", "Bordeaux, rive droite", "33063000RO0055", "", "-0.570", "44.860"],
    ["2025-2", "Bordeaux", "33063000RO0055", "", "-0.572", "44.862"],
    ["2025-3", "Bordeaux", "33063000RO0056", "", "-0.575", "44.865"],
    ["2025-4", "Bordeaux", "33063000RO0058", "", "-0.576", "44.866"],
    ["2025-5", "A", "01001002AB0001", "01002000AB0001", "5.30", "46.30"],
    ["2025-6", "Paris 15e", "75115000DJ0098", "", "2.2937", "48.8499"],
    ["2025-7", "Bordeaux", "33063000XX0001", "", "", ""],  # no coordinates: ignored
]


@pytest.fixture
def built(tmp_path: Path) -> tuple[duckdb.DuckDBPyConnection, Path]:
    communes = tmp_path / "communes.json"
    communes.write_text(json.dumps(COMMUNES), encoding="utf-8")
    dvf = tmp_path / "ValeursFoncieres-test.txt"
    with dvf.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, delimiter="|")
        writer.writerow(HEADER)
        writer.writerows(ROWS)
    geo = tmp_path / "2025.csv.gz"
    with gzip.open(geo, "wt", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(GEO_HEADER)
        writer.writerows(GEO_ROWS)
    con = duckdb.connect()
    refs.build_commune_map(con, communes)
    con.execute("CREATE TABLE section_point AS SELECT * FROM (VALUES ('33063000RO', -0.58::DOUBLE, 44.85::DOUBLE, 13),"
                " ('01001002AB', 5.2::DOUBLE, 46.2::DOUBLE, 13), ('75115000DJ', 2.29::DOUBLE, 48.84::DOUBLE, 13))"
                " t(section, longitude, latitude, n_parcels)")
    con.execute("CREATE TABLE commune_point AS SELECT * FROM (VALUES ('01001', 5.1::DOUBLE, 46.1::DOUBLE)) "
                "t(code, longitude, latitude)")
    clean.load_raw(con, [dvf])
    clean.build_sales(con)
    dest = tmp_path / "local" / "sales.parquet"
    sales.build(con, [dvf], [geo], dest)
    return con, dest


def _rows(dest: Path) -> dict[int, dict]:
    con = duckdb.connect()
    cursor = con.execute(f"SELECT * FROM '{dest.as_posix()}'")
    names = [d[0] for d in cursor.description]
    return {int(r[names.index("price")]): dict(zip(names, r)) for r in cursor.fetchall()}


def test_one_row_per_clean_sale_with_the_same_id(built):
    con, dest = built
    clean_ids = {r[0] for r in con.execute("SELECT id_mutation FROM dvf_sales").fetchall()}
    rows = _rows(dest)
    assert {r["id_mutation"] for r in rows.values()} == clean_ids
    assert len(rows) == len(clean_ids)
    assert 333333 not in rows


def test_clean_fields_and_market_rules_kept(built):
    rows = _rows(built[1])
    flat = rows[189000]
    assert (flat["property_type"], flat["rooms"], flat["surface_m2"], flat["price_m2"]) == ("apartment", 2, 45, 4200)
    assert flat["n_dependencies"] == 1 and flat["market_excluded"] is None and flat["is_new_build"] is False
    assert rows[222222]["market_excluded"] == "outbuildings"


def test_address_fields_and_title_case(built):
    flat = _rows(built[1])[189000]
    assert (flat["address_number"], flat["address_suffix"], flat["street_type"], flat["street_code"],
            flat["street_name"], flat["postcode"]) == ("108", "B", "CRS", "8285", "SAINT LOUIS", "33300")
    assert flat["street"] == "cours Saint-Louis"
    assert flat["address"] == "108 bis cours Saint-Louis"
    rows = _rows(built[1])
    assert rows[500000]["address"] == "12 rue de l'Abbe Groult"
    assert rows[260000]["address"] == "3 ter chemin du Moulin"
    assert rows[210000]["address"] == "Le Village"  # no number, no street type
    assert rows[250000]["postcode"] == "01550"


def test_lots_with_carrez_from_the_dwelling_rows(built):
    rows = _rows(built[1])
    assert rows[189000]["lots"] == [{"number": "22", "carrez": 44.8}]
    assert rows[189000]["first_lot"] == "22"
    assert rows[210000]["lots"] == [{"number": "5", "carrez": 30.5}, {"number": "6", "carrez": 28.1}]
    assert rows[300000]["lots"] == [] and rows[300000]["first_lot"] is None


def test_parcel_point_then_section_then_commune(built):
    rows = _rows(built[1])
    flat = rows[189000]
    assert flat["location_precision"] == "parcel"
    assert flat["longitude"] == pytest.approx(-0.571) and flat["latitude"] == pytest.approx(44.861)
    assert (rows[300000]["location_precision"], rows[300000]["longitude"]) == ("section", -0.58)
    assert (rows[260000]["location_precision"], rows[260000]["longitude"]) == ("commune", 5.1)
    assert (rows[250000]["location_precision"], rows[250000]["longitude"]) == ("parcel", 5.3)  # old parcel id
    assert rows[500000]["location_precision"] == "parcel"


def test_names_parcel_and_codes(built):
    rows = _rows(built[1])
    paris = rows[500000]
    assert (paris["code_commune"], paris["code_arrondissement"], paris["id_parcelle"]) == (
        "75056", "75115", "75115000DJ0098")
    assert (paris["commune_name"], paris["arrondissement_name"]) == ("Paris", "Paris 15e Arrondissement")
    assert rows[189000]["commune_name"] == "Bordeaux" and rows[189000]["arrondissement_name"] is None
    assert rows[250000]["code_commune"] == "01001"


def test_sorted_by_commune(built):
    con = duckdb.connect()
    codes = [r[0] for r in con.execute(f"SELECT code_commune FROM '{built[1].as_posix()}'").fetchall()]
    assert codes == sorted(codes)


@pytest.mark.parametrize(("street_type", "street", "expected"), [
    ("CRS", "SAINT LOUIS", "cours Saint-Louis"),
    ("BD", "ST MICHEL", "boulevard Saint-Michel"),
    ("AV", "DU MARECHAL FOCH", "avenue du Marechal Foch"),
    ("RUE", "DE L INTENDANCE", "rue de l'Intendance"),
    ("R", "D ALSACE LORRAINE", "rue d'Alsace Lorraine"),
    ("ALL", "DES TILLEULS", "allée des Tilleuls"),
    ("RUE", "LE ROUZIC", "rue Le Rouzic"),
    ("PL", "DE LA REPUBLIQUE", "place de la Republique"),
    ("QU", "DES CHARTRONS", "quai des Chartrons"),
    ("RTE", "DE TOULOUSE", "route de Toulouse"),
    ("SQ", "LOUIS XIV", "square Louis XIV"),
    ("PAS", "SAINTE CROIX", "passage Sainte-Croix"),
    ("CHE", "DE SAINT JEAN DE LUZ", "chemin de Saint-Jean de Luz"),
    ("IMP", "ALSACE-LORRAINE", "impasse Alsace-Lorraine"),
    ("RUE", "DUPRE ST MAUR", "rue Dupre Saint-Maur"),
    (None, "LE VILLAGE", "Le Village"),
    (None, "L ARGONNE", "L'Argonne"),
    ("ZZZ", "DU PORT", "zzz du Port"),
    ("RUE", None, None),
])
def test_format_street(street_type, street, expected):
    assert sales.format_street(street_type, street) == expected


@pytest.mark.parametrize(("number", "suffix", "expected"), [
    ("108", "B", "108 bis"), ("7", None, "7"), ("0012", "T", "12 ter"), ("3", "Q", "3 quater"),
    ("15", "A", "15A"), (None, "B", None), ("", None, None),
])
def test_format_number(number, suffix, expected):
    assert sales.format_number(number, suffix) == expected
