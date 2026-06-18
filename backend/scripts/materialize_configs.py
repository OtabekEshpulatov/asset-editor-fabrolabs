#!/usr/bin/env python3
"""One-off migration: materialize a single flat config file per image into MinIO.

Goal: every asset has ONE self-contained, flat config file co-located with its
art, instead of the data being split between the overrides index and partial
co-located mirrors. Naming convention (kept as-is):

  * sprites:     sprites/.../<char>/config.json            (per character)
                 sprites/.../<char>/<action>/config.json   (per action)
  * objects:     objects/<category>/<slug>.json
  * backgrounds: backgrounds/<zone>/<slug>.json

Source of truth is the overrides index (manifests/asset_overrides.json). Each
file is written as a UNION:

    existing-file-fields  <-  index-recorded-fields  <-  authoritative defaults

so authored data already in a file (a background's zones/description, an object's
keywords/height/rest_surface) is never dropped, while `enabled` / `fps` /
`frame_count` always reflect what the system actually uses (index, with defaults).

This mirrors `app.asset_admin.flat_config` exactly, but runs standalone so it can
sweep the whole catalog without booting the FastAPI app.

Usage:
    python scripts/materialize_configs.py                 # DRY RUN (no writes)
    python scripts/materialize_configs.py --execute       # backup + write all
    python scripts/materialize_configs.py --execute --only objects   # one kind
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# --- make the app package importable (script lives in backend/scripts/) --------
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app.catalog.static_asset_catalog import (  # noqa: E402
    BACKGROUND_CATALOG,
    CHARACTER_CATALOG,
    OBJECT_CATALOG,
)

OVERRIDES_KEY = "manifests/asset_overrides.json"
DEFAULT_FPS = 12
DEFAULT_FRAME_COUNT = 25
MAX_WORKERS = 24


# --- credentials / client -----------------------------------------------------
def _load_env_file(path: Path) -> None:
    """Populate os.environ from a .env file for any keys not already set."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.split(" #")[0].strip())


def _make_client():
    # Same env contract as video_agent / the asset-editor connection.
    env_file = os.environ.get("STORY_GEN_ENV") or str(
        BACKEND_ROOT.parent.parent.parent / "story-gen-exps" / ".env"
    )
    _load_env_file(Path(env_file))
    endpoint = os.environ.get("S3_ENDPOINT_URL")
    ak = os.environ.get("S3_ACCESS_KEY")
    sk = os.environ.get("S3_SECRET_KEY")
    bucket = os.environ.get("S3_BUCKET_NAME")
    if not (endpoint and ak and sk and bucket):
        sys.exit("missing S3_* env (set them or STORY_GEN_ENV to a .env with them)")
    import boto3
    from botocore.config import Config as BConf

    client = boto3.client(
        "s3", endpoint_url=endpoint, aws_access_key_id=ak, aws_secret_access_key=sk,
        config=BConf(signature_version="s3v4", connect_timeout=8, read_timeout=120,
                     retries={"max_attempts": 3}),
        region_name="us-east-1")
    return client, bucket


# --- merge (mirrors app.asset_admin.flat_config) ------------------------------
def merge_asset(existing: dict, idx_cfg: dict) -> dict:
    m = {**existing, **idx_cfg}
    m["enabled"] = bool(idx_cfg.get("enabled", True))   # authoritative (index only)
    m.pop("rev", None)                                   # internal cache-buster
    m.setdefault("description", "")
    return m


def merge_action(existing: dict, idx_cfg: dict) -> dict:
    m = {**existing, **idx_cfg}
    m["enabled"] = bool(idx_cfg.get("enabled", True))
    m["fps"] = int(idx_cfg.get("fps") or DEFAULT_FPS)
    m["frame_count"] = int(idx_cfg.get("frame_count") or DEFAULT_FRAME_COUNT)
    m.pop("rev", None)
    m.setdefault("description", "")
    return m


# --- key derivation (mirrors app.asset_admin._key_from_storage_url etc.) -------
def key_from_url(url: str) -> str:
    rest = url.split("?", 1)[0].split("/storage/", 1)[1]   # {bucket}/{key}
    return rest.split("/", 1)[1].lstrip("/")


def sidecar_key(asset_url: str) -> str:
    key = key_from_url(asset_url)
    return key.rsplit(".", 1)[0] + ".json"


