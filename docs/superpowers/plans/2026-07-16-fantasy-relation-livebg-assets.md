# Fantasy Relation Live Background Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate, select, render, verify, and safely register three Fantasy connector live backgrounds with six Gemini candidates and a complete reciprocal endpoint audit.

**Architecture:** One isolated pilot CLI owns immutable endpoint review, Gemini candidate caches, deterministic render/bundle creation, local verification, and receipt-bound single-slug publishing. The existing broad publisher and registrar are never invoked. Asset Editor remains a local no-LLM verifier/rerenderer.

**Tech Stack:** Python 3.12, `google-genai`, Pillow, ffmpeg/ffprobe, boto-compatible storage client, Pydantic manifest models, pytest, existing deterministic `v5_livebg` renderer, Asset Editor livebg bundle APIs.

## Global Constraints

- Read `GEMINI_API_KEY` only from the process environment. Never write, print, serialize, cache, or commit it.
- Do not read `.env.bak-pre-rustfs`, call `load_dotenv`, or pass a credential through a command line.
- Use stable model `gemini-3-pro-image` with explicit `16:9`, `2K`, and image-only output.
- Generate exactly two independent candidates per connector; never overwrite a candidate or selected asset.
- Grand Hall must be selected before Cloister generation so the reciprocal arch is a real reference.
- Treat the approved 13-edge, two-sided endpoint matrix and anchor hashes as the generation gate.
- Do not modify or invoke broad `v5_publish_livebg_categorized.py`, broad `v5_register_live_backgrounds.py`, broad manifest rebuild, or WAN V2 generation.
- Render deterministically after plate selection. Any missing mover source is a hard failure, never an image-model fallback.
- Dry-run is the publishing default. Mutations require one literal slug and a matching immutable artifact manifest/receipt.
- Never overwrite or delete a remote object. Publish MP4 last as the discovery/commit marker.
- Keep generated artifacts under `demo_out/fantasy_relation_bgs/`; source code and locked config remain tracked.
- Never import `scripts/v5_livebg.py`; it calls dotenv at import time. Use the no-LLM Asset Editor renderer through an explicit backend root.
- Ignored anchor media and mover sources are absent from the worktree. Every operational command must receive absolute read-only roots in the original story tree plus an explicit writable output root.
- Final remote objects require atomic create-if-absent semantics, and manifest registration requires a hash compare-and-swap under an OS lock.

---
## Task 1: Safe pilot CLI and locked node configuration

**Files:**

- Create in story project: `scripts/v5_fantasy_relation_bgs.py`
- Create in story project: `scripts/data/v5_fantasy_relation_bgs.json`
- Create in story project: `tests/scripts/test_v5_fantasy_relation_bgs.py`

- [ ] Write parser/config tests for commands `audit-intent`, `audit-final`, `generate`, `select`, `render`, `verify`, `publish`, and `register`. Assert required explicit source/output roots, one literal allowlisted slug, no glob/list/all value, dry-run publishing default, and immutable output paths.

- [ ] Confirm collection fails because the pilot module is absent.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py `
  -k "config or parser or slug" -q
```

- [ ] Implement a side-effect-free import and a `main(argv=None, deps=None)` seam. External clients and subprocess execution must be injected or wrapped so tests never use network.

- [ ] Lock exactly three nodes, generation order, reference slugs, prompts, descriptions, zone definitions, and reviewed mover allowlists in JSON. Crossroads references Meadow/Market/Gate; Hall references Courtyard/Throne/Library; Cloister references selected Hall/Garden/Library.

- [ ] Refuse unknown config fields, duplicate nodes, missing references, and changes that conflict with the approved endpoint ordering.

- [ ] Commit the green scaffolding.

```powershell
git add scripts/v5_fantasy_relation_bgs.py scripts/data/v5_fantasy_relation_bgs.json tests/scripts/test_v5_fantasy_relation_bgs.py
git commit -m "feat: scaffold fantasy relation background pipeline"
```

---

## Task 2: Immutable endpoint-frame audit gate

**Files:**

- Modify: `scripts/v5_fantasy_relation_bgs.py`
- Modify: `tests/scripts/test_v5_fantasy_relation_bgs.py`
- Consume: `backend/engine/world_graphs/fantasy_kingdom.json`
- Consume: `assets/manifest/assets_manifest.remote.json`

