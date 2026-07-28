#!/usr/bin/env bash
# Run the asset-editor backend for local development.
#
# Resolves everything from its own location rather than the caller's cwd — the
# preview launcher starts commands in a shell that cannot always getcwd(), which
# is why the inline form of this failed.
#
# Storage credentials come from the repo .env (MINIO_*). ASSET_EDITOR_DATA_DIR is
# forced to the local ./data dir: the value in .env is /data, which is the path
# inside the Docker image and is not writable here.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi
export ASSET_EDITOR_DATA_DIR="$ROOT/backend/data"

VENV="$ROOT/backend/.venv/bin/uvicorn"
if [ ! -x "$VENV" ]; then
  echo "No venv at $VENV — create it with:" >&2
  echo "  cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

cd "$ROOT/backend"
exec "$VENV" app.main:app --reload --port 8000
