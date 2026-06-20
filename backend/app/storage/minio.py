"""MinIO (S3-compatible) helpers.

Credentials come from the UI-driven `app.connection` store, not the environment.
The boto3 clients are lru-cached and rebuilt (via `reset()`) whenever the active
connection changes.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import (
    ClientError,
    ConnectionClosedError,
    EndpointConnectionError,
    ReadTimeoutError,
)

from app import connection

log = logging.getLogger(__name__)

# Errors that are likely transient and worth retrying.
_TRANSIENT_S3_ERRORS = (EndpointConnectionError, ConnectionClosedError, ReadTimeoutError)


def _with_s3_retries(fn, *, max_attempts: int = 4, backoff_initial_s: float = 1.0):
    """Run a 0-arg callable with exponential backoff on transient S3/MinIO errors.

    Backoff: 1s, 2s, 4s. Catches connection errors plus 5xx ClientError responses.
    Does NOT retry on 4xx (auth, not-found, etc.).
    """
    last: Exception | None = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except _TRANSIENT_S3_ERRORS as e:
            last = e
        except ClientError as e:
            code = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
            if 500 <= code < 600:
                last = e
            else:
                raise  # 4xx — not retryable
        if attempt == max_attempts - 1:
            break
        sleep_s = backoff_initial_s * (2 ** attempt)
        log.warning("S3/MinIO transient error attempt=%d sleeping=%.1fs err=%r", attempt + 1, sleep_s, last)
        time.sleep(sleep_s)
    assert last is not None
    raise last


def _bucket() -> str:
    return connection.require().bucket


@lru_cache(maxsize=1)
def get_s3_client():
    c = connection.require()
    return boto3.client(
        "s3",
        endpoint_url=c.endpoint_url or None,
        aws_access_key_id=c.access_key,
        aws_secret_access_key=c.secret_key,
        # Path-style so a path-prefixed endpoint and MinIO both work.
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        region_name="us-east-1",
    )


@lru_cache(maxsize=1)
def _get_s3_client_fast():
    """Short-timeout, no-retry client for small metadata reads (manifest/overrides)."""
    c = connection.require()
    return boto3.client(
        "s3",
        endpoint_url=c.endpoint_url or None,
        aws_access_key_id=c.access_key,
        aws_secret_access_key=c.secret_key,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            connect_timeout=3,
            read_timeout=5,
            retries={"max_attempts": 1},
        ),
        region_name="us-east-1",
    )


def reset() -> None:
    """Drop cached clients so the next call rebuilds with the active connection."""
    get_s3_client.cache_clear()
    _get_s3_client_fast.cache_clear()


def download_bytes(key: str) -> bytes | None:
    """Fetch an object's bytes, or None if it does not exist (404/403).

    Raises on connection failure so callers can distinguish "absent" from
    "unreachable" and fall back accordingly.
    """
    try:
        resp = _get_s3_client_fast().get_object(Bucket=_bucket(), Key=key)
        return resp["Body"].read()
    except ClientError as exc:
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        if code in (403, 404):
            return None
        raise


def stream_object(key: str, *, byte_range: str | None = None):
    """Return a dict describing the object stream for the storage proxy, or None
    if it does not exist.

    Pass an HTTP ``Range`` header value (e.g. ``"bytes=0-1023"``) to fetch a
    partial object — required for <video> seeking/streaming of large mp4s. When a
    range is served, ``content_range`` is set and the caller should reply 206.
    """
    kwargs: dict = {"Bucket": _bucket(), "Key": key}
    if byte_range:
        kwargs["Range"] = byte_range
    try:
        resp = get_s3_client().get_object(**kwargs)
    except ClientError as exc:
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        if code in (403, 404):
            return None
        raise
    return {
        "body": resp["Body"],
        "content_type": resp.get("ContentType") or "application/octet-stream",
        "content_length": resp.get("ContentLength"),
        "content_range": resp.get("ContentRange"),  # set only when Range was honored
    }


def list_objects(prefix: str) -> list[str]:
    """List all object keys under `prefix` in the bucket (paginated)."""
    keys: list[str] = []
    paginator = get_s3_client().get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=_bucket(), Prefix=prefix):
        for obj in page.get("Contents", []):
            keys.append(obj["Key"])
    return keys


def upload_bytes(data: bytes, *, key: str, content_type: str) -> str:
    _with_s3_retries(lambda: get_s3_client().put_object(
        Bucket=_bucket(), Key=key, Body=data, ContentType=content_type,
    ))
    log.debug("uploaded key=%s ct=%s bytes=%d", key, content_type, len(data))
    return public_url_for_key(key)


def copy_object(src_key: str, dst_key: str) -> str:
    """Server-side copy within the bucket (no data round-trips through the app)."""
    bucket = _bucket()
    _with_s3_retries(lambda: get_s3_client().copy_object(
        Bucket=bucket, Key=dst_key, CopySource={"Bucket": bucket, "Key": src_key},
    ))
    log.debug("copied key=%s -> %s", src_key, dst_key)
    return public_url_for_key(dst_key)


def delete_object(key: str) -> None:
    _with_s3_retries(lambda: get_s3_client().delete_object(Bucket=_bucket(), Key=key))
    log.debug("deleted key=%s", key)


def delete_prefix(prefix: str) -> int:
    """Delete every object under `prefix`. Returns the count actually removed.

    Per-object failures are logged and skipped (best-effort cleanup).
    """
    removed = 0
    for key in list_objects(prefix):
        try:
            delete_object(key)
            removed += 1
        except Exception as exc:
            log.warning("delete_prefix: failed to delete %s: %r", key, exc)
    return removed


def object_exists(key: str) -> bool:
    """Return True if an object already lives at `key` in the bucket."""
    try:
        _with_s3_retries(lambda: get_s3_client().head_object(Bucket=_bucket(), Key=key))
        return True
    except ClientError as exc:
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        if code in (404, 403):
            return False
        raise


def public_url_for_key(key: str) -> str:
    c = connection.require()
    base = c.with_public_url()
    return f"{base}/{c.bucket}/{key}"


def _is_storage_endpoint_failure(exc: Exception) -> bool:
    if isinstance(exc, _TRANSIENT_S3_ERRORS):
        return True
    if isinstance(exc, ClientError):
        code = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        return 500 <= code < 600
    return False