- [ ] Add tests for exactly 11 graph nodes and 13 routes, all 26 directed endpoint views, three frames per existing anchor, real `floor` versus `ground` zone validation, valid landmark IDs and percentages, source hashes, ffprobe metadata, graph-hash binding, and refusal to reuse a run ID.

- [ ] Confirm audit tests fail before implementation.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py `
  -k audit -q
```

- [ ] Implement frame extraction for start, midpoint, and final-safe frame from all eight anchors. Require H.264/yuv420p, 24 FPS, approximately 24 seconds; record dimensions without assuming local 720p equals published 1080p.

- [ ] Write `<output-root>/audit/<run-id>/intent-review.json` exclusively. Record the intent graph SHA-256, manifest SHA-256, eight anchor video/plate hashes, media facts, anchor endpoint facts, planned connector endpoint facts, frame paths, and explicit reviewer status. Never overwrite it.

- [ ] Require every existing-anchor endpoint to target a visible path, door, arch, stair, or frame edge. Candidate generation must reject an unreviewed intent receipt or changed intent graph hash; planned connector endpoints are not yet visually approved.

- [ ] Run the real audit only after the runtime branch has the structural sidecar, visually review contact sheets, mark approval, rerun validation, and commit only code/tests.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs audit-intent `
  --graph backend\engine\world_graphs\fantasy_kingdom.json `
  --manifest C:\Users\Claude2\Desktop\Projects\story-gen-exps\assets\manifest\assets_manifest.remote.json `
  --anchor-video-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\demo_out\videos\kingdom `
  --anchor-plate-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\backend\engine_v5\live_backgrounds `
  --output-root demo_out\fantasy_relation_bgs `
  --run-id endpoint-audit-01
```

```powershell
git add scripts/v5_fantasy_relation_bgs.py tests/scripts/test_v5_fantasy_relation_bgs.py
git commit -m "feat: gate relation backgrounds on endpoint audit"
```

---

## Task 3: Gemini candidate generation, retry, and secret hygiene

**Files:**

- Modify: `scripts/v5_fantasy_relation_bgs.py`
- Modify: `tests/scripts/test_v5_fantasy_relation_bgs.py`

- [ ] With a fake Gemini client, test missing process credential before client creation, exact model/config, up to three references, two separate calls, three bounded attempts per candidate for retryable timeout/quota/empty image, corrupt-cache abort, valid-cache skip, Cloister dependency, and absence of a fake credential sentinel from all files and captured output.

- [ ] Confirm candidate tests fail before implementation.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py `
  -k "candidate or credential or retry or cloister" -q
```

- [ ] Construct the Google client only after audit and credential checks. Use:

```python
types.GenerateContentConfig(
    response_modalities=["IMAGE"],
    image_config=types.ImageConfig(
        aspect_ratio="16:9",
        image_size="2K",
        output_mime_type="image/png",
    ),
)
```

- [ ] Make one request per candidate using `gemini-3-pro-image`. Accept only a PNG with 16:9 2K-class dimensions; hash it before metadata commit.

- [ ] Write each candidate into an exclusively created `demo_out/fantasy_relation_bgs/candidates/<slug>/<candidate-id>/`. Metadata is allowlisted to model, candidate ID, prompt hash, reference hashes, image hash/dimensions, and attempt count. Never persist environment/config dumps or raw exception representations.

- [ ] Require an immutable Hall selection file before resolving Hall as Cloister's reference. Commit implementation and fake-client tests.

```powershell
git add scripts/v5_fantasy_relation_bgs.py tests/scripts/test_v5_fantasy_relation_bgs.py
git commit -m "feat: generate immutable gemini background candidates"
```

---
## Task 4: Immutable selection, deterministic render, and complete bundle

**Files:**

- Modify: `scripts/v5_fantasy_relation_bgs.py`
- Modify: `tests/scripts/test_v5_fantasy_relation_bgs.py`
- Reuse through an explicit backend root: `asset-editor-fabrolabs/backend/app/livebg/render.py`

- [ ] Test candidate hash selection, no reselection/overwrite, 11-plate final endpoint audit, missing mover hard failure, zero import/call of `scripts.v5_livebg.py`, zero model call, Asset Editor deterministic render, 2K plate preservation, atomic final rename, existing-output abort, and complete `spec/plate/assets/cuts` bundle.

- [ ] Confirm render/bundle tests fail.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py `
  -k "select or render or bundle or media" -q
