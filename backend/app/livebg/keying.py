"""Chroma-key helpers: a flat green / magenta backdrop -> alpha. numpy + PIL only.

key_green  — from story-gen-exps scripts/v5_gen_underwater_ambient.py:65-76
key_magenta — from story-gen-exps scripts/v5_livebg.py:203-216 (for green subjects
              like bushes, which a green key would eat).
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageFilter


def key_green(im: Image.Image) -> Image.Image:
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    greenish = (G > 110) & (G - np.maximum(R, B) > 40)
    alpha = np.where(greenish, 0, 255).astype(np.uint8)
    out = a.copy()
    spill = (~greenish) & (G > np.maximum(R, B))
    out[..., 1] = np.where(spill, np.maximum(R, B), G)
    img = Image.fromarray(np.dstack([out.astype(np.uint8), alpha]).astype(np.uint8))
    img.putalpha(img.getchannel("A").filter(ImageFilter.MinFilter(3)))
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img


def key_magenta(im: Image.Image) -> Image.Image:
    """Chroma-key a flat #FF00FF magenta background to alpha (for green subjects)."""
    a = np.asarray(im.convert("RGB")).astype(np.int16)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    mag = (R > 105) & (B > 105) & (np.minimum(R, B) - G > 40)
    alpha = np.where(mag, 0, 255).astype(np.uint8)
    out = a.copy()
    spill = (~mag) & (np.minimum(R, B) - G > 12)          # neutralise pink fringe
    out[..., 0] = np.where(spill, G, R)
    out[..., 2] = np.where(spill, G, B)
    img = Image.fromarray(np.dstack([np.clip(out, 0, 255).astype(np.uint8), alpha]))
    img.putalpha(img.getchannel("A").filter(ImageFilter.MinFilter(3)))
    bbox = img.getchannel("A").getbbox()
    return img.crop(bbox) if bbox else img
