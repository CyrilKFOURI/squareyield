"""S5 level page files (docs/features/018-speed-and-map/spec.md): one small file per page, every figure ready to
draw, so the app fetches once and computes nothing.

data/serve/levels/
  france.json              per type: France ribbon, every département (price, changes, index France = 100,
                           m² for a year of income, yearly medians and changes), national half-year curve
  departements/<dep>.json  per type: ribbon with rank, curves département / région / France, every commune or
                           arrondissement with its figures and yearly medians and changes
Only cells with at least min_sales sales; edge years holding one half only are left out of yearly arrays.
"""
from pathlib import Path

import duckdb

from .publish import SEARCHABLE_LEVELS, TYPES, _round

# city code → code prefix of its arrondissements
SPLIT_CITIES = {"75056": "751", "69123": "6938", "13055": "132"}


def _years(con: duckdb.DuckDBPyConnection) -> list[str]:
    return [p for (p,) in con.execute(
        "SELECT DISTINCT period FROM kpi_price WHERE period_type = 'year' AND NOT is_partial ORDER BY 1").fetchall()]


def _yearly(con: duckdb.DuckDBPyConnection, min_sales: int) -> dict[tuple[str, str, str], dict[str, float]]:
    """Yearly median €/m² of existing dwellings, all sizes, per (level, code, type)."""
    out: dict[tuple[str, str, str], dict[str, float]] = {}
    for level, code, ptype, period, median in con.execute(
        f"""SELECT geo_level, geo_code, property_type, period, median_price_m2 FROM kpi_price
            WHERE period_type = 'year' AND NOT is_partial AND condition = 'existing' AND rooms_bucket = 'all'
              AND property_type IN {TYPES} AND n_sales >= {min_sales}"""
    ).fetchall():
        out.setdefault((level, code, ptype), {})[period] = median
    return out


def _series(by_year: dict[str, float] | None, years: list[str]) -> dict:
    """Medians aligned on `years`, the change on the year before, and the change over the whole window."""
    medians = [round(by_year[y]) if by_year and y in by_year else None for y in years]
    changes = [None] + [_round(m / b - 1) if m is not None and b else None for b, m in zip(medians, medians[1:])]
    known = [m for m in medians if m is not None]
    growth = _round(known[-1] / known[0] - 1) if len(known) >= 2 and known[0] else None
    return {"medians": medians, "changes": changes, "growth": growth}


def _france(con: duckdb.DuckDBPyConnection, period: str | None, ptype: str) -> dict:
    row = con.execute(
        """SELECT p.median_price_m2, p.p25_price_m2, p.p75_price_m2, p.yoy_change, p.n_sales,
                  CASE WHEN y.status = 'ok' THEN y.rent_m2 END, CASE WHEN y.status = 'ok' THEN y.gross_yield END
           FROM kpi_price p
           LEFT JOIN kpi_yield y ON y.geo_level = p.geo_level AND y.geo_code = p.geo_code AND y.period = p.period
                AND y.period_type = p.period_type AND y.property_type = p.property_type AND y.rooms_bucket = p.rooms_bucket
           WHERE p.geo_level = 'france' AND p.period_type = 'year' AND p.period = ? AND p.condition = 'existing'
             AND p.rooms_bucket = 'all' AND p.property_type = ?""", [period, ptype]
    ).fetchone()
    keys = ("price", "p25", "p75", "yoy", "n", "rent", "yield")
    return {k: _round(v) for k, v in zip(keys, row)} if row else dict.fromkeys(keys)


def _curve(con: duckdb.DuckDBPyConnection, ptype: str, min_sales: int) -> dict:
    rows = con.execute(
        f"""SELECT period, median_price_m2, p25_price_m2, p75_price_m2 FROM kpi_price
            WHERE geo_level = 'france' AND period_type = 'half' AND condition = 'existing' AND rooms_bucket = 'all'
              AND property_type = ? AND n_sales >= {min_sales} ORDER BY period""", [ptype]
    ).fetchall()
    return {"periods": [r[0] for r in rows], "median": [round(r[1]) for r in rows],
            "p25": [round(r[2]) for r in rows], "p75": [round(r[3]) for r in rows]}


