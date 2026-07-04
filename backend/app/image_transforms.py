"""Destructive image transforms (flip / rotate) baked into the asset files.

Editor operations that overwrite the source bytes in storage so the new
orientation becomes canonical (the user asked to "rotate my files any way I want
and save them"). Three flavours:

* ``transform_png`` / ``transform_svg`` — whole-image, for objects & backgrounds.
  Rotation uses ``expand`` so corners are never clipped.
* ``transform_spritesheet`` — per *frame*, for character sprite sheets. Uses the
  atlas frame rectangles (falling back to a 512px grid) so frame order and the
  atlas layout are preserved — a whole-sheet flip would reverse frame order.

Rotation is **clockwise-positive degrees**, matching the CSS ``rotate()`` the UI
previews with. PIL rotates counter-clockwise, so we negate.
"""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET
from io import BytesIO

from PIL import Image

FRAME = 512  # sprite-sheet cell size (matches the compositor's grid heuristic)
_SVG_NS = "http://www.w3.org/2000/svg"


def _norm_deg(deg: float) -> float:
    try:
        return float(deg) % 360.0
    except (TypeError, ValueError):
        return 0.0


def is_noop(*, flip_h: bool, flip_v: bool, rotate: float) -> bool:
    return not flip_h and not flip_v and _norm_deg(rotate) == 0.0


# --- raster ----------------------------------------------------------------

def _apply_cell(img: Image.Image, *, flip_h: bool, flip_v: bool, rotate: float,
                expand: bool) -> Image.Image:
    """Flip then rotate (matches CSS ``rotate() scale()`` right-to-left order)."""
    out = img
    if flip_h:
        out = out.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if flip_v:
        out = out.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    deg = _norm_deg(rotate)
    if deg:
        out = out.rotate(-deg, resample=Image.Resampling.BICUBIC, expand=expand)
    return out


