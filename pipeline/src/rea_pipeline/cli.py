"""Command line entry point: `uv run rea <command>` (see docs/PIPELINE_RUN_SPEC.md §6).

Stages run strictly in order S0 → S1 → S2 → V1 → S3 → V2 → publish; any failed gate stops
the run and leaves the previously published marts untouched.
"""
import argparse
import json
import shutil
import sys
import time
from datetime import datetime, timezone

import duckdb

from . import clean, dpe, geo, ingest, insee, localtax, mapdata, marts, oll, paths, publish, refs, rents, scores, validate

PUBLISHED_PRICE_KPIS = paths.MARTS / "kpi_price.parquet"
PUBLISHED_YIELD_KPIS = paths.MARTS / "kpi_yield.parquet"
PUBLISHED_SOCIO_KPIS = paths.MARTS / "kpi_socio.parquet"
PUBLISHED_PRICE_BANDS = paths.MARTS / "kpi_price_bands.parquet"
PUBLISHED_LOCAL_TAX = paths.MARTS / "kpi_local_tax.parquet"
PUBLISHED_DPE = paths.MARTS / "kpi_dpe.parquet"
PUBLISHED_SCORES = paths.MARTS / "kpi_score.parquet"
PUBLISHED_OLL = paths.MARTS / "kpi_rent_oll.parquet"
PUBLISHED_OLL_COMMUNES = paths.MARTS / "oll_commune.parquet"
PUBLISHED_STOCK = paths.MARTS / "kpi_stock.parquet"
COMMUNE_POINTS = paths.MARTS / "commune_point.parquet"
RENT_CURVES = paths.MARTS / "rent_child.parquet"
CLEAN_SALES = paths.CLEAN / "dvf" / "sales.parquet"
APP_PUBLIC_DATA = paths.ROOT.parent / "apps" / "app" / "public" / "data"


class GateFailed(Exception):
    pass


def _gate(name: str, checks: list[validate.Check], report: dict) -> None:
    report["gates"][name] = [{"check": c, "ok": ok, "detail": d} for c, ok, d in checks]
    for check, ok, detail in checks:
        print(f"  [{'OK ' if ok else 'FAIL'}] {check}: {detail}")
    if not all(ok for _, ok, _ in checks):
        raise GateFailed(name)


