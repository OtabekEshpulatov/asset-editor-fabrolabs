"""A small JSON document stored canonically in MinIO, with a local file fallback.

Read: try MinIO first. If the object is missing but a local file exists, seed
MinIO from it. If MinIO is unreachable, fall back to the local file. Write:
update the local copy (atomic) and push to MinIO; if MinIO is down, keep the
local copy and warn (best-effort durability).

Used for the background manifest and the asset-overrides sidecar so zone edits
and add/rename records persist across environments.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Callable

from app.storage import minio

log = logging.getLogger(__name__)


def read_json(*, key: str, local_path: Path) -> Any:
    """Return the document (MinIO canonical), falling back to the local file."""
    try:
        data = minio.download_bytes(key)
    except Exception as exc:  # connection failure, auth, etc. -> use local
        log.warning("json_store: MinIO read failed for %s; using local. %r", key, exc)
        return _read_local(local_path)

    if data is not None:
        try:
            return json.loads(data)
        except json.JSONDecodeError:
            log.warning("json_store: corrupt MinIO object %s; using local", key)
            return _read_local(local_path)

    # MinIO reachable but object absent -> seed it from the local file if present.
    local_bytes = _read_local_bytes(local_path)
    if local_bytes is None:
        return None
    try:
        minio.upload_bytes(local_bytes, key=key, content_type="application/json")
        log.info("json_store: seeded MinIO %s from local file", key)
    except Exception as exc:
        log.warning("json_store: seed upload failed for %s: %r", key, exc)
    try:
        return json.loads(local_bytes)
    except json.JSONDecodeError:
        return None


def write_json(
    doc: Any, *, key: str, local_path: Path, dumps: Callable[[Any], bytes]
) -> None:
    """Persist `doc` to the local cache (atomic) and to MinIO (canonical)."""
    payload = dumps(doc)
    _write_local_atomic(local_path, payload)
    try:
        minio.upload_bytes(payload, key=key, content_type="application/json")
    except Exception as exc:
        if minio._is_storage_endpoint_failure(exc):
            log.warning("json_store: MinIO upload failed for %s; kept local only. %r", key, exc)
        else:
            raise


def _read_local(local_path: Path) -> Any:
    raw = _read_local_bytes(local_path)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _read_local_bytes(local_path: Path) -> bytes | None:
    try:
        return local_path.read_bytes()
    except FileNotFoundError:
        return None


def _write_local_atomic(local_path: Path, payload: bytes) -> None:
    local_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = local_path.with_name(local_path.name + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(local_path)
