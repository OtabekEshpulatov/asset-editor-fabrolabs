"""Environment-driven S3/MinIO storage config.

The editor runs alongside its MinIO, so storage credentials come from the
container environment (MINIO_* with S3_* as a fallback), read once at startup.
There is no UI-driven connection flow.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

log = logging.getLogger(__name__)


class NotConfigured(RuntimeError):
    """Raised when a storage operation is attempted before a connection is set."""


@dataclass(frozen=True)
class ConnectionConfig:
    endpoint_url: str
    access_key: str
    secret_key: str
    bucket: str
    public_url: str = "/storage"

    def with_public_url(self) -> str:
        return (self.public_url or "/storage").rstrip("/")


_current: ConnectionConfig | None = None


def init_from_env() -> None:
    """Configure storage from environment variables (no UI). Accepts MINIO_*
    names, falling back to S3_*. Leaves storage unconfigured (and logs) if the
    credentials are incomplete."""
    global _current
    endpoint = os.environ.get("MINIO_ENDPOINT_URL") or os.environ.get("S3_ENDPOINT_URL")
    access = os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("S3_ACCESS_KEY")
    secret = os.environ.get("MINIO_SECRET_KEY") or os.environ.get("S3_SECRET_KEY")
    bucket = os.environ.get("MINIO_BUCKET") or os.environ.get("S3_BUCKET_NAME")
    public_url = os.environ.get("ASSET_EDITOR_PUBLIC_URL", "/storage")
    if endpoint and access and secret and bucket:
        _current = ConnectionConfig(
            endpoint_url=endpoint, access_key=access,
            secret_key=secret, bucket=bucket, public_url=public_url,
        )
        log.info("storage configured from env: %s bucket=%s", endpoint, bucket)
    else:
        _current = None
        log.warning(
            "storage env incomplete — need MINIO_ENDPOINT_URL / MINIO_ACCESS_KEY / "
            "MINIO_SECRET_KEY / MINIO_BUCKET (or S3_* equivalents)"
        )


# --- accessors ----------------------------------------------------------------

def get() -> ConnectionConfig | None:
    return _current


def is_configured() -> bool:
    return _current is not None


def require() -> ConnectionConfig:
    if _current is None:
        raise NotConfigured("no storage connection configured")
    return _current


def _mask(value: str) -> str:
    if len(value) <= 4:
        return "•" * len(value)
    return value[:2] + "•" * (len(value) - 4) + value[-2:]


def status() -> dict:
    """Storage info for the UI — never returns the secret."""
    if _current is None:
        return {"configured": False}
    return {
        "configured": True,
        "endpoint_url": _current.endpoint_url,
        "bucket": _current.bucket,
        "public_url": _current.public_url,
        "access_key": _mask(_current.access_key),
    }


def reload_all() -> None:
    """Rebuild every storage-dependent cache. Lazy imports avoid import cycles."""
    from app.storage import minio
    from app.catalog import base_snapshot, overrides
    from app import backgrounds

    minio.reset()
    base_snapshot.restore()       # live catalog dicts -> pristine base library
    overrides.reset_runtime()     # drop in-memory enabled/description/action config
    overrides.apply()             # re-layer the connected bucket's adds/renames/config
    backgrounds.load_manifest.cache_clear()
