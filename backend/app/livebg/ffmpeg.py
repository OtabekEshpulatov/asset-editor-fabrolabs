"""Resolve the ffmpeg binary. Linux/Docker has it on PATH (apt-get install ffmpeg);
Windows dev can point LIVEBG_FFMPEG at ffmpeg.exe. Replaces story-gen-exps's
Windows-centric backend.engine.render.video.ensure_ffmpeg_on_path."""
from __future__ import annotations

import os
import shutil


def ensure_ffmpeg() -> str:
    exe = os.environ.get("LIVEBG_FFMPEG") or shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError(
            "ffmpeg not found — install it (apt-get install ffmpeg) or set LIVEBG_FFMPEG"
        )
    return exe
