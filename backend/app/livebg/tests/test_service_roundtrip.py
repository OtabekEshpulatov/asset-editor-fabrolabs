"""End-to-end backend round-trip for the live-bg object editor, against an in-memory
fake of the S3 layer (no real bucket): seed a bundle, GET the movers, POST an edit,
and assert the video object was re-rendered + overwritten and the spec persisted.

Integration test — needs rlottie-python + ffmpeg (skipped if absent)."""
from __future__ import annotations

import asyncio
import io
import json
import shutil

import pytest
from PIL import Image

pytest.importorskip("rlottie_python")
if not shutil.which("ffmpeg"):
    pytest.skip("ffmpeg not installed", allow_module_level=True)


def _png(color, size=(64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def _green_blob_source() -> bytes:
    im = Image.new("RGB", (64, 64), (0, 255, 0))
    for x in range(20, 44):
        for y in range(20, 44):
            im.putpixel((x, y), (200, 40, 40))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def test_get_then_save_rerenders(monkeypatch):
    from app import videos
    from app.livebg import service
    from app.storage import minio

    store: dict[str, bytes] = {}
    monkeypatch.setattr(minio, "download_bytes", lambda key: store.get(key))
    monkeypatch.setattr(minio, "list_objects", lambda prefix: [k for k in store if k.startswith(prefix)])
    monkeypatch.setattr(minio, "object_exists", lambda key: key in store)
    monkeypatch.setattr(minio, "public_url_for_key", lambda key: f"http://test/{key}")

    def _upload(data, *, key, content_type):
        store[key] = data
        return f"http://test/{key}"

    monkeypatch.setattr(minio, "upload_bytes", _upload)
    # videos.video_key / _video_keys hit the same monkeypatched minio.list_objects.
    videos._video_keys.cache_clear() if hasattr(videos._video_keys, "cache_clear") else None

    slug = "probe_live"
    mp4_key = f"live_backgrounds/forest/{slug}.mp4"
    pref = f"live_backgrounds/forest/{slug}.source/"
    spec = {"name": "probe", "loop_s": 2,
            "movers": [{"id": "blob", "kind": "float", "x": 50, "y": 50, "w": 40, "ax": 4, "tx": 2}]}
    store[mp4_key] = b"SEED-NOT-A-REAL-MP4"
    store[pref + "spec.json"] = json.dumps(spec).encode()
    store[pref + "plate.png"] = _png((80, 120, 160), (1280, 720))
    store[pref + "assets/blob.png"] = _green_blob_source()
    store[pref + "cuts/blob.png"] = _png((0, 0, 0))  # preview presence

    # GET movers
    view = service.get_movers(slug)
    assert view["slug"] == slug
    assert len(view["movers"]) == 1
    m = view["movers"][0]
    assert m["id"] == "blob" and m["positionable"] and m["cutout_url"]

    # POST an edit -> re-render -> overwrite the mp4 + persist the spec
    res = asyncio.run(service.save_movers(slug, [{"index": 0, "x": 15, "y": 80, "w": 48}]))
    assert res["ok"] and res["video_url"].startswith("http://test/") and "?t=" in res["video_url"]

    new_mp4 = store[mp4_key]
    assert new_mp4 != b"SEED-NOT-A-REAL-MP4" and len(new_mp4) > 1000   # a real encoded clip
    assert new_mp4[4:8] == b"ftyp"                                     # mp4 container signature
    saved_spec = json.loads(store[pref + "spec.json"])
    assert saved_spec["movers"][0]["x"] == 15 and saved_spec["movers"][0]["w"] == 48


def test_movers_less_spec_rerenders_plate_only(monkeypatch):
    """A stub spec with no `movers` key (e.g. ocean beach/underwater) must re-render a
    plate-only loop, not crash with KeyError."""
    from app import videos  # noqa: F401
    from app.livebg import service
    from app.storage import minio

    store: dict[str, bytes] = {}
    monkeypatch.setattr(minio, "download_bytes", lambda key: store.get(key))
    monkeypatch.setattr(minio, "list_objects", lambda prefix: [k for k in store if k.startswith(prefix)])
    monkeypatch.setattr(minio, "object_exists", lambda key: key in store)
    monkeypatch.setattr(minio, "public_url_for_key", lambda key: f"http://test/{key}")
    monkeypatch.setattr(minio, "upload_bytes", lambda data, *, key, content_type: store.__setitem__(key, data) or f"http://test/{key}")

    slug = "beachy_live"
    mp4_key = f"live_backgrounds/ocean/{slug}.mp4"
    pref = f"live_backgrounds/ocean/{slug}.source/"
    store[mp4_key] = b"SEED-NOT-A-REAL-MP4"
    store[pref + "spec.json"] = json.dumps({"name": "beachy", "loop_s": 2}).encode()  # NO movers
    store[pref + "plate.png"] = _png((40, 80, 120), (1280, 720))

    assert service.get_movers(slug)["movers"] == []
    res = asyncio.run(service.save_movers(slug, []))
    assert res["ok"]
    assert store[mp4_key] != b"SEED-NOT-A-REAL-MP4" and store[mp4_key][4:8] == b"ftyp"


def test_missing_bundle_is_not_editable(monkeypatch):
    from app import videos  # noqa: F401
    from app.livebg import service
    from app.storage import minio

    store: dict[str, bytes] = {"live_backgrounds/forest/nobundle_live.mp4": b"x"}
    monkeypatch.setattr(minio, "download_bytes", lambda key: store.get(key))
    monkeypatch.setattr(minio, "list_objects", lambda prefix: [k for k in store if k.startswith(prefix)])

    with pytest.raises(service.NotEditable):
        service.get_movers("nobundle_live")
