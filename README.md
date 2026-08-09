# asset-editor

A standalone tool for editing the fairytale asset library — sprites, backgrounds,
and objects stored in an S3-compatible bucket (RustFS). It's the asset-management UI extracted
from `story-gen-exps` into a self-contained Docker app you can run whenever you
need to curate assets, independent of the rest of the pipeline.

What it does:

- **Browse** the whole library by kind (Sprites / Backgrounds / Objects) and
  category; sprites animate live in the grid.
- **Add** new objects (SVG), backgrounds (PNG), or characters (spritesheet + atlas
  per animation).
- **Rename** assets and per-sprite actions; **enable/disable**; edit descriptions.
- **Manage sprite actions** — fps, frame count, enable/disable, add new actions.
- **Edit background zones** visually — trace a polygon around any region, name
  it, describe it, and say what surface it offers; save writes it back to the
  manifest and to the co-located sidecar.
- **Band a plate for depth** — see below.

Edits write to the **same** bucket (`manifests/asset_overrides.json`,
`manifests/backgrounds_manifest.json`, plus per-asset sidecars), so anything that
reads that bucket — including `story-gen-exps` — sees the changes immediately.

## Depth bands

A zone can carry a **`depth`**: an integer ordering a plate's floor strips
back-to-front from 1. That makes it a *band*, and the story engine reads bands
out of the co-located sidecar to place a character at a depth rather than just
somewhere on the floor. A band may also carry a **`scale`** — a multiplier on
the height a character standing there is drawn at, so someone at the back of
the shot looks further away. A factor, never a pixel size; absent means 1.

**A zone with no `depth` is not a band**, and none of the rules below apply to
it. That is what keeps banding opt-in: leave the depth box empty and the zone
behaves exactly as zones always have, on live plates and still backgrounds
alike. Nothing has to be renamed or described first.

Once a zone does carry a depth, all of it is required, because a half-specified
band is worse than none:

| field | rule |
| --- | --- |
| `name` | 3–24 characters — lowercase letters, digits and `_`, starting with a letter. Not one of `left_edge` `left_third` `center` `right_third` `right_edge`: those name screen positions in the story language, not places on the plate |
| `description` | non-empty. This is the sentence the story writer picks on, so say which band it is and how much room it has — "a narrow ledge, room for one or two". That prose is the only honest capacity signal; a number would depend on which characters get placed there |
| `scale` | if given, a finite number above 0 |
| `depth` | unique per plate, and the depths must run 1..N with no gaps |

The editor checks the name and description as you type, and warns about gaps
and duplicates under the zone list — but those are hints. The backend is the
gate: it answers **422** with a message naming the offending zone, and the
editor shows you that message rather than its own.

## Run it

```bash
cp .env.example .env        # then fill in the RustFS access/secret keys
docker compose up --build
```

Open <http://localhost:8080>. Storage auto-connects on startup from the `MINIO_*`
env vars in `.env` (names kept for compatibility — any S3-compatible store works;
`S3_*` equivalents are also accepted). The default endpoint is the dev-station
RustFS over Tailscale: `http://100.72.195.22:9002`, bucket `fairytale-assets`.

- Reaching a store running on your host machine instead: use
  `http://host.docker.internal:<port>` as the endpoint.

Runs on Linux, macOS (Intel + Apple Silicon), and Windows (Docker Desktop / WSL2).

## How it's wired (one image)

A **single image** runs the whole app: the FastAPI backend (uvicorn) serves the
API under `/api`, a `/storage/{bucket}/{key}` **read-proxy** that streams asset
bytes from the connected bucket using the saved credentials (so the browser never
needs direct storage access), **and** the built React frontend (static files + SPA
fallback). No nginx, no second container.

The base catalog ships in the image (`backend/app/catalog/static_asset_catalog.py`);
user additions/renames/config are layered from the bucket's override sidecar and
reloaded when you switch buckets. There is **no** bundled storage server and **no**
semantic search — the editor connects out to whatever bucket you point it at.

## Publish to a registry

Multi-arch (so it runs on amd64 servers / Windows / Intel **and** Apple Silicon):

```bash
docker login
docker buildx create --name aebuilder --driver docker-container --use   # one-time
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <namespace>/asset-editor:latest -t <namespace>/asset-editor:0.1.0 \
  --push .
```

Then anyone can run it with just:

```bash
docker run -p 8080:8000 -v asset-editor-data:/data <namespace>/asset-editor:latest
```

## Deploy (dev VPS)

Deployment lives in **this repo** (moved out of `ai-story-gen`). On push to `main`,
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
builds the single image, pushes it to **`ghcr.io/otabekeshpulatov/asset-editor-fabrolabs`**, then SSHes
into the dev VPS and runs [`scripts/deploy.sh`](scripts/deploy.sh), which generates
`.env`, pulls the image, and brings up [`docker-compose.deploy.yml`](docker-compose.deploy.yml)
(published on `:7777`).

**GitHub → Settings → Environments → `dev`:**

| Secrets | Variables |
| --- | --- |
| `GHCR_PAT` (read:packages, for VPS pulls) | `MINIO_ENDPOINT_URL` |
| `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `SSH_PORT` | `MINIO_BUCKET` (default `fairytale-assets`) |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | `ASSET_EDITOR_PORT` (default `7777`) |
| | `ASSET_EDITOR_DIR` (default `/opt/asset-editor`), `GHCR_USER` (default `OtabekEshpulatov`) |

**One-time server provisioning** (as the deploy user):

```bash
git clone git@github.com:OtabekEshpulatov/asset-editor-fabrolabs.git /opt/asset-editor
# ensure Docker + compose plugin are installed, and the firewall allows :7777
```

After that, every push to `main` redeploys. Trigger manually via the **Run workflow**
button (`workflow_dispatch`).

**Nothing is checked before it deploys.** The workflow builds the image and
ships it; there is no lint, type-check or test step for the backend or either
frontend, so a green run means "the image built" and nothing more.

What you can run yourself, and what it is worth:

```bash
npm --prefix frontend run build       # tsc --noEmit + vite build
npm --prefix frontend-v2 run typecheck && npm --prefix frontend-v2 run test \
  && npm --prefix frontend-v2 run lint && npm --prefix frontend-v2 run build
```

Both are green today, so a failure is yours. The backend has no usable
equivalent: there is no test suite (`backend/tests/` does not exist and pytest
is not a dependency), and `ruff check backend/app` reports thousands of
pre-existing findings, so it cannot tell you whether *your* change is clean.
Compare the count before and after your edit, or lint only the files you
touched.

## Local development (without Docker)

Backend:

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
ASSET_EDITOR_DATA_DIR=./data uvicorn app.main:app --reload --port 8000
```

Frontend (Vite dev server, proxies /api + /storage to :8000):

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
```