def build_dvf(skip_ingest: bool) -> int:
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = paths.RUNS / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    report: dict = {"run_id": run_id, "stages": {}, "gates": {}}
    started = time.perf_counter()

    def stage(name: str, result) -> None:
        report["stages"][name] = {"seconds": round(time.perf_counter() - started, 1), "result": result}
        print(f"[{name}] done at {report['stages'][name]['seconds']}s")

    con = duckdb.connect(str(run_dir / "work.duckdb"))
    status = 0
    try:
        if not skip_ingest:
            stage("S1 ingest refs", ingest.ingest_refs())
            stage("S1 ingest dvf", ingest.ingest_dvf())
            stage("S1 ingest geo-dvf", geo.ingest_geo_dvf())
            stage("S1 ingest rents", rents.ingest_rents())
            stage("S1 ingest oll", oll.ingest_oll())
            stage("S1 ingest insee", insee.ingest_insee())
            stage("S1 ingest insee housing", insee.ingest_housing())
            stage("S1 ingest rei", localtax.ingest_rei())
            stage("S1 ingest contours", mapdata.ingest_contours())
        refs.build_commune_map(con, ingest.communes_file())
        stage("S0 refs", con.execute("SELECT count(*) FROM commune_map").fetchone()[0])

        geo.build_location_tables(con, geo.geo_dvf_files())
        stage("S0 locations", con.execute("SELECT count(*) FROM section_point").fetchone()[0])
        geo.export_location_tables(con, paths.MARTS)

        clean.load_raw(con, ingest.dvf_files())
        stage("S2 load raw", con.execute("SELECT count(*) FROM dvf_raw").fetchone()[0])
        clean.build_sales(con)
        n_sales = clean.export(con, paths.CLEAN / "dvf" / "sales.parquet")
        stage("S2 clean", n_sales)
        _gate("V1", validate.check_clean(con), report)

        land_share = marts.land_cap_share(con)
        stage("S2 large-land share (houses, worst départements)", dict(list(land_share.items())[:5]))
        marts.build_price_kpis(con, run_id)
        stage("S3 marts", con.execute("SELECT count(*) FROM kpi_price").fetchone()[0])
        marts.build_price_band_kpis(con)
        stage("S3 price bands", con.execute("SELECT count(*) FROM kpi_price_bands").fetchone()[0])
        _gate(
            "V2",
            validate.check_reference_bands(con)
            + validate.check_national_drift(con, PUBLISHED_PRICE_KPIS)
            + validate.check_bucket_sums(con),
            report,
        )

        insee.build_socio_kpis(con, insee.comparateur_file(), run_id)
        stage("S3 socio", con.execute("SELECT count(*) FROM kpi_socio").fetchone()[0])
        insee.build_stock_kpis(con, insee.housing_file())
        stage("S3 housing stock", con.execute("SELECT count(*) FROM kpi_stock").fetchone()[0])
        _gate("V4", validate.check_socio(con), report)

        # rents are weighted by rental homes: after socio
        vintage = rents.edition()
        rents.load_rents(con, rents.RENTS_DIR / str(vintage), vintage)
        rents.build_yield_kpis(con)
        stage("S3 yields", con.execute("SELECT count(*) FROM kpi_yield").fetchone()[0])
        _gate("V3", validate.check_yields(con), report)
        oll.build_oll_kpis(con, oll.national_dir(), oll.zones_file())
        stage("S3 oll rents in place", {"rows": con.execute("SELECT count(*) FROM kpi_rent_oll").fetchone()[0],
                                        "skipped": oll.last_skipped(con)})

        tax_year, rei_csv = localtax.rei_file()
        localtax.build_local_tax_kpis(con, rei_csv, tax_year)
        refs.build_rent_control(con)
        stage("S3 local tax + rent control", {
            "communes_with_rate": con.execute("SELECT count(*) FROM kpi_local_tax").fetchone()[0],
            "rent_control_codes": con.execute("SELECT count(*) FROM rent_control").fetchone()[0],
        })
        _gate("V5", validate.check_local_tax(con), report)

        if not skip_ingest:
            stage("S1 ingest dpe", dpe.ingest_dpe(con))
        dpe.build_dpe_kpis(con, dpe.counts_file())
        stage("S3 dpe", con.execute("SELECT count(*) FROM kpi_dpe").fetchone()[0])
        _gate("V6", validate.check_dpe(con), report)

        scores.build_scores(con)
        stage("S4 scores", con.execute("SELECT count(*) FROM kpi_score").fetchone()[0])
        _gate("V7", validate.check_scores(con), report)

        # publish atomically: write every file next to its target, then rename them all
        price_next = PUBLISHED_PRICE_KPIS.with_name("kpi_price.next.parquet")
        yield_next = PUBLISHED_YIELD_KPIS.with_name("kpi_yield.next.parquet")
        stage("publish prices", marts.export_published(con, price_next))
        socio_next = PUBLISHED_SOCIO_KPIS.with_name("kpi_socio.next.parquet")
        stage("publish yields", rents.export_published(con, yield_next, marts.MIN_PUBLISHED_SALES))
        stage("publish socio", insee.export_published(con, socio_next))
        price_next.replace(PUBLISHED_PRICE_KPIS)
        yield_next.replace(PUBLISHED_YIELD_KPIS)
        socio_next.replace(PUBLISHED_SOCIO_KPIS)
        bands_next = PUBLISHED_PRICE_BANDS.with_name("kpi_price_bands.next.parquet")
        stage("publish price bands", marts.export_price_bands(con, bands_next))
        bands_next.replace(PUBLISHED_PRICE_BANDS)
        tax_next = PUBLISHED_LOCAL_TAX.with_name("kpi_local_tax.next.parquet")
        stage("publish local tax", localtax.export_published(con, tax_next))
        tax_next.replace(PUBLISHED_LOCAL_TAX)
        dpe_next = PUBLISHED_DPE.with_name("kpi_dpe.next.parquet")
        stage("publish dpe", dpe.export_published(con, dpe_next))
        dpe_next.replace(PUBLISHED_DPE)
        scores_next = PUBLISHED_SCORES.with_name("kpi_score.next.parquet")
        stage("publish scores", scores.export_published(con, scores_next))
        scores_next.replace(PUBLISHED_SCORES)
        oll_next = PUBLISHED_OLL.with_name("kpi_rent_oll.next.parquet")
        stage("publish oll", oll.export_published(con, oll_next))
        oll_next.replace(PUBLISHED_OLL)
        for table, target in (("oll_commune", PUBLISHED_OLL_COMMUNES), ("kpi_stock", PUBLISHED_STOCK),
                              ("rent_child", RENT_CURVES)):
            nxt = target.with_name(f"{table}.next.parquet")
            con.execute(f"COPY {table} TO '{nxt.as_posix()}' (FORMAT parquet)")
            nxt.replace(target)
        stage("S5 publish json", publish.publish(con, marts.MIN_PUBLISHED_SALES, run_id))
        report["status"] = "success"
    except GateFailed as failed:
        report["status"] = f"failed at gate {failed}"
        print(f"Run stopped: gate {failed} failed; published marts unchanged.", file=sys.stderr)
        status = 1
    finally:
        con.close()
        (run_dir / "manifest.json").write_text(json.dumps(report, indent=2, default=str))
        (run_dir / "work.duckdb").unlink(missing_ok=True)
    print(f"Run {run_id}: {report['status']} — report in {run_dir}")
    return status


