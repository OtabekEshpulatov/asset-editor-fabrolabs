"""Living-background OBJECT editor — re-render an existing live-bg video after the
user drags its moving objects, fully self-contained (no LLM / image-gen).

Ported from story-gen-exps (scripts/v5_livebg.py + scripts/v5_build_ambient_lottie.py
+ backend/video/lottie.py). Re-rendering an EXISTING scene reuses the cached plate +
cutout source PNGs shipped in the per-scene bundle, so it only does:
    re-key/resize (PIL) -> spec_to_layers -> write_overlay (Lottie) -> ffmpeg + rlottie.
No Gemini/GPT calls, no API keys. This package must NOT import app.routes / app.main
(only app.storage.minio / app.videos / app.config) to stay import-cycle free.
"""
