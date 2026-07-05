#!/usr/bin/env python3
"""Reconcile action storage folders with action names.

Action renames are name-only: the display/catalog name changes but the MinIO
folder keeps its original path. So e.g. `sad_3q_right` can live under `sad/` and
`fly_left` under `move_left/`. This sweep finds every action whose storage folder
differs from its name and moves the folder so `folder == name`
(`<sprite_base_path>/<action>/`), repointing the overrides so a fresh apply()
resolves the action to the new folder (no leftover rename, no shadowing tombstone).

The actual move/repoint is `app.asset_admin.materialize_action_folder` — the SAME
logic the interactive rename now calls — so this reconcile and future renames stay
consistent.

Boots standalone (no FastAPI app):
  * the overrides index is read via `overrides.apply()` — canonical bucket copy
    when S3 creds are configured (env), else the local data-dir cache. DRY RUN
    needs no S3 at all (it only compares catalog folders to names).
  * --execute needs a storage connection (env creds) for the server-side copies.

Usage:
    python scripts/reconcile_action_folders.py                         # DRY RUN (writes nothing)
    python scripts/reconcile_action_folders.py --category animals/birds  # scope to birds (dry)
    python scripts/reconcile_action_folders.py --only sparrow            # scope to one character (dry)
    python scripts/reconcile_action_folders.py --execute                 # actually move folders
    python scripts/reconcile_action_folders.py --execute --category animals/birds
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# --- make the app package importable (script lives in backend/scripts/) --------
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from app import asset_admin, connection  # noqa: E402
from app.asset_urls import _spritesheet_url  # noqa: E402
from app.catalog import base_snapshot, catalog, overrides  # noqa: E402
from app.catalog.static_asset_catalog import (  # noqa: E402
    CHARACTER_CATALOG,
    CHARACTER_CATEGORIES,
)


def _boot() -> bool:
    """Layer the connected bucket's overrides onto a pristine base catalog.

    Returns True if a storage connection is configured (required for --execute).
    apply() falls back to the local overrides cache when S3 is unreachable/absent,
    so a dry run works fully offline.
    """
    connection.init_from_env()
    base_snapshot.restore()
    overrides.reset_runtime()
    overrides.apply()
    return connection.is_configured()


def _category_of(slug: str) -> str | None:
    for name, slugs in CHARACTER_CATEGORIES.items():
        if slug in slugs:
            return name
    return None


def _folder_of(entry: dict, action: str) -> str | None:
    return asset_admin._action_storage(entry, action)[2]


def _skip_reason(entry: dict, slug: str, action: str,
                 old_folder: str, new_folder: str) -> str | None:
    """Predict whether the move would be refused (same checks as materialize), so a
    dry run matches what --execute actually does. Returns a reason or None (movable).
    Reads only — writes nothing."""
    old_basename = old_folder.rstrip("/").rsplit("/", 1)[-1]
    analysis = overrides.analyze_action_folder_move(
        slug, action, old_folder_basename=old_basename)
    if not analysis.get("safe"):
        return analysis.get("reason")
    for other in entry.get("animations", []):
        if other != action and _folder_of(entry, other) == new_folder:
            return f"destination folder occupied by {other!r}"
    return None


def build_plan(*, only: str | None, category: str | None) -> list[dict]:
    """[{slug, action, old_folder, new_folder, skip}] for every action whose folder
    != name. `skip` is a reason string when the move would be refused, else None."""
    plan: list[dict] = []
    for slug in sorted(CHARACTER_CATALOG):
        if only and slug != only:
            continue
        if category:
            cat = _category_of(slug) or ""
            if not cat.startswith(category):
                continue
        entry = catalog.get_character(slug)
        if not entry:
            continue
        base = str(entry.get("sprite_base_path", "")).strip("/")
        if not base:
            continue
        for action in sorted(entry.get("animations", [])):
            if not _spritesheet_url((entry.get("animation_urls") or {}).get(action)):
                continue  # unresolvable URL — nothing to move
            old_folder = _folder_of(entry, action)
            new_folder = f"{base}/{action}/"
            if old_folder and old_folder != new_folder:
                plan.append({
                    "slug": slug, "action": action,
                    "old_folder": old_folder, "new_folder": new_folder,
                    "skip": _skip_reason(entry, slug, action, old_folder, new_folder),
                })
    return plan


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--execute", action="store_true",
                    help="actually move folders (default: dry run, writes nothing)")
    ap.add_argument("--only", metavar="SLUG", help="scope to a single character slug")
    ap.add_argument("--category", metavar="PREFIX",
                    help="scope to a character-category prefix (e.g. animals/birds)")
    args = ap.parse_args()

    configured = _boot()
    plan = build_plan(only=args.only, category=args.category)

    scope = []
    if args.only:
        scope.append(f"only={args.only}")
    if args.category:
        scope.append(f"category={args.category}")
    movable = [it for it in plan if not it["skip"]]
    unsafe = [it for it in plan if it["skip"]]
    print(f"scope: {', '.join(scope) or 'ALL characters'}")
    print(f"storage: {'configured' if configured else 'OFFLINE (local overrides cache)'}")
    print(f"mismatched actions (folder != name): {len(plan)}")
    print(f"  would move : {len(movable)}")
    print(f"  would skip : {len(unsafe)} (corrupted/ambiguous chains — left untouched)")
    print(f"characters affected: {len(sorted({it['slug'] for it in plan}))}")
    print()

    for it in plan:
        tag = f"   [SKIP: {it['skip']}]" if it["skip"] else ""
        print(f"  {it['slug']}/{it['action']}: {it['old_folder']} -> {it['new_folder']}{tag}")

    if not args.execute:
        print(f"\nDRY RUN — nothing written. {len(movable)} folders WOULD move, "
              f"{len(unsafe)} WOULD be skipped. Re-run with --execute to apply.")
        return

    if not configured:
        sys.exit("\n--execute needs a storage connection: set MINIO_*/S3_* env "
                 "(endpoint, access, secret, bucket).")

    print(f"\nEXECUTING {len(plan)} folder moves ...")
    moved = skipped = failed = 0
    errors: list[tuple[str, str]] = []
    for it in plan:
        label = f"{it['slug']}/{it['action']}"
        try:
            res = asset_admin.materialize_action_folder(it["slug"], it["action"])
            if res.get("moved"):
                moved += 1
                print(f"  MOVED  {label}: {res['old_folder']} -> {res['new_folder']} "
                      f"(origin={res.get('origin')}, copied={res.get('copied')}, "
                      f"deleted={res.get('deleted')}, tombstoned={res.get('tombstoned')}, "
                      f"dropped_added={res.get('dropped_added')})")
            else:
                skipped += 1
                print(f"  SKIP   {label}: {res.get('reason')}")
        except Exception as exc:  # noqa: BLE001 — keep going, report at the end
            failed += 1
            errors.append((label, repr(exc)))
            print(f"  FAIL   {label}: {exc!r}")

    print(f"\nDONE. moved={moved} skipped={skipped} failed={failed}")
    if errors:
        print(f"{len(errors)} errors (first 5): {errors[:5]}")


if __name__ == "__main__":
    main()
