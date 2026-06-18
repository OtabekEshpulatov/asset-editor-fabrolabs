# asset-editor — Deployment (dev)

Cold-start runbook for the standalone asset-editor deploy. Written 2026-06-18.
Everything here is reproducible with **no prior context**. Secret *values* are NOT
in this file — only their names and where to recover them.

## TL;DR

- **Repo:** `git@github.com:OtabekEshpulatov/asset-editor-fabrolabs.git` (private, branch `main`)
- **Image:** `ghcr.io/otabekeshpulatov/asset-editor-fabrolabs` (tags `:dev` and `:<git-sha>`)
- **Live:** http://100.72.195.22:7777/  (tailnet) — health `GET /api/health` → `{"ok":true,"configured":true}`
- **Deploy:** push to `main` (or **Actions → Deploy asset-editor to Dev → Run workflow**) →
  builds image, pushes to GHCR, SSHes to the dev-station, `docker compose up`.

## Architecture

One Docker host — the **dev-station** `fabro-exps`:
- SSH alias `fabro-exps` → HostName `204.168.129.88` (public), User `root`, Port `22`,
  key `~/.ssh/id_ed_hetzner_dev_sf` (this is the laptop's key; see ~/.ssh/config).
  Same box is tailnet `100.72.195.22` (where the UI is reached on :7777).
- `fairytale-minio` container: MinIO, publishes host `:9000` (+ `:9001` console).
- `fairytale-asset-editor` container (this app): single image = FastAPI (uvicorn) serving
  the API under `/api/v4`, a `/storage/{bucket}/{key}` read-proxy, and the built React SPA.
  Publishes host `:7777` → container `:8000`.
- The editor reaches MinIO at **`http://host.docker.internal:9000`** (the compose maps
  `host.docker.internal:host-gateway`, so the container reaches the host's published :9000).

## CI/CD — `.github/workflows/deploy.yml`

Triggers: `push` to `main`, or manual `workflow_dispatch`.
1. **build** (`environment: dev`, `packages: write`): builds `Dockerfile`, pushes
   `ghcr.io/otabekeshpulatov/asset-editor-fabrolabs:dev` + `:<sha>` using the built-in
   `GITHUB_TOKEN` (no PAT needed for push).
2. **deploy** (`appleboy/ssh-action`): SSHes to `${ASSET_EDITOR_DIR:-/opt/asset-editor}`,
   `git fetch origin main && git reset --hard origin/main`, then `bash scripts/deploy.sh`.
   `deploy.sh` writes `.env` from the injected secrets/vars, `docker login ghcr.io`,
   `docker compose -f docker-compose.deploy.yml pull` + `up -d`.

(There is no lint job — the asset-editor backend was never ruff-clean; the frontend
still gets `tsc --noEmit` via the Docker build.)

## GitHub `dev` environment (Settings → Environments → dev)

**Variables** (non-secret):
| Name | Value | Notes |
|---|---|---|
| `MINIO_ENDPOINT_URL` | `http://host.docker.internal:9000` | how the container reaches MinIO on the host |
| `MINIO_BUCKET` | `fairytale-assets` | |
| `ASSET_EDITOR_PORT` | `7777` | host port |
| `ASSET_EDITOR_DIR` | `/opt/asset-editor` | server checkout dir |
| `GHCR_USER` | `OtabekEshpulatov` | for `docker login` on the VPS |

**Secrets** (values NOT here — recovery source in the right column):
| Name | Recover from |
|---|---|
| `SSH_HOST` | `204.168.129.88` (laptop `~/.ssh/config` → `fabro-exps` HostName) |
| `SSH_USER` | `root` |
| `SSH_PORT` | `22` |
| `SSH_PRIVATE_KEY` | laptop `~/.ssh/id_ed_hetzner_dev_sf` |
| `MINIO_ACCESS_KEY` | `fairytale-minio-admin` (the MinIO root user on the dev-station) |
| `MINIO_SECRET_KEY` | the MinIO root password — recoverable on the server from the old editor volume: `docker run --rm -v asset-editor_asset-editor-data:/d alpine cat /d/connection.json` (field `secret_key`), or from the `fairytale-minio` container env |
| `GHCR_PAT` | a **classic PAT with `read:packages`** under `OtabekEshpulatov`; create at https://github.com/settings/tokens/new?scopes=read:packages — used ONLY to pull the private image on the VPS |

> Setting a secret with the GitHub CLI:
> `printf '%s' "<value>" | gh secret set <NAME> --env dev --repo OtabekEshpulatov/asset-editor-fabrolabs`
> Variables: `gh variable set <NAME> --env dev --repo ... --body "<value>"`

## Server git auth (private repo on the dev-station)

The server pulls the repo via a **read-only deploy key** (survives token rotation):
- Key: `/root/.ssh/asset_editor_deploy` on `fabro-exps`.
- Registered on the repo: Settings → Deploy keys → "dev-station (fabro-exps)" (read-only).
- SSH alias in `/root/.ssh/config`:
  ```
  Host github-asset-editor
      HostName github.com
      User git
      IdentityFile /root/.ssh/asset_editor_deploy
      IdentitiesOnly yes
  ```
- Repo cloned at `/opt/asset-editor` with origin `git@github-asset-editor:OtabekEshpulatov/asset-editor-fabrolabs.git`.

To re-create the deploy key:
```bash
ssh fabro-exps 'ssh-keygen -t ed25519 -N "" -f /root/.ssh/asset_editor_deploy -C asset-editor-fabrolabs-deploy'
# add the .pub at: gh api -X POST repos/OtabekEshpulatov/asset-editor-fabrolabs/keys \
#   -f title="dev-station" -f key="<pubkey>" -F read_only=true
```

## Deploy / verify / rollback

**Deploy:** `git push origin main`, or `gh workflow run deploy.yml --repo OtabekEshpulatov/asset-editor-fabrolabs --ref main`.

**Verify:**
```bash
curl -s http://100.72.195.22:7777/api/health                 # {"ok":true,"configured":true}
curl -s http://100.72.195.22:7777/api/storage-info           # endpoint host.docker.internal:9000, key fa…in
curl -s 'http://100.72.195.22:7777/api/v4/assets/catalog?kind=background'   # total:105
curl -s http://100.72.195.22:7777/api/v4/backgrounds/beach_day             # real JSON
```

**Rollback:** images are tagged per-commit. On the server:
```bash
ssh fabro-exps 'cd /opt/asset-editor && IMAGE_TAG=<old-sha> docker compose -f docker-compose.deploy.yml up -d'
```
(or re-run an older successful workflow run, which deploys that commit's `:<sha>`).

## Migration history & gotchas

- Moved out of the `ai-story-gen` repo (was a build-matrix service + `docker-compose.staging.yml`
  entry there). The ai-story-gen working tree already has those removed (uncommitted as of writing).
- The dev-station's **firewall** (`ai-story-gen/infra/firewall.sh`, DOCKER-USER chain, `PORTS=(9000 7777)`,
  source-IP allowlist via `ALLOWED_IPS`) is the ONLY access guard — the editor has **no app-level auth**.
  Keep `7777` in that list. It runs as a root systemd unit on the box.
- First cutover replaced a **manually-deployed** container `asset-editor-app-1`
  (local image `asset-editor:latest`, project "asset-editor" from `docker-compose.yml` `build: .`).
  It was removed to free `:7777`. The new container is `fairytale-asset-editor` from the GHCR image.
- `docker-compose.yml` (`build: .`) is for LOCAL dev; `docker-compose.deploy.yml` (pull GHCR image)
  is what the server runs. Don't confuse them.
- **MinIO creds pitfall:** do NOT reuse `ai-story-gen/.env` MINIO_ROOT_USER (`minioadmin`) — that's a
  different MinIO. The dev-station MinIO root user is `fairytale-minio-admin`.
- API prefix is `/api/v4` (not `/api`). `/api/health`, `/api/storage-info`, `/api/storage-*` are the
  exceptions (defined on the app directly). Unknown paths fall through to the SPA (return index.html, 200).

## Follow-ups

- [ ] Rotate the broad admin PAT used during setup (it was only for `gh` calls; replaced by the deploy key + GHCR_PAT).
- [ ] Commit & push the asset-editor removal in `ai-story-gen` (compose/CI/deploy.sh already cleaned locally).
- [ ] (cosmetic) GitHub Actions warns Node 20 actions run on Node 24 — no action needed.
