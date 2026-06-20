"""The load-bearing guarantee of the livebg port: re-rendering an existing scene
makes NO LLM / image-gen calls. We synthesise a tiny self-contained bundle, block
any `google`/`openai` import, and assert a fresh mp4 is produced anyway.

Integration test — needs rlottie-python + ffmpeg (skipped if absent)."""
from __future__ import annotations

import builtins
import shutil
import sys

import pytest
from PIL import Image

pytest.importorskip("rlottie_python")
if not shutil.which("ffmpeg"):
    pytest.skip("ffmpeg not installed", allow_module_level=True)


def _make_bundle(tmp_path):
    assets = tmp_path / "assets"
    assets.mkdir()
    # A flat-green source with a red blob -> key_green yields a real cutout.
    src = Image.new("RGB", (64, 64), (0, 255, 0))
    for x in range(20, 44):
        for y in range(20, 44):
            src.putpixel((x, y), (200, 40, 40))
    src.save(assets / "blob.png")
    Image.new("RGB", (1280, 720), (80, 120, 160)).save(tmp_path / "plate.png")
    return {"name": "probe", "loop_s": 2,
            "movers": [{"id": "blob", "kind": "float", "x": 50, "y": 50, "w": 40,
                        "ax": 4, "tx": 2, "ay": 3, "ty": 2}]}


def test_rerender_makes_no_llm_calls(tmp_path, monkeypatch):
    spec = _make_bundle(tmp_path)

    real_import = builtins.__import__

    def guard(name, *args, **kwargs):
        if name.split(".")[0] in ("google", "openai"):
            raise AssertionError(f"re-render must not import {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", guard)

    from app.livebg import render

    out = render.rerender(spec, Image.open(tmp_path / "plate.png"), tmp_path)
    assert out.exists() and out.stat().st_size > 0
    assert "google.genai" not in sys.modules
    assert "openai" not in sys.modules


def test_edit_changes_output(tmp_path, monkeypatch):
    """Moving an object yields a different first frame (edits actually propagate)."""
    import numpy as np

    spec = _make_bundle(tmp_path)
    from app.livebg import render

    def first_frame_rgb(s, wd):
        out = render.rerender(s, Image.open(tmp_path / "plate.png"), wd)
        import subprocess
        png = wd / "f0.png"
        subprocess.run([shutil.which("ffmpeg"), "-y", "-loglevel", "error", "-i", str(out),
                        "-frames:v", "1", str(png)], check=True)
        return np.asarray(Image.open(png).convert("RGB"))

    a_dir = tmp_path / "a"; a_dir.mkdir(); shutil.copytree(tmp_path / "assets", a_dir / "assets"); shutil.copy(tmp_path / "plate.png", a_dir / "plate.png")
    b_dir = tmp_path / "b"; b_dir.mkdir(); shutil.copytree(tmp_path / "assets", b_dir / "assets"); shutil.copy(tmp_path / "plate.png", b_dir / "plate.png")
    f_a = first_frame_rgb(spec, a_dir)
    spec_moved = {**spec, "movers": [{**spec["movers"][0], "x": 15, "y": 80}]}
    f_b = first_frame_rgb(spec_moved, b_dir)
    assert not np.array_equal(f_a, f_b)
