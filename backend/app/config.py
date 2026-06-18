"""App-level paths. Storage credentials are NOT here — they are entered in the
UI and held by `app.connection`. This module only resolves the data directory
where the connection record and the override/manifest local caches live.
"""

from __future__ import annotations

import os
from pathlib import Path

# Where runtime state lives: the saved S3 connection plus the local fallback
# copies of the override sidecar and background manifest. In Docker this is a
# mounted volume (ASSET_EDITOR_DATA_DIR=/data); locally it defaults to ./data.
DATA_DIR = Path(os.environ.get("ASSET_EDITOR_DATA_DIR", "./data")).resolve()

CONNECTION_PATH = DATA_DIR / "connection.json"
OVERRIDES_LOCAL_PATH = DATA_DIR / "asset_overrides.json"
MANIFEST_LOCAL_PATH = DATA_DIR / "backgrounds_manifest.json"

# Seed copies shipped in the image — used to bootstrap the data dir on first run
# and as an offline fallback when the connected bucket lacks the manifest yet.
SEEDS_DIR = Path(__file__).resolve().parent / "seeds"

# Built frontend (single-image mode): uvicorn serves these static files itself.
# In the Docker image the Vite build is copied to /srv/web; in local backend-only
# dev the dir won't exist and static serving is skipped (use the Vite dev server).
WEB_DIR = Path(
    os.environ.get("ASSET_EDITOR_WEB_DIR", str(Path(__file__).resolve().parent.parent / "web"))
).resolve()


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def seed_if_missing(local_path: Path, seed_name: str) -> None:
    """Copy a shipped seed into the data dir if no local copy exists yet."""
    if local_path.exists():
        return
    seed = SEEDS_DIR / seed_name
    if not seed.exists():
        return
    ensure_data_dir()
    local_path.write_bytes(seed.read_bytes())
