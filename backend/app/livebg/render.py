"""LLM-free re-render of a living-background video.

Adapted from story-gen-exps scripts/v5_livebg.py — the RENDER path only. The first
-generation code (Gemini/GPT plate + cutout synthesis, ref download, decloud) is
dropped; instead the cached plate + green/magenta cutout SOURCE PNGs are supplied in
a per-scene bundle (see app.livebg.bundle). So this module imports neither google-genai
nor openai and needs no API key — it only does PIL keying/resize, Lottie baking
(app.livebg.ambient_lottie) and rlottie+ffmpeg compositing (app.livebg.lottie/ffmpeg).

`rerender(spec, plate_img, workdir)` is the entry point: `workdir/assets/{id}.png`
holds the cutout sources, the result mp4 is written to `workdir/{name}_live.mp4`.
"""
from __future__ import annotations

import itertools
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .ambient_lottie import (
    Float,
    Patrol,
    Peek,
    Pulse,
    Snow,
    Strip,
    Swim,
    write_overlay,
)
from .ffmpeg import ensure_ffmpeg
from .keying import key_green, key_magenta
from .lottie import lottie_frame_count, render_lottie_frame

W, H, FPS = 1280, 720, 24

# rlottie parses + caches an animation by cache_key in a PROCESS-GLOBAL LRU. In the
# long-lived server the same slug is re-rendered after every edit, so a fixed key
# would replay the STALE overlay. A fresh key per render() call makes the parse
# reflect this call's overlay (still cached across the call's own frames).
_RENDER_SEQ = itertools.count(1)


# --------------------------- cutout sources -------------------------------- #
def _read_source(assets_dir: Path, asset_id: str) -> Image.Image:
    """A flat green/magenta cutout SOURCE shipped in the bundle. Never synthesised —
    a missing source is a hard error (we must NOT silently fall through to a model)."""
    p = Path(assets_dir) / f"{asset_id}.png"
    if not p.exists():
        raise FileNotFoundError(f"bundle missing cutout source {asset_id!r} ({p})")
    return Image.open(p).convert("RGB")


def cutout(assets_dir: Path, cuts_dir: Path, asset_id: str, target_w: int, *, haze: bool = False) -> str:
    """Green-key a bundled source, optionally hazify, resize to target width."""
    im = key_green(_read_source(assets_dir, asset_id))
    if haze:
        a = im.getchannel("A")
        im = Image.blend(im.convert("RGB"), Image.new("RGB", im.size, (120, 165, 195)), 0.55).convert("RGBA")
        im.putalpha(a)
        im = im.filter(ImageFilter.GaussianBlur(1.5))
        im.putalpha(im.getchannel("A").point(lambda v: int(v * 0.45)))
    s = target_w / im.width
    im = im.resize((int(target_w), max(1, round(im.height * s))), Image.Resampling.LANCZOS)
    out = Path(cuts_dir) / f"cut_{asset_id}{'_h' if haze else ''}_{target_w}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    return str(out)


def bush_cutout(assets_dir: Path, cuts_dir: Path, bush_id: str, target_w: int) -> str:
    """A foreground bush cutout (green subject -> magenta source + magenta key)."""
    im = key_magenta(_read_source(assets_dir, bush_id))
    s = target_w / im.width
    im = im.resize((int(target_w), max(1, round(im.height * s))), Image.Resampling.LANCZOS)
    out = Path(cuts_dir) / f"cut_{bush_id}_{target_w}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    return str(out)


def flip(path: str) -> str:
    out = Path(path).with_name(Path(path).stem + "_L.png")
    Image.open(path).transpose(Image.Transpose.FLIP_LEFT_RIGHT).save(out)
    return str(out)


# --------------------------- procedural particles -------------------------- #
def bubbles_png(cuts_dir: Path) -> str:
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i in range(46):
        x = (i * 277 + 60) % (W - 40) + 20
        y = (i * 163 + 90) % (H - 80) + 40
        r = 3 + (i * 7) % 6
        d.ellipse([x - r, y - r, x + r, y + r], outline=(255, 255, 255, 130), width=2)
        d.ellipse([x - r + 1, y - r + 1, x - r + 3, y - r + 3], fill=(255, 255, 255, 160))
    out = Path(cuts_dir) / "bubbles.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    return str(out)