```

- [ ] Make `select --node fk_castle_grand_hall_live --candidate c01` write an exclusive immutable selection containing candidate and image hashes. Selection never copies or rewrites the plate; these are the exact option names used by tests and operations.
- [ ] Validate every selected connector's visible landmark against its planned `center_pct`. If a small coordinate adjustment is necessary, change the design matrix and structural graph sidecar together before rendering; route IDs and left-to-right ordering stay fixed.

- [ ] After all three selections, run `audit-final` across the eight anchor plates plus three selected connector plates. Verify all 26 directed endpoint views, selected image hashes, final coordinates, and final graph SHA-256.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe -m scripts.v5_fantasy_relation_bgs audit-final --graph backend\engine\world_graphs\fantasy_kingdom.json --intent-review demo_out\fantasy_relation_bgs\audit\endpoint-audit-01\intent-review.json --anchor-plate-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\backend\engine_v5\live_backgrounds --output-root demo_out\fantasy_relation_bgs --run-id endpoint-final-01
```

- [ ] Write `<output-root>/audit/endpoint-final-01/final-review.json` exclusively. Rendering, verification, publishing, registration, and graph activation must reject a missing receipt, changed selected-image hash, or changed final graph hash.



- [ ] Prevalidate every nonprocedural mover from the explicit read-only mover root. Allow only reviewed `cloud_white`, `pennant`, or `twinkle_star` sources plus procedural particles. Import `app.livebg.render.rerender` only from the explicit Asset Editor backend root; never import `scripts.v5_livebg.py` and never expose an image-generation fallback.

- [ ] Render the native 1280x720 deterministic loop, then transcode to 1920x1080 H.264/yuv420p, 24 FPS, approximately 24 seconds. Keep the selected 2K plate in the source bundle.

- [ ] Build the full final tree in a temporary sibling, validate it, then atomically rename. Refuse any existing final file or directory.

```text
demo_out/fantasy_relation_bgs/publish/
  live_backgrounds/castle/<slug>.mp4
  live_backgrounds/castle/<slug>.json
  live_backgrounds/castle/<slug>.source/spec.json
  live_backgrounds/castle/<slug>.source/plate.png
  live_backgrounds/castle/<slug>.source/assets/<id>.png
  live_backgrounds/castle/<slug>.source/cuts/<id>.png
```

- [ ] Verify codec, pixel format, dimensions, FPS, duration tolerance, MP4 `ftyp`, bundle completeness, candidate/selection hash chain, and start/middle/end frame stability. Commit.

```powershell
git add scripts/v5_fantasy_relation_bgs.py tests/scripts/test_v5_fantasy_relation_bgs.py
git commit -m "feat: render verified relation background bundles"
```

---

## Task 5: No-LLM Asset Editor bundle verifier

**Files in `asset-editor-fabrolabs`:**

- Create: `backend/app/livebg/verify_bundle.py`
- Create: `backend/app/livebg/tests/test_verify_bundle.py`
- Reuse: `backend/app/livebg/render.py`
- Reuse: `backend/app/livebg/bundle.py`

- [ ] Test a valid source bundle rerenders locally, missing required files fail, output media is checked, and importing top-level `google` or `openai` during verification is blocked.

- [ ] Confirm the test fails because `verify_bundle` is absent.

```powershell
Set-Location C:\Users\Claude2\Desktop\Projects\asset-editor-fabrolabs\backend
python -m pytest app\livebg\tests\test_verify_bundle.py -q
```

- [ ] Implement a filesystem-only CLI that loads the source bundle, invokes existing `render.rerender(spec, plate_img, workdir)`, validates the produced MP4, and writes verification output outside the source tree.

- [ ] Run the new test plus existing no-LLM and roundtrip tests, then commit in the Asset Editor repository.

```powershell
python -m pytest `
  app\livebg\tests\test_rerender_no_llm.py `
  app\livebg\tests\test_service_roundtrip.py `
  app\livebg\tests\test_verify_bundle.py -q