def transform_png(data: bytes, *, flip_h: bool, flip_v: bool, rotate: float) -> bytes:
    """Whole-image transform for a standalone raster (object/background)."""
    img = Image.open(BytesIO(data)).convert("RGBA")
    out = _apply_cell(img, flip_h=flip_h, flip_v=flip_v, rotate=rotate, expand=True)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def _transform_grid(img: Image.Image, *, flip_h: bool, flip_v: bool, rotate: float) -> Image.Image:
    """Per-cell transform using the 512px grid heuristic (no atlas)."""
    w, h = img.size
    fs = FRAME if (w >= FRAME and w % FRAME == 0) else (min(w, h) or FRAME)
    cols = max(1, w // fs)
    rows = max(1, h // fs)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for r in range(rows):
        for c in range(cols):
            x, y = c * fs, r * fs
            cell = img.crop((x, y, x + fs, y + fs))
            cell = _apply_cell(cell, flip_h=flip_h, flip_v=flip_v, rotate=rotate, expand=False)
            out.paste(cell, (x, y))
    return out


def remove_frames(
    sheet: bytes, atlas: bytes | None, *, frame_count: int, remove: list[int]
) -> tuple[bytes, bytes | None, int]:
    """Delete specific frames from a sprite sheet, repacking the survivors into a
    single dense row of the same cell size as the source — never a partial grid,
    since every preview in this app (SpriteCanvas et al.) infers frame count from
    image dimensions alone (`cols * rows`), not `frame_count`; a partially-filled
    last row would flash a blank frame on every loop. If an atlas with a `frames`
    map was supplied, it's regenerated from scratch against the new layout
    (string-index keys `"0"..str(new_count-1)`); any custom frame names are not
    preserved, matching how every other sprite in this app is addressed (grid
    position, not atlas key). Returns (new_sheet_png, new_atlas_json_or_None,
    new_frame_count).
    """
    img = Image.open(BytesIO(sheet)).convert("RGBA")
    w, h = img.size
    fs = FRAME if (w >= FRAME and w % FRAME == 0) else (min(w, h) or FRAME)
    cols = max(1, w // fs)
    rows = max(1, h // fs)
    capacity = cols * rows
    fc = max(1, min(int(frame_count), capacity))

    drop = {i for i in remove if 0 <= i < fc}
    if not drop:
        raise ValueError("no valid frame indices to remove")
    keep = [i for i in range(fc) if i not in drop]
    if not keep:
        raise ValueError("cannot remove every frame")

    out = Image.new("RGBA", (len(keep) * fs, fs), (0, 0, 0, 0))
    frames_meta: dict[str, dict] = {}
    for new_i, old_i in enumerate(keep):
        ox, oy = (old_i % cols) * fs, (old_i // cols) * fs
        nx = new_i * fs
        out.paste(img.crop((ox, oy, ox + fs, oy + fs)), (nx, 0))
        frames_meta[str(new_i)] = {"x": nx, "y": 0, "w": fs, "h": fs}

    buf = BytesIO()
    out.save(buf, format="PNG")

    new_atlas: bytes | None = None
    if atlas:
        try:
            meta = json.loads(atlas)
        except (ValueError, TypeError):
            meta = None
        if isinstance(meta, dict) and "frames" in meta:
            new_atlas = json.dumps({**meta, "frames": frames_meta}).encode("utf-8")

    return buf.getvalue(), new_atlas, len(keep)


def transform_spritesheet(sheet: bytes, atlas: bytes | None, *, flip_h: bool,
                          flip_v: bool, rotate: float) -> bytes:
    """Per-frame transform that keeps the grid/atlas layout intact.

    Each atlas frame rectangle is transformed in place (canvas size unchanged), so
    the atlas keeps lining up. With no atlas, falls back to the 512px grid.
    """
    img = Image.open(BytesIO(sheet)).convert("RGBA")
    meta = {}
    if atlas:
        try:
            meta = json.loads(atlas) if isinstance(atlas, (bytes, str)) else atlas
        except (ValueError, TypeError):
            meta = {}
    frames = (meta or {}).get("frames") or {}
    if not frames:
        out = _transform_grid(img, flip_h=flip_h, flip_v=flip_v, rotate=rotate)
    else:
        out = img.copy()
        for fr in frames.values():
            box = (fr["x"], fr["y"], fr["x"] + fr["w"], fr["y"] + fr["h"])
            cell = img.crop(box)
            cell = _apply_cell(cell, flip_h=flip_h, flip_v=flip_v, rotate=rotate, expand=False)
            out.paste(cell, box)
    buf = BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


# --- vector (SVG) ----------------------------------------------------------

def _svg_len(value: str | None) -> float | None:
    if not value:
        return None
    num = ""
    for ch in value.strip():
        if ch.isdigit() or ch in ".-":
            num += ch
        else:
            break
    try:
        return float(num) if num else None
    except ValueError:
        return None


def _svg_viewbox(root: ET.Element) -> tuple[float, float, float, float] | None:
    vb = root.get("viewBox")
    if vb:
        try:
            parts = [float(x) for x in vb.replace(",", " ").split()]
        except ValueError:
            parts = []
        if len(parts) == 4 and parts[2] > 0 and parts[3] > 0:
            return parts[0], parts[1], parts[2], parts[3]
    w = _svg_len(root.get("width"))
    h = _svg_len(root.get("height"))
    if w and h:
        return 0.0, 0.0, w, h
    return None


def transform_svg(data: bytes, *, flip_h: bool, flip_v: bool, rotate: float) -> bytes:
    """Loss-less SVG transform: wrap content in a transformed <g>, expand the
    viewBox to the rotated bounding box so nothing is clipped."""
    ET.register_namespace("", _SVG_NS)
    try:
        root = ET.fromstring(data)
    except ET.ParseError as exc:
        raise ValueError(f"could not parse SVG: {exc}") from exc

    box = _svg_viewbox(root)
    if box is None:
        raise ValueError("SVG has no viewBox or numeric width/height — cannot transform")
    minx, miny, w, h = box
    cx, cy = minx + w / 2.0, miny + h / 2.0
    deg = _norm_deg(rotate)

    parts: list[str] = []
    if deg:
        parts.append(f"rotate({deg} {cx} {cy})")
    if flip_h or flip_v:
        sx = -1 if flip_h else 1
        sy = -1 if flip_v else 1
        parts.append(f"translate({cx} {cy}) scale({sx} {sy}) translate({-cx} {-cy})")
    if not parts:
        return data

    group = ET.Element(f"{{{_SVG_NS}}}g", {"transform": " ".join(parts)})
    for child in list(root):
        root.remove(child)
        group.append(child)
    root.append(group)

    if deg:
        rad = math.radians(deg)
        cos, sin = math.cos(rad), math.sin(rad)
        corners = [(minx, miny), (minx + w, miny), (minx + w, miny + h), (minx, miny + h)]
        xs, ys = [], []
        for px, py in corners:
            dx, dy = px - cx, py - cy
            xs.append(cx + dx * cos - dy * sin)
            ys.append(cy + dx * sin + dy * cos)
        nminx, nminy = min(xs), min(ys)
        nw, nh = max(xs) - nminx, max(ys) - nminy
        root.set("viewBox", f"{nminx:g} {nminy:g} {nw:g} {nh:g}")
        if root.get("width") is not None:
            root.set("width", f"{nw:g}")
        if root.get("height") is not None:
            root.set("height", f"{nh:g}")

    return ET.tostring(root, encoding="utf-8", xml_declaration=True)