def snow_dot_png(cuts_dir: Path, rgb=(255, 255, 255)) -> str:
    """A single tiny soft round dot — the particle for the Snow (falling) primitive."""
    s = 16
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for r, a in [(7, 55), (5, 130), (3, 205), (2, 255)]:        # soft concentric falloff
        d.ellipse([s / 2 - r, s / 2 - r, s / 2 + r, s / 2 + r], fill=(rgb[0], rgb[1], rgb[2], a))
    out = Path(cuts_dir) / f"snowdot_{rgb[0]}_{rgb[1]}_{rgb[2]}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    im.save(out)
    return str(out)


# ------------------------------- water FX ---------------------------------- #
def sea_mask(base: Image.Image, y0f: float = 0.40, y1f: float = 0.64) -> np.ndarray:
    a = np.asarray(base.convert("RGB")).astype(int)
    h, w = a.shape[:2]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    band = np.zeros((h, w), bool)
    band[int(y0f * h):int(y1f * h), :] = True
    return band & (G > R + 8) & (B > R + 4) & (G < 235) & (B < 240)


def water_ripple(base: Image.Image, t: int, op: int, mask: np.ndarray) -> Image.Image:
    arr = np.asarray(base)
    h, w = arr.shape[:2]
    yy = np.arange(h)
    dx = (3.5 * np.sin(2 * np.pi * yy / 130.0 + 2 * np.pi * 4 * (t / op))).astype(int)
    xs = np.clip(np.arange(w)[None, :] - dx[:, None], 0, w - 1)
    warped = arr[np.arange(h)[:, None], xs]
    return Image.fromarray(np.where(mask[..., None], warped, arr).astype(np.uint8), "RGBA")


def warp_rgba(img: Image.Image, t: int, op: int, amp: float = 4.5) -> Image.Image:
    """Gentle underwater shimmer: shift each row horizontally by a slow travelling sine."""
    arr = np.asarray(img)
    h, w = arr.shape[:2]
    yy = np.arange(h)
    bias = 1.0 - 0.55 * (yy / h)
    dx = (amp * bias * np.sin(2 * np.pi * yy / 230.0 + 2 * np.pi * (t / op))).astype(int)
    xs = np.clip(np.arange(w)[None, :] - dx[:, None], 0, w - 1)
    return Image.fromarray(arr[np.arange(h)[:, None], xs], "RGBA")


# --------------------------------------------------------------------------- #
def spec_to_layers(spec: dict, assets_dir: Path, cuts_dir: Path) -> list:
    """Map the spec's movers to ambient_lottie layer primitives. All cutout SOURCES
    are read flat from `assets_dir/{id}.png` (the bundle flattens the SOURCE namespace —
    no `shared` vs per-world split — so a source can never go missing)."""
    layers: list = []
    fg: list = []                       # foreground bushes — drawn ON TOP (prepended)
    for m in spec.get("movers", []):    # movers-less stub specs (e.g. ocean) -> plate-only loop
        kind = m["kind"]
        if kind == "bubbles":
            layers.append(Strip(bubbles_png(cuts_dir), axis="y", tiles_per_loop=m.get("tiles", 1), to_negative=True, name=m["id"]))
            continue
        if kind == "fall":          # gentle falling snow / sugar — INDEPENDENT particles
            layers.append(Snow(snow_dot_png(cuts_dir, tuple(m.get("color", [255, 255, 255]))),
                               count=m.get("count", 30), drift_pct=m.get("drift", 1.3), name=m["id"]))
            continue
        if kind == "pulse":         # a stationary cutout whose opacity twinkles
            pp = cutout(assets_dir, cuts_dir, m["id"], m.get("w", 40))
            layers.append(Pulse(pp, m["x"], m["y"], scale=m.get("scale", 1.0), period_s=m.get("period", 3.0),
                                phase=m.get("phase", 0), base_op=m.get("base_op", 0.25), max_op=m.get("max_op", 1.0), name=m["id"]))
            continue
        path = cutout(assets_dir, cuts_dir, m["id"], m.get("w", 80), haze=m.get("haze", False))
        if kind == "float":
            fp = flip(path) if m.get("flip") else path        # face into the scene
            layers.append(Float(fp, m["x"], m["y"], scale=m.get("scale", 1.0),
                                ax_pct=m.get("ax", 2), tx_s=m.get("tx", spec.get("loop_s", 24)), phx=m.get("phx", 0),
                                ay_pct=m.get("ay", 1), ty_s=m.get("ty", spec.get("loop_s", 24)), phy=m.get("phy", 0), name=m["id"]))
        elif kind == "swim":
            p = flip(path) if m.get("to_left") else path
            layers.append(Swim(p, m["y"], scale=m.get("scale", 1.0), to_left=m.get("to_left", False),
                               start_frac=m.get("start", 0.0), dur_frac=m.get("dur", 0.5),
                               ay_pct=m.get("ay", 2.5), ty_s=m.get("ty", 6), phy=m.get("phy", 0),
                               x0_pct=m.get("x0"), x1_pct=m.get("x1"), name=m["id"]))
        elif kind == "patrol":
            pr = cutout(assets_dir, cuts_dir, m["id"], m.get("w", 90))
            layers.append(Patrol(pr, flip(pr), m["x"], m["y"], ax_pct=m.get("ax", 6), period_s=m.get("period", 14),
                                 phase=m.get("phase", 0), scale=m.get("scale", 1.0),
                                 ay_pct=m.get("ay", 0), ty_s=m.get("ty", 9), phy=m.get("phy", 0), name=m["id"]))
        elif kind == "peek":
            pk = flip(path) if m.get("flip") else path        # face into the scene (right-corner peeks)
            layers.append(Peek(pk, m["x"], m["y"], scale=m.get("scale", 1.0),
                               rise_pct=m.get("rise", 7), starts=m.get("starts", [0.25]),
                               hold_s=m.get("hold", 1.6), rise_s=m.get("rise_s", 0.5), name=m["id"]))
            if m.get("bush"):
                bp = bush_cutout(assets_dir, cuts_dir, m["bush"], m.get("bush_w", 210))
                fg.append(Float(bp, m.get("bush_x", m["x"]), m.get("bush_y", m["y"] + 6), name=m["bush"]))
    return fg + layers


