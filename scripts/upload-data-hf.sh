#!/usr/bin/env bash
# Upload data/serve to a public Hugging Face dataset repo, read by the deployed app (docs/features/022-full-frontend/spec.md).
# Needs `hf auth login` once. Publishes individual DVF sales (data/serve/sales): run only on the owner's say-so.
#   scripts/upload-data-hf.sh <user>/<repo>
set -euo pipefail
# a recent hf CLI, forced to IPv4: on this PC most IPv6 connections to huggingface.co are reset (WinError 10054)
# while IPv4 always works (measured 2026-10-29: IPv6 3/12 ok, IPv4 12/12)
hf() {
  uv run --no-project --with huggingface_hub python -c "
import socket, sys
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *a, **k: [r for r in _getaddrinfo(*a, **k) if r[0] == socket.AF_INET]
from huggingface_hub.cli.hf import main
sys.exit(main())" "$@"
}
repo="${1:?usage: scripts/upload-data-hf.sh <user>/<repo>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
# many small files: hf 2.x splits them into several commits; re-run the same command to resume
# this PC's connection to Hugging Face is sometimes cut (WinError 10054): retry, the upload resumes
for attempt in 1 2 3 4 5 6 7 8; do
  if hf repos create "$repo" --repo-type dataset --exist-ok >/dev/null      && hf upload "$repo" "$root/data/serve" . --repo-type dataset --no-private --commit-message "data: serve layer"; then
    break
  fi
  [[ $attempt == 8 ]] && { echo "Upload failed 8 times: check the connection (VPN, antivirus web protection)"; exit 1; }
  echo "Connection cut, retry $attempt/8 in 10 s…"; sleep 10
done
echo "Data URL: https://huggingface.co/datasets/$repo/resolve/main"
