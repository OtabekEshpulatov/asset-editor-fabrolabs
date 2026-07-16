"""Per-scene editable SOURCE bundle in the bucket, co-located with each live-bg mp4:

    live_backgrounds/{world}/{slug}.source/spec.json     # the editable mover spec
    live_backgrounds/{world}/{slug}.source/plate.png     # cached static plate (no objects)
    live_backgrounds/{world}/{slug}.source/assets/{id}.png   # green/magenta cutout SOURCES
    live_backgrounds/{world}/{slug}.source/cuts/{id}.png     # keyed cutout PREVIEWS (editor display; optional)

This bundle is what makes an existing live-bg video editable + re-renderable with NO
LLM/image-gen (see app.livebg.render). It is uploaded by story-gen-exps's publish step
(scripts/v5_publish_livebg_categorized.py). A video without a bundle is simply not
object-editable (the endpoint returns 409).
"""
from __future__ import annotations

import json
from pathlib import Path

SPEC = "spec.json"
PLATE = "plate.png"


def bundle_prefix(video_key: str) -> str:
    """`live_backgrounds/{world}/{slug}.mp4` -> `live_backgrounds/{world}/{slug}.source/`."""
    return video_key.rsplit(".", 1)[0] + ".source/"


def read_spec(video_key: str) -> dict | None:
    from app.storage import minio

    raw = minio.download_bytes(bundle_prefix(video_key) + SPEC)
    if raw is None:
        return None
    try:
        spec = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return spec if isinstance(spec, dict) else None


def write_spec(video_key: str, spec: dict) -> None:
    from app.storage import minio

    minio.upload_bytes(
        json.dumps(spec, indent=1).encode("utf-8"),
        key=bundle_prefix(video_key) + SPEC,
        content_type="application/json",
    )


def needed_source_ids(spec: dict) -> list[str]:
    """The cutout-source ids the render reads (bubbles/fall are procedural — no source)."""
    ids: list[str] = []
    for m in spec.get("movers", []):
        if m.get("kind") in ("bubbles", "fall"):
            continue
        mid = m.get("id")
        if mid:
            ids.append(mid)
        if m.get("kind") == "peek" and m.get("bush"):
            ids.append(m["bush"])
    return ids


def download_to_workdir(video_key: str, spec: dict, workdir: Path) -> None:
    """Populate `workdir/plate.png` + `workdir/assets/{id}.png` from the bucket bundle.
    A missing plate or source is a hard error (we must never fall through to a model)."""
    from app.storage import minio

    pref = bundle_prefix(video_key)
    workdir = Path(workdir)
    (workdir / "assets").mkdir(parents=True, exist_ok=True)
    plate = minio.download_bytes(pref + PLATE)
    if plate is None:
        raise FileNotFoundError(f"bundle missing {pref}{PLATE}")
    (workdir / PLATE).write_bytes(plate)
    for mid in needed_source_ids(spec):
        data = minio.download_bytes(f"{pref}assets/{mid}.png")
        if data is None:
            raise FileNotFoundError(f"bundle missing source {pref}assets/{mid}.png")
        (workdir / "assets" / f"{mid}.png").write_bytes(data)


def cutout_preview_urls(video_key: str, ids: list[str]) -> dict[str, str]:
    """Public URLs of the keyed cutout previews the bundle shipped (one listing call).
    Used only to show the cutout image in the editor; missing previews degrade to a box."""
    from app.storage import minio

    pref = bundle_prefix(video_key) + "cuts/"
    try:
        present = {Path(k).stem: minio.public_url_for_key(k) for k in minio.list_objects(pref)}
    except Exception:  # noqa: BLE001 — previews are optional UI sugar
        return {}
    return {mid: present[mid] for mid in ids if mid in present}


# --- cross-bundle creature palette (for ADDING objects) ---------------------

def scan_global_sources() -> tuple[dict[str, str], dict[str, str]]:
    """Across EVERY scene bundle, the union of placeable creatures: returns
    ({id: assets/{id}.png key}, {id: cuts/{id}.png key}) from a single listing. The first
    occurrence of an id wins — every bundle's source of a shared creature is identical."""
    from app.storage import minio

    sources: dict[str, str] = {}
    cuts: dict[str, str] = {}
    try:
        keys = minio.list_objects("live_backgrounds/")
    except Exception:  # noqa: BLE001
        return {}, {}
    for k in keys:
        if not k.endswith(".png"):
            continue
        if ".source/assets/" in k:
            sources.setdefault(Path(k).stem, k)
        elif ".source/cuts/" in k:
            cuts.setdefault(Path(k).stem, k)
    return sources, cuts


def ensure_source(video_key: str, asset_id: str, sources: dict[str, str], cuts: dict[str, str]) -> bool:
    """Make sure THIS bundle has the green/magenta SOURCE for `asset_id` (copying it in from
    another bundle if needed) so the LLM-free render can key it. Also best-effort copies the
    cutout preview so the editor shows it after reload. Returns False if no source exists anywhere."""
    from app.storage import minio

    pref = bundle_prefix(video_key)
    dst = f"{pref}assets/{asset_id}.png"
    if not minio.object_exists(dst):
        src = sources.get(asset_id)
        if src is None:
            return False
        minio.copy_object(src, dst)
    preview = cuts.get(asset_id)
    if preview:
        cdst = f"{pref}cuts/{asset_id}.png"
        if not minio.object_exists(cdst):
            try:
                minio.copy_object(preview, cdst)
            except Exception:  # noqa: BLE001 — preview is optional UI sugar
                pass
    return True