def render(name: str, base: Image.Image, overlay_path: Path, out_dir: Path, plate_fx=None) -> Path:
    data = Path(overlay_path).read_bytes()
    key = f"{name}-{next(_RENDER_SEQ)}"   # unique per call — never replay a stale parse
    total = lottie_frame_count(data, cache_key=key)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{name}_live.mp4"
    exe = ensure_ffmpeg()
    ff = subprocess.Popen(
        [exe, "-y", "-loglevel", "error", "-f", "rawvideo", "-pixel_format", "rgb24",
         "-video_size", f"{W}x{H}", "-framerate", str(FPS), "-i", "-",
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-preset", "veryfast", str(out)],
        stdin=subprocess.PIPE,
    )
    for f in range(total):
        comp = plate_fx(base, f, total) if plate_fx else base.copy()
        comp.alpha_composite(render_lottie_frame(data, f, (W, H), cache_key=key))
        ff.stdin.write(comp.convert("RGB").tobytes())
    ff.stdin.close()
    ff.wait()
    if ff.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {name} (exit {ff.returncode})")
    return out


def rerender(spec: dict, plate_img: Image.Image, workdir: Path) -> Path:
    """Re-bake the Lottie overlay from `spec` over the (already cached) plate and render
    a fresh loop. Zero LLM/image-gen calls. `workdir/assets/{id}.png` holds the cutout
    sources; the mp4 is written to `workdir/{name}_live.mp4`."""
    workdir = Path(workdir)
    assets_dir = workdir / "assets"
    cuts_dir = workdir / "cuts"
    cuts_dir.mkdir(parents=True, exist_ok=True)
    name = spec["name"]
    base = plate_img.resize((W, H), Image.Resampling.LANCZOS).convert("RGBA")
    layers = spec_to_layers(spec, assets_dir, cuts_dir)
    overlay = workdir / "overlay.json"
    write_overlay(layers, overlay, w=W, h=H, fps=FPS, loop_s=spec.get("loop_s", 24.0), kf_stride=2)
    fx = None
    water = spec.get("water")
    if water == "ripple":
        wm = spec.get("water_mask")
        if wm and Path(wm).exists():
            mk = np.asarray(Image.open(wm).convert("L").resize((W, H))) > 110
        else:
            wb = spec.get("water_band", [0.40, 0.64])
            mk = sea_mask(base, wb[0], wb[1])
        fx = lambda b, f, tot: water_ripple(b, f, tot, mk)  # noqa: E731
    elif water == "warp":
        fx = warp_rgba
    return render(name, base, overlay, out_dir=workdir, plate_fx=fx)