def _changed(result) -> bool:
    """True if an ingest result (a download meta, a list of them, or a dict holding 'files') is new."""
    if isinstance(result, list):
        return any(_changed(item) for item in result)
    if isinstance(result, dict) and "files" in result:
        return any(_changed(item) for item in result["files"].values())
    return isinstance(result, dict) and result.get("skipped") is False


def _ingest_dpe_standalone() -> dict:
    con = duckdb.connect()
    refs.build_commune_map(con, ingest.communes_file())
    return dpe.ingest_dpe(con)


def auto_update() -> int:
    """Scheduled entry point (docs/PIPELINE_RUN_SPEC.md §4): download what changed upstream,
    rebuild and refresh the app only if something did. Exit code 0 when up to date or rebuilt."""
    ingested = {
        "refs": ingest.ingest_refs(),
        "dvf": ingest.ingest_dvf(),
        "geo-dvf": geo.ingest_geo_dvf(),
        "rents": rents.ingest_rents(),
        "oll": oll.ingest_oll(),
        "insee": insee.ingest_insee(),
        "insee-housing": insee.ingest_housing(),
        "rei": localtax.ingest_rei(),
        "contours": mapdata.ingest_contours(),
        "dpe": _ingest_dpe_standalone(),
    }
    changed = [name for name, result in ingested.items() if _changed(result)]
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not changed:
        print(f"{stamp} up to date, nothing to rebuild")
        return 0
    print(f"{stamp} changed upstream: {', '.join(changed)}; rebuilding")
    status = build_dvf(skip_ingest=True)
    if status == 0:
        publish.sync_app(APP_PUBLIC_DATA)
    return status


def main() -> None:
    parser = argparse.ArgumentParser(prog="rea")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="run the full DVF pipeline S0→publish")
    build.add_argument("--skip-ingest", action="store_true", help="reuse files already in data/raw")
    sub.add_parser("ingest", help="S1 only: download refs, DVF, rents and INSEE")
    sub.add_parser("clean-runs", help="delete run folders of failed runs")
    sub.add_parser("sync-app", help="copy data/serve into apps/app/public/data")
    sub.add_parser("publish", help="S5 only: rebuild data/serve from the published marts")
    sub.add_parser("auto", help="scheduled run: rebuild only if an upstream source changed")
    sub.add_parser("locations", help="rebuild and export section/commune points from geo-DVF only")
    args = parser.parse_args()

    if args.command == "build":
        sys.exit(build_dvf(args.skip_ingest))
    if args.command == "ingest":
        print(json.dumps([ingest.ingest_refs(), *ingest.ingest_dvf(), rents.ingest_rents(),
                          insee.ingest_insee()],
                         indent=2, default=str))
    if args.command == "auto":
        sys.exit(auto_update())
    if args.command == "publish":
        con = duckdb.connect()
        refs.build_commune_map(con, ingest.communes_file())
        for table, path in (("kpi_price", PUBLISHED_PRICE_KPIS), ("kpi_yield", PUBLISHED_YIELD_KPIS),
                            ("kpi_socio", PUBLISHED_SOCIO_KPIS), ("kpi_price_bands", PUBLISHED_PRICE_BANDS),
                            ("kpi_local_tax", PUBLISHED_LOCAL_TAX), ("kpi_dpe", PUBLISHED_DPE),
                            ("kpi_score", PUBLISHED_SCORES), ("kpi_rent_oll", PUBLISHED_OLL),
                            ("oll_commune", PUBLISHED_OLL_COMMUNES), ("kpi_stock", PUBLISHED_STOCK),
                            ("commune_point", COMMUNE_POINTS), ("rent_child", RENT_CURVES),
                            ("dvf_sales", CLEAN_SALES)):
            if path.exists():
                con.execute(f"CREATE TABLE {table} AS SELECT * FROM '{path.as_posix()}'")
        refs.build_rent_control(con)
        run_id = con.execute("SELECT any_value(run_id) FROM kpi_price").fetchone()[0]
        print(json.dumps(publish.publish(con, marts.MIN_PUBLISHED_SALES, run_id), indent=2))
    if args.command == "locations":
        con = duckdb.connect()
        geo.build_location_tables(con, geo.geo_dvf_files())
        geo.export_location_tables(con, paths.MARTS)
        print(f"Exported section_point and commune_point to {paths.MARTS}")
    if args.command == "sync-app":
        publish.sync_app(APP_PUBLIC_DATA)
        print(f"Copied {paths.SERVE} -> {APP_PUBLIC_DATA}")
    if args.command == "clean-runs":
        for run in paths.RUNS.glob("*"):
            manifest = run / "manifest.json"
            if manifest.exists() and json.loads(manifest.read_text()).get("status") != "success":
                shutil.rmtree(run)