# --- planning -----------------------------------------------------------------
def build_plan(idx: dict, s3, bucket: str, only: str | None) -> list[dict]:
    """Return [{key, kind, slug, action, target, needs_read}]. `target` is filled
    now for kinds whose authored data is fully in the index; for objects/
    backgrounds we read the existing file (authored extras) during execution."""
    obj_cfg = idx["object"]["config"]
    bg_cfg = idx["background"]["config"]
    char_cfg = idx["character"]["config"]
    act_cfg = idx["character"].get("actions", {})
    plan: list[dict] = []

    if only in (None, "objects"):
        for slug, url in OBJECT_CATALOG.items():
            plan.append({"key": sidecar_key(url), "kind": "object", "slug": slug,
                         "action": None, "idx": obj_cfg.get(slug, {}), "needs_read": True})
    if only in (None, "backgrounds"):
        for slug, url in BACKGROUND_CATALOG.items():
            plan.append({"key": sidecar_key(url), "kind": "background", "slug": slug,
                         "action": None, "idx": bg_cfg.get(slug, {}), "needs_read": True})
    if only in (None, "characters"):
        for slug, entry in CHARACTER_CATALOG.items():
            base = str(entry.get("sprite_base_path", "")).strip("/")
            if not base:
                continue
            plan.append({"key": f"{base}/config.json", "kind": "character", "slug": slug,
                         "action": None, "idx": char_cfg.get(slug, {}), "needs_read": False})
            actions_cfg = act_cfg.get(slug, {}).get("config", {})
            for action in entry.get("animations", []):
                plan.append({"key": f"{base}/{action}/config.json", "kind": "character",
                             "slug": slug, "action": action,
                             "idx": actions_cfg.get(action, {}), "needs_read": False})
    return plan


def compute_target(item: dict, s3, bucket: str) -> dict:
    existing = {}
    if item["needs_read"]:
        try:
            raw = s3.get_object(Bucket=bucket, Key=item["key"])["Body"].read()
            d = json.loads(raw)
            existing = d if isinstance(d, dict) else {}
        except s3.exceptions.NoSuchKey:
            existing = {}
        except Exception:
            existing = {}
    if item["action"] is not None:
        return merge_action(existing, item["idx"])
    return merge_asset(existing, item["idx"])


# --- main ---------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--execute", action="store_true", help="back up then write (default: dry run)")
    ap.add_argument("--only", choices=["objects", "backgrounds", "characters"])
    ap.add_argument("--workers", type=int, default=MAX_WORKERS)
    args = ap.parse_args()

    s3, bucket = _make_client()
    idx = json.loads(s3.get_object(Bucket=bucket, Key=OVERRIDES_KEY)["Body"].read())
    plan = build_plan(idx, s3, bucket, args.only)

    by_kind: dict[str, int] = {}
    for it in plan:
        k = "action" if it["action"] is not None else it["kind"]
        by_kind[k] = by_kind.get(k, 0) + 1
    print(f"bucket: {bucket}")
    print(f"targets: {len(plan)}  ({by_kind})")

    # samples: one of each kind, before -> after
    print("\n--- samples (existing -> new) ---")
    shown = set()
    for it in plan:
        k = "action" if it["action"] is not None else it["kind"]
        if k in shown:
            continue
        shown.add(k)
        before = {}
        try:
            before = json.loads(s3.get_object(Bucket=bucket, Key=it["key"])["Body"].read())
        except Exception:
            before = "(none — will be created)"
        after = compute_target(it, s3, bucket)
        label = f"{it['slug']}" + (f"/{it['action']}" if it["action"] else "")
        print(f"\n[{k}] {it['key']}  ({label})")
        print(f"  before: {json.dumps(before) if isinstance(before, dict) else before}")
        print(f"  after : {json.dumps(after)}")
        if len(shown) >= 4:
            break

    if not args.execute:
        print("\nDRY RUN — no writes. Re-run with --execute to back up + write.")
        return

    # 1) backup every CURRENT config file we might touch (server-side copy)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_prefix = f"manifests/config_backup/{stamp}/"
    print(f"\nbacking up existing config files -> {backup_prefix} ...")
    existing_keys: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for root in ("sprites/", "objects/", "backgrounds/"):
        for page in paginator.paginate(Bucket=bucket, Prefix=root):
            for o in page.get("Contents", []):
                key = o["Key"]
                base = key.rsplit("/", 1)[-1]
                if not key.endswith(".json"):
                    continue
                if base in ("atlas.json", "spritesheet.json") or base.endswith("_manifest.json"):
                    continue
                existing_keys.append(key)

    def _backup(key: str):
        s3.copy_object(Bucket=bucket, CopySource={"Bucket": bucket, "Key": key},
                       Key=backup_prefix + key)
        return key

    bkn = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for _ in as_completed([ex.submit(_backup, k) for k in existing_keys]):
            bkn += 1
    print(f"backed up {bkn} files.")

    # 2) write all targets
    print(f"writing {len(plan)} config files ...")

    def _write(item: dict):
        body = json.dumps(compute_target(item, s3, bucket), indent=2).encode()
        s3.put_object(Bucket=bucket, Key=item["key"], Body=body,
                      ContentType="application/json")
        return item["key"]

    written, errors = 0, []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(_write, it): it for it in plan}
        for fut in as_completed(futs):
            try:
                fut.result()
                written += 1
                if written % 500 == 0:
                    print(f"  {written}/{len(plan)} ...")
            except Exception as e:
                errors.append((futs[fut]["key"], repr(e)))
    print(f"\nDONE. wrote {written}/{len(plan)} files. backup: {backup_prefix}")
    if errors:
        print(f"{len(errors)} errors (first 5): {errors[:5]}")


if __name__ == "__main__":
    main()