def _index(price: float | None, reference: float | None) -> int | None:
    return round(price / reference * 100) if price is not None and reference else None


def _place(row: dict, yearly: dict, years: list[str], france_price: float | None) -> dict:
    """The figures a level page draws for one place (an explorer row, size all)."""
    price, income = row["median_price_m2"], row["median_living_standard"]
    return {
        "code": row["code"], "name": row["name"], "level": row["level"], "n": row["n_sales"],
        "reliability": row["reliability"], "price": price, "p25": row["p25_price_m2"], "p75": row["p75_price_m2"],
        "yoy": row["yoy_change"], "rent": row["rent_m2"], "yield": row["gross_yield"], "net_yield": row["net_yield"],
        "cash_flow": row["cash_flow_monthly"], "score": row["score"], "index": _index(price, france_price),
        "m2_income": _round(income / price) if income and price else None,
        **_series(yearly.get((row["level"], row["code"], row["type"])), years),
    }


def write(con: duckdb.DuckDBPyConnection, serve_dir: Path, min_sales: int, explorer: list[dict], period: str | None,
          departements: list[str], departement_names: dict[str, str], region_names: dict[str, str], dump) -> dict:
    years = _years(con)
    yearly = _yearly(con, min_sales)
    whole = [r for r in explorer if r["size"] == "all"]
    france_doc: dict = {"period": period, "years": years, "types": {}}
    dep_rows: dict[str, dict[str, dict]] = {}
    for ptype in TYPES:
        france = _france(con, period, ptype) | _series(yearly.get(("france", "FR", ptype)), years)
        rows = [r for r in whole if r["level"] == "departement" and r["type"] == ptype]
        places = sorted((_place(r, yearly, years, france["price"]) | {"region": r["parent"]} for r in rows),
                        key=lambda p: p["code"])
        france_doc["types"][ptype] = {"france": france, "rows": places, "curve": _curve(con, ptype, min_sales)}
        by_price = sorted((p for p in places if p["price"] is not None), key=lambda p: -p["price"])
        for rank, place in enumerate(by_price, start=1):
            dep_rows.setdefault(place["code"], {})[ptype] = place | {"rank": rank, "ranked": len(by_price)}
    sizes = {"france_kb": round(dump(serve_dir / "levels" / "france.json", france_doc) / 1024)}

    local = [r for r in whole if r["level"] in SEARCHABLE_LEVELS]
    dep_sizes = []
    for dep in departements:
        own = dep_rows.get(dep, {})
        region = next((p["region"] for p in own.values()), None)
        doc = {"code": dep, "name": departement_names.get(dep, dep), "period": period, "years": years,
               "region": {"code": region, "name": region_names.get(region) if region else None}, "types": {}}
        for ptype in TYPES:
            rows = [r for r in local if r["parent"] == dep and r["type"] == ptype]
            arrondissements = [r["code"] for r in rows if r["level"] == "arrondissement"]
            # a city listed by arrondissement is not also listed whole: its sales would count twice
            rows = [r for r in rows if not (r["code"] in SPLIT_CITIES
                                            and any(a.startswith(SPLIT_CITIES[r["code"]]) for a in arrondissements))]
            communes = sorted((_place(r, yearly, years, france_doc["types"][ptype]["france"]["price"]) for r in rows),
                              key=lambda p: p["code"])
            curves = {
                "departement": _series(yearly.get(("departement", dep, ptype)), years)["medians"],
                "region": _series(yearly.get(("region", region, ptype)), years)["medians"] if region else [None] * len(years),
                "france": france_doc["types"][ptype]["france"]["medians"],
            }
            doc["types"][ptype] = {"kpis": own.get(ptype), "curves": curves, "communes": communes}
        dep_sizes.append(dump(serve_dir / "levels" / "departements" / f"{dep}.json", doc))
    sizes["departement_max_kb"] = round(max(dep_sizes, default=0) / 1024)
    return sizes
