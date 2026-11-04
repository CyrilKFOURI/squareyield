"""`uv run rea-ml train` → evaluates the recipe, trains the final model, writes the package.
`uv run rea-ml predict <model folder> <json>` → estimates one or more properties.
`uv run rea-ml serve` → local API for the app (latest model)."""
import argparse
import json
from datetime import datetime, timezone

from .config import MODEL_NAME, MODELS_DIR, Config


def main() -> None:
    parser = argparse.ArgumentParser(prog="rea-ml")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("train", help="evaluate out of time, train the final model, write the package")
    predict = sub.add_parser("predict", help="estimate properties with a packaged model")
    predict.add_argument("folder")
    predict.add_argument("properties", help='JSON list, e.g. \'[{"property_type": "apartment", ...}]\'')
    serve = sub.add_parser("serve", help="local HTTP API for the app (POST /estimate)")
    serve.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    if args.command == "train":
        from .package import write_package
        from .train import train

        config = Config()
        result = train(config)
        version = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")  # never overwrite a model in use
        folder = write_package(result, config, MODELS_DIR / MODEL_NAME / version)
        print(json.dumps(result.report["test"], indent=2))
        print(f"Model package written to {folder} (not published)")
    if args.command == "predict":
        from .inference import PriceCheckModel

        model = PriceCheckModel.load(args.folder)
        print(json.dumps(model.estimate(json.loads(args.properties)), indent=2, ensure_ascii=False))
    if args.command == "serve":
        from .api import serve as run_server

        run_server(args.port)
