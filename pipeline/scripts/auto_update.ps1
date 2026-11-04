# Weekly scheduled update (docs/PIPELINE_RUN_SPEC.md §4). Registered by the user, see CLAUDE.md.
# Rebuilds only when DVF, geo-DVF, ANIL rents or INSEE changed upstream; logs to data/runs/auto.log.
$ErrorActionPreference = "Stop"
$pipeline = Split-Path -Parent $PSScriptRoot
$log = Join-Path (Split-Path -Parent $pipeline) "data\runs\auto.log"
New-Item -ItemType Directory -Force (Split-Path -Parent $log) | Out-Null
Set-Location $pipeline
$env:PYTHONIOENCODING = "utf-8"
uv run rea auto *>> $log
exit $LASTEXITCODE