git add backend/app/livebg/verify_bundle.py backend/app/livebg/tests/test_verify_bundle.py
git commit -m "feat: verify live background source bundles"
```

---

## Task 6: Receipt-bound single-slug publishing and registration

**Files in story project:**

- Modify: `scripts/v5_fantasy_relation_bgs.py`
- Modify: `tests/scripts/test_v5_fantasy_relation_bgs.py`
- Modify only through guarded command: `assets/manifest/assets_manifest.remote.json`

- [ ] With fake storage and a temporary manifest, test dry-run default, exactly one slug, allowlisted final keys, initial HEAD conflict abort, a simulated destination race, conditional create failure, transaction staging, hash verification, MP4-last order, partial failure receipt, no registration after failure, same-receipt resume, no overwrite/delete, manifest SHA mismatch abort, one-entry manifest diff, `live_castle` category, and full `AssetManifest.model_validate` before replacement.

- [ ] Confirm publish/register tests fail before implementation.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py `
  -k "publish or register or manifest" -q
```

- [ ] Make `publish` dry-run unless `--execute` and an exact artifact manifest are both present. HEAD every final key as an early check, upload to a transaction prefix outside `live_backgrounds/`, verify size/hash, then create each final destination with a storage-level `If-None-Match: *` conditional PUT or equivalent create-if-absent primitive. Treat 409/412 as a conflict, never fall back to overwrite, and create MP4 last.

- [ ] On any failure, persist a noncommitted receipt and never register. Resume may fill only missing objects from that exact receipt; matching keys are verified and mismatches abort.

- [ ] Make `register` require a committed receipt and verify every final remote key. Record the source manifest SHA-256, acquire an exclusive OS lock, re-read and compare the SHA under the lock, abort on mismatch, add only the requested `live_castle` entry, validate the entire manifest, assert the diff is exactly one background plus count, and perform same-directory atomic replacement while holding the lock.

- [ ] Rerun all pipeline tests and commit code. Do not commit an operational manifest change until actual publish verification succeeds.

```powershell
git add scripts/v5_fantasy_relation_bgs.py tests/scripts/test_v5_fantasy_relation_bgs.py
git commit -m "feat: publish relation backgrounds transactionally"
```

---
## Task 7: Generate and visually select six candidates

- [ ] Verify `GEMINI_API_KEY` exists in the process environment without printing its value. If absent, stop before client creation and ask the user to set it securely.

- [ ] Generate two Crossroads candidates and two Grand Hall candidates from the approved audit.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs generate `
  --node fk_castle_crossroads_live --count 2 `
  --intent-review demo_out\fantasy_relation_bgs\audit\endpoint-audit-01\intent-review.json `
  --anchor-plate-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\backend\engine_v5\live_backgrounds `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs generate `
  --node fk_castle_grand_hall_live --count 2 `
  --intent-review demo_out\fantasy_relation_bgs\audit\endpoint-audit-01\intent-review.json `
  --anchor-plate-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\backend\engine_v5\live_backgrounds `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs select `
  --node fk_castle_grand_hall_live --candidate c01 `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs generate `
  --node fk_castle_cloister_live --count 2 `
  --intent-review demo_out\fantasy_relation_bgs\audit\endpoint-audit-01\intent-review.json `
  --anchor-plate-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\backend\engine_v5\live_backgrounds `
  --output-root demo_out\fantasy_relation_bgs
```

- [ ] Build contact sheets and score art match, locked camera, clear lower 40%, all required unique route landmarks, no people/text/logos, and reciprocal architectural identity. Select Grand Hall before Cloister.

- [ ] Generate two Cloister candidates using the immutable selected Hall plate, then score and select.

- [ ] For any failed candidate, create a new candidate ID and refine only the violated constraint; never overwrite or silently replace.

- [ ] Record selected candidate IDs and hashes. Do not commit generated images or secrets.
- [ ] Run the final 11-plate/26-endpoint audit and review its contact sheet. Do not begin rendering until `endpoint-final-01/final-review.json` is immutable and its final graph hash matches the structural sidecar.


---

## Task 8: Render and verify all three live background bundles

- [ ] Render each selected node through deterministic code-only motion.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs render --node fk_castle_crossroads_live `
  --final-review demo_out\fantasy_relation_bgs\audit\endpoint-final-01\final-review.json `
  --mover-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\demo_out\livebg\assets `
  --asset-editor-backend-root C:\Users\Claude2\Desktop\Projects\asset-editor-fabrolabs\backend `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs render --node fk_castle_grand_hall_live `
  --final-review demo_out\fantasy_relation_bgs\audit\endpoint-final-01\final-review.json `
  --mover-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\demo_out\livebg\assets `
  --asset-editor-backend-root C:\Users\Claude2\Desktop\Projects\asset-editor-fabrolabs\backend `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs render --node fk_castle_cloister_live `
  --final-review demo_out\fantasy_relation_bgs\audit\endpoint-final-01\final-review.json `
  --mover-root C:\Users\Claude2\Desktop\Projects\story-gen-exps\demo_out\livebg\assets `
  --asset-editor-backend-root C:\Users\Claude2\Desktop\Projects\asset-editor-fabrolabs\backend `
  --output-root demo_out\fantasy_relation_bgs
```

- [ ] Run built-in media/hash verification, then Asset Editor rerender verification for each source bundle.

- [ ] Inspect start, midpoint, and end frames. Require locked camera, acceptable loop seam, no mover drift, unobstructed stage, correct endpoint landmarks, H.264/yuv420p, 1920x1080, 24 FPS, and approximately 24 seconds.

- [ ] Save verification receipts under `demo_out/fantasy_relation_bgs/verification/` and keep generated media untracked.

---

## Task 9: Publish, register, refresh, and unlock graph activation

- [ ] Run dry-run publish for one slug and review the exact key list. Execute only after local and Asset Editor verification pass.

- [ ] Publish and register one slug at a time in order: Crossroads, Grand Hall, Cloister. Require a committed receipt before each registration. Never use a broad command.
The first slug's exact dry-run, execute, and registration sequence is:

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs publish --slug fk_castle_crossroads_live `
  --final-review demo_out\fantasy_relation_bgs\audit\endpoint-final-01\final-review.json `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs publish --slug fk_castle_crossroads_live --execute `
  --transaction-id fk-crossroads-01 `
  --artifact-manifest demo_out\fantasy_relation_bgs\publish\fk_castle_crossroads_live.publish.json `
  --final-review demo_out\fantasy_relation_bgs\audit\endpoint-final-01\final-review.json `
  --output-root demo_out\fantasy_relation_bgs
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m scripts.v5_fantasy_relation_bgs register --slug fk_castle_crossroads_live --execute `
  --receipt demo_out\fantasy_relation_bgs\receipts\fk-crossroads-01.json `
  --manifest C:\Users\Claude2\Desktop\Projects\story-gen-exps\assets\manifest\assets_manifest.remote.json
```


- [ ] After all three are registered, reload the manifest in a fresh process and assert all three exist.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe -c "from backend.engine.assets.manifest import load_manifest; load_manifest.cache_clear(); m=load_manifest(); assert all(s in m.backgrounds for s in ('fk_castle_crossroads_live','fk_castle_grand_hall_live','fk_castle_cloister_live'))"
```

- [ ] Verify each remote MP4 and source bundle is retrievable. Restart long-running engine/editor processes or clear their caches.

- [ ] Only now complete runtime-plan Task 8: append Fantasy ownership slugs, activate the production graph sidecar, and run graph-on story/render verification.

- [ ] Run final regressions.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\scripts\test_v5_fantasy_relation_bgs.py tests\engine_v5 tests\video -q
Set-Location C:\Users\Claude2\Desktop\Projects\asset-editor-fabrolabs\backend
python -m pytest app\livebg\tests -q
```

## References

- Approved design and endpoint matrix: `docs/superpowers/specs/2026-07-16-fantasy-relation-background-pilot-design.md`
- Runtime plan: `docs/superpowers/plans/2026-07-16-fantasy-world-graph-runtime.md`
- Gemini 3 Pro Image model: https://ai.google.dev/gemini-api/docs/models/gemini-3-pro-image
- Gemini image generation guide: https://ai.google.dev/gemini-api/docs/image-generation
- Google Gen AI Python SDK: https://googleapis.github.io/python-genai/
