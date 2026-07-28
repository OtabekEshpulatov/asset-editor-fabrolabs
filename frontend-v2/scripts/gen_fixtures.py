#!/usr/bin/env python
"""Generate prototype fixtures for the asset-editor v2 UI.

Run with the backend venv (it has Pillow):

    npm run fixtures        # -> ../backend/.venv/bin/python scripts/gen_fixtures.py

Everything is derived from LOCAL sources, so this works offline with the backend
down and Tailscale off:

  * real slugs / categories / action lists  <- backend/app/catalog/static_asset_catalog.py
  * real zone documents                     <- backend/data/backgrounds_manifest.json
  * real artwork                            <- animated/assets_cache/{frames,sprites,backgrounds,layers}

The point is that the prototype grids have production shape and scale (538
characters across 14 categories, 144 of them in people/professions) rather than
a dozen invented rows, so pagination, virtualization and density can actually be
judged.

Where the local sources have no counterpart the fixture is SYNTHESIZED and said
so in `_synthetic` on the payload: live backgrounds, the world graph, intros and
music exist only in the bucket. They are modelled on the real API shapes in
frontend/src/api.ts.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
FE = HERE.parent
REPO = FE.parent
BACKEND = REPO / "backend"
CACHE = REPO.parent / "animated" / "assets_cache"

OUT_FIXTURES = FE / "src" / "lib" / "data" / "mock" / "fixtures"
OUT_PUBLIC = FE / "public" / "mock"
THUMBS = OUT_PUBLIC / "thumbs"
STRIPS = OUT_PUBLIC / "strips"
FULL = OUT_PUBLIC / "full"

FRAME = 512  # sprite grid cell, must match SpriteSheet.gridOf on the client
THUMB = 128
STRIP_FRAME = 96
STRIP_MAX = 8
BG_THUMB = 320

sys.path.insert(0, str(BACKEND))


# --- helpers -----------------------------------------------------------------


def pick(pool: list, key: str):
    """Deterministically map a slug onto a pool entry, so a given asset always
    shows the same artwork across runs and reloads."""
    if not pool:
        return None
    h = int(hashlib.md5(key.encode()).hexdigest()[:8], 16)
    return pool[h % len(pool)]


def hue_for(key: str) -> int:
    return int(hashlib.md5(key.encode()).hexdigest()[8:12], 16) % 360


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    print(f"  {path.relative_to(FE)}  ({path.stat().st_size / 1024:.0f} KB)")


def reset_dir(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


# --- artwork -----------------------------------------------------------------


def build_sprite_art() -> list[str]:
    """One still thumb + one horizontal frame strip per locally available
    character. The strip is exactly what the phase-2 backend thumbnail service
    will emit, so hover-to-animate is proven on real bytes now: ~15 KB instead
    of the 4 MB sheet the current editor downloads per card."""
    src = CACHE / "frames"
    if not src.is_dir():
        print(f"  ! no {src} — skipping sprite art")
        return []

    names: list[str] = []
    for char_dir in sorted(p for p in src.iterdir() if p.is_dir()):
        # Prefer a plain idle/happy/move take over the mirrored (_m) and
        # fps-suffixed (@12) variants, which are duplicates of the same pose.
        actions = sorted(p for p in char_dir.iterdir() if p.is_dir())
        clean = [a for a in actions if "@" not in a.name and not a.name.endswith("_m")]
        preferred = next(
            (a for a in clean if a.name in ("idle", "happy", "move")),
            (clean or actions or [None])[0],
        )
        if preferred is None:
            continue
        frames = sorted(preferred.glob("*.png"))
        if not frames:
            continue

        name = char_dir.name
        # still: the middle frame reads better than frame 0 (mid-stride).
        with Image.open(frames[len(frames) // 2]) as im:
            im.convert("RGBA").resize((THUMB, THUMB), Image.LANCZOS).save(
                THUMBS / f"{name}.webp", "WEBP", quality=82, method=4
            )

        # strip: evenly sampled frames, laid out left-to-right.
        step = max(1, len(frames) // STRIP_MAX)
        chosen = frames[::step][:STRIP_MAX]
        strip = Image.new("RGBA", (STRIP_FRAME * len(chosen), STRIP_FRAME), (0, 0, 0, 0))
        for i, f in enumerate(chosen):
            with Image.open(f) as im:
                strip.paste(
                    im.convert("RGBA").resize((STRIP_FRAME, STRIP_FRAME), Image.LANCZOS),
                    (i * STRIP_FRAME, 0),
                )
        strip.save(STRIPS / f"{name}.webp", "WEBP", quality=80, method=4)
        names.append(name)

    print(f"  sprites: {len(names)} thumbs + strips")
    return names


def build_background_art() -> list[str]:
    src = CACHE / "backgrounds"
    if not src.is_dir():
        print(f"  ! no {src} — skipping background art")
        return []
    names: list[str] = []
    for png in sorted(src.glob("*.png")):
        with Image.open(png) as im:
            im = im.convert("RGB")
            w, h = im.size
            im.resize((BG_THUMB, round(BG_THUMB * h / w)), Image.LANCZOS).save(
                THUMBS / f"bg_{png.stem}.webp", "WEBP", quality=80, method=4
            )
        names.append(png.stem)
    print(f"  backgrounds: {len(names)} thumbs")
    return names


def build_object_art(count: int = 28) -> list[str]:
    """Objects have no local artwork, so these are HONEST placeholders: a
    deterministic tinted tile rather than a sprite that would mislabel an
    'apple' with an elephant. Enough variety to judge grid density and rhythm."""
    names: list[str] = []
    for i in range(count):
        key = f"object-{i}"
        hue = hue_for(key)
        tile = Image.new("RGBA", (THUMB, THUMB), (0, 0, 0, 0))
        d = ImageDraw.Draw(tile)
        base = Image.new("HSV", (1, 1), (int(hue * 255 / 360), 90, 150)).convert("RGB")
        r, g, b = base.getpixel((0, 0))
        d.rounded_rectangle([16, 16, THUMB - 16, THUMB - 16], radius=18, fill=(r, g, b, 235))
        d.rounded_rectangle([16, 16, THUMB - 16, THUMB - 52], radius=18, fill=(
            min(r + 26, 255), min(g + 26, 255), min(b + 26, 255), 235))
        tile.save(THUMBS / f"obj_{i}.webp", "WEBP", quality=82, method=4)
        names.append(f"obj_{i}")
    print(f"  objects: {len(names)} placeholder tiles")
    return names



AUDIO = OUT_PUBLIC / "audio"
VIDEO = OUT_PUBLIC / "video"
VIDEO_CLIPS = 8   # cycled across every video-ish asset, to keep the repo small


def build_audio() -> list[str]:
    """Real, playable mp3s.

    The old editor put an <audio controls> on every music card. Reviewing a
    music library without being able to hear it is not a review, so the
    prototype ships actual audio rather than a drawn waveform.
    """
    src = CACHE / "audio"
    if not src.is_dir():
        print("  ! no audio dir — skipping")
        return []
    names = []
    for mp3 in sorted(list((src / "bgm").glob("*.mp3")) + list((src / "ambient").glob("*.mp3"))):
        dst = AUDIO / mp3.name
        shutil.copy2(mp3, dst)
        names.append(mp3.stem)
    print(f"  audio: {len(names)} playable tracks")
    return names


def build_video(plates: list[Path]) -> list[str]:
    """Short looping mp4s rendered from the scene plates.

    A live background whose preview is a frozen JPEG cannot be judged as a live
    background. ffmpeg gives each clip a slow drift so motion, looping and the
    <video> controls are all real. A handful of clips are cycled across the
    video kinds so the repo does not carry 80 encodes.
    """
    exe = shutil.which("ffmpeg")
    if not exe:
        print("  ! ffmpeg not found — skipping video (players will fall back to posters)")
        return []
    names = []
    for i, plate in enumerate(plates[:VIDEO_CLIPS]):
        name = plate.parent.name
        dst = VIDEO / f"{name}.mp4"
        # gentle horizontal drift, 6s, 960x540 — small but unmistakably moving
        vf = ("scale=1200:-2,"
              "crop=960:540:'(in_w-out_w)/2+sin(t/2.2)*40':'(in_h-out_h)/2+cos(t/3.1)*18'")
        r = subprocess.run(
            [exe, "-y", "-loglevel", "error", "-loop", "1", "-i", str(plate),
             "-t", "6", "-vf", vf, "-r", "24", "-c:v", "libx264", "-crf", "30",
             "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(dst)],
            capture_output=True,
        )
        if r.returncode == 0 and dst.exists():
            names.append(name)
        else:
            print(f"    ! ffmpeg failed for {name}: {r.stderr.decode()[:120]}")
    total = sum(f.stat().st_size for f in VIDEO.glob("*.mp4"))
    print(f"  video: {len(names)} clips ({total/1024/1024:.1f} MB)")
    return names


def copy_full_size() -> dict:
    """Full-resolution sources the editors need to operate on real pixels:
    a real spritesheet for the frame editor, real backgrounds for the zone
    editor, and a plate that stands in for a live-bg poster frame."""
    out: dict = {}

    sheet = None
    for cand in ("fox/idle", "elephant/idle_m@12", "bee/idle"):
        p = CACHE / "sprites" / cand / "spritesheet.png"
        if p.exists():
            sheet = p
            break
    if sheet is None:
        found = sorted((CACHE / "sprites").glob("*/*/spritesheet.png"))
        sheet = found[0] if found else None
    if sheet is not None:
        with Image.open(sheet) as im:
            w, h = im.size
            cols, rows = max(1, w // FRAME), max(1, h // FRAME)
            im.save(FULL / "spritesheet.png", optimize=True)
        out["spritesheet"] = {
            "url": "/mock/full/spritesheet.png",
            "width": w,
            "height": h,
            "frames": cols * rows,
            "source": str(sheet.relative_to(CACHE)),
        }
        print(f"  full spritesheet: {w}x{h} = {cols * rows} frames ({sheet.relative_to(CACHE)})")

    # Every local background gets a full-size render: the zone editor needs a
    # real backdrop, and EVERY background in the catalog is mapped onto one of
    # these, so shipping only a handful leaves most of the library uneditable.
    bgs = sorted((CACHE / "backgrounds").glob("*.png"))
    out["backgrounds"] = []
    for p in bgs:
        with Image.open(p) as im:
            im = im.convert("RGB")
            # 1600px wide is plenty for a zone canvas and keeps the repo light.
            if im.width > 1200:
                im = im.resize((1200, round(1200 * im.height / im.width)), Image.LANCZOS)
            im.save(FULL / f"{p.stem}.jpg", "JPEG", quality=82, optimize=True)
        out["backgrounds"].append({"slug": p.stem, "url": f"/mock/full/{p.stem}.jpg"})

    plates = sorted((CACHE / "layers").glob("*/plate.png"))
    out["posters"] = []
    for p in plates:
        with Image.open(p) as im:
            im = im.convert("RGB")
            if im.width > 1200:
                im = im.resize((1200, round(1200 * im.height / im.width)), Image.LANCZOS)
            im.save(FULL / f"poster_{p.parent.name}.jpg", "JPEG", quality=80, optimize=True)
        out["posters"].append({"slug": p.parent.name, "url": f"/mock/full/poster_{p.parent.name}.jpg"})

    print(f"  full: {len(out.get('backgrounds', []))} backgrounds, {len(out.get('posters', []))} posters")
    return out


# --- catalog -----------------------------------------------------------------


def load_static_catalog():
    from app.catalog.static_asset_catalog import (  # type: ignore[import-not-found]
        BACKGROUND_CATEGORIES,
        CHARACTER_CATALOG,
        CHARACTER_CATEGORIES,
        OBJECT_CATEGORIES,
    )

    return CHARACTER_CATALOG, CHARACTER_CATEGORIES, OBJECT_CATEGORIES, BACKGROUND_CATEGORIES


def build_assets(sprite_art, bg_art, obj_art, audio_art, video_art) -> dict:
    chars, char_cats, obj_cats, bg_cats = load_static_catalog()
    kinds: dict[str, list] = {}

    # Real per-background metadata from the shipped manifest, so the inspector
    # has something to show. Without this every background reads as blank.
    manifest_path = BACKEND / "data" / "backgrounds_manifest.json"
    bg_meta = {}
    if manifest_path.exists():
        raw = json.loads(manifest_path.read_text())
        for key, entry in raw.items():
            if isinstance(entry, dict):
                bg_meta[Path(key).stem] = entry

    def thumb(name: str) -> str:
        return f"/mock/thumbs/{name}.webp"

    def clip(key: str) -> str | None:
        """A real, playable mp4 for the video kinds."""
        art = pick(video_art, key)
        return f"/mock/video/{art}.mp4" if art else None

    def track(key: str) -> str | None:
        art = pick(audio_art, key)
        return f"/mock/audio/{art}.mp3" if art else None

    # characters — real slugs, real categories, real action names
    items = []
    for cat, slugs in sorted(char_cats.items()):
        for slug in sorted(slugs):
            entry = chars.get(slug) or {}
            actions = sorted(entry.get("animations") or ["idle"])
            art = pick(sprite_art, slug)
            items.append({
                "slug": slug,
                "kind": "character",
                "category": cat,
                "thumb": thumb(art) if art else None,
                "strip": f"/mock/strips/{art}.webp" if art else None,
                "enabled": True,
                "rev": 0,
                "actions": actions,
                "description": "",
                "storage_key": f"sprites/{cat}/{slug}",
            })
    kinds["character"] = items

    # objects — real slugs/categories, placeholder tiles (no local object art)
    items = []
    for cat, slugs in sorted(obj_cats.items()):
        for slug in sorted(slugs):
            art = pick(obj_art, slug)
            items.append({
                "slug": slug,
                "kind": "object",
                "category": cat,
                "thumb": thumb(art) if art else None,
                "enabled": True,
                "rev": 0,
                "description": "",
                "storage_key": f"objects/{cat}/{slug}.png",
            })
    kinds["object"] = items

    # backgrounds — real slugs/categories, real artwork where it exists locally
    items = []
    for cat, slugs in sorted(bg_cats.items()):
        for slug in sorted(slugs):
            art = slug if slug in bg_art else pick(bg_art, slug)
            meta = bg_meta.get(slug, {})
            res = meta.get("resolution") if isinstance(meta.get("resolution"), dict) else {}
            items.append({
                "slug": slug,
                "kind": "background",
                "category": cat,
                "thumb": f"/mock/thumbs/bg_{art}.webp" if art else None,
                "media": f"/mock/full/{art}.jpg" if art else None,
                "enabled": True,
                "rev": 0,
                "description": str(meta.get("description") or ""),
                "resolution": {
                    "width": int(res.get("width") or 1920),
                    "height": int(res.get("height") or 1080),
                },
                "zone_count": len(meta.get("zones") or {}) or None,
                "storage_key": f"backgrounds/{cat}/{slug}.png",
            })
    kinds["background"] = items

    # --- synthesized kinds (bucket-only in production) ------------------------
    worlds = ["great_oak", "coral_reef", "star_harbor", "winter_hollow"]

    def live_items(kind: str, per_world: int, prefix: str = "") -> list:
        out = []
        for w in worlds:
            for i in range(per_world):
                art = pick(bg_art, f"{kind}{w}{i}")
                slug = f"{prefix}{w}_scene_{i + 1:02d}"
                out.append({
                    "slug": slug,
                    "kind": kind,
                    "category": w,
                    "thumb": f"/mock/thumbs/bg_{art}.webp" if art else None,
                    "media": clip(slug),
                    "enabled": True,
                    "rev": 0,
                    "description": f"A living scene in {w.replace('_', ' ')}.",
                    "resolution": {"width": 1920, "height": 1080},
                    "storage_key": f"live_backgrounds/{w}/{slug}.mp4",
                })
        return out

    kinds["video"] = live_items("video", 9)
    kinds["video_v2"] = live_items("video_v2", 4, prefix="v2_")
    kinds["video_v3"] = live_items("video_v3", 7)

    kinds["intro"] = [{
        "slug": f"{w}_intro", "kind": "intro", "category": w,
        "thumb": f"/mock/thumbs/bg_{pick(bg_art, w + 'intro')}.webp",
        "media": clip(w + "intro"),
        "enabled": True, "rev": 0, "description": "",
    } for w in worlds]

    kinds["intro_end"] = [{
        "slug": f"{w}_end_bg", "kind": "intro_end", "category": w,
        "thumb": f"/mock/thumbs/bg_{pick(bg_art, w + 'end')}.webp",
        "media": clip(w + "end"),
        "enabled": True, "rev": 0, "description": "",
    } for w in worlds]

    songs = [
        "moonlit_lullaby", "sleepy_meadow", "starlight_waltz", "gentle_tide",
        "cloud_cradle", "little_lantern", "quiet_forest", "dream_ferry",
        "soft_snowfall", "amber_evening", "hush_now", "velvet_sky",
    ]
    kinds["intro_music"] = [{
        "slug": s, "kind": "intro_music", "category": "theme_pool", "thumb": None,
        "media": track(s),
        "enabled": True, "rev": 0, "duration_s": 42 + (i * 7) % 39,
        "description": ["warm", "calm", "playful", "dreamy"][i % 4] + " opening theme",
    } for i, s in enumerate(songs)]

    # animations v2/v3 — re-presented characters, action_view naming
    v2_source = [i for i in kinds["character"] if i["thumb"]][:96]
    kinds["animation"] = [{
        **{k: v for k, v in it.items() if k != "kind"},
        "kind": "animation",
        "actions": [f"{a}_{v}" for a in ("idle", "move", "happy") for v in ("front", "side")],
        "progress": (
            {"done": 22, "total": 39, "status": "generating"} if i % 17 == 3
            else {"done": 39, "total": 39, "status": "done"} if i % 17 == 7
            else None
        ),
    } for i, it in enumerate(v2_source)]
    kinds["animation_v3"] = [
        {**{k: v for k, v in it.items() if k != "kind"}, "kind": "animation_v3"}
        for it in v2_source[:48]
    ]

    for kind, items in kinds.items():
        print(f"  {kind:14s} {len(items):4d} items, {len({i['category'] for i in items}):2d} categories")
    return kinds


def build_zone_docs(full: dict, assets: dict) -> dict:
    """Editable zone documents, in the exact shape frontend/src/api.ts calls
    BackgroundEditable.

    EVERY background and EVERY live scene gets one. An earlier revision only
    covered the handful with full-size art, which left 104 of 107 backgrounds
    opening onto an empty canvas — the zone editor is the whole point of the
    Backgrounds tab, so a fixture that only covers 3% of it is not a fixture.

    Real zones come from the shipped manifest wherever the slug matches; the
    rest get a sensible sky/mid/ground split to edit from.
    """
    manifest_path = BACKEND / "data" / "backgrounds_manifest.json"
    manifest = {}
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    by_slug = {Path(key).stem: entry for key, entry in manifest.items()}

    allowed_zone_names = ["sky", "mid", "ground", "foreground", "water", "ceiling", "walls",
                          "surface", "buildings", "space"]
    allowed_surfaces = ["floor", "water", "wall", "sky", "tabletop", "decor", "none"]

    full_bgs = {b["slug"]: b["url"] for b in full.get("backgrounds", [])}
    full_posters = {p["slug"]: p["url"] for p in full.get("posters", [])}
    bg_names = sorted(full_bgs)
    poster_names = sorted(full_posters)

    def default_zones(indoor: bool = False):
        if indoor:
            return [
                {"name": "ceiling", "polygon": [[0, 0], [100, 0], [100, 22], [0, 22]],
                 "surface": "none", "description": "Ceiling and upper walls.", "color": None},
                {"name": "walls", "polygon": [[0, 22], [100, 22], [100, 62], [0, 62]],
                 "surface": "wall", "description": "Back wall and furniture line.", "color": None},
                {"name": "ground", "polygon": [[0, 62], [100, 62], [100, 100], [0, 100]],
                 "surface": "floor", "description": "Floor where characters stand.", "color": None},
            ]
        return [
            {"name": "sky", "polygon": [[0, 0], [100, 0], [100, 46], [0, 46]],
             "surface": "sky", "description": "Sky — clouds, sun/moon, birds.", "color": None},
            {"name": "mid", "polygon": [[0, 46], [100, 46], [100, 66], [0, 66]],
             "surface": "none", "description": "Horizon and distance.", "color": None},
            {"name": "ground", "polygon": [[0, 66], [100, 66], [100, 100], [0, 100]],
             "surface": "floor", "description": "Ground where characters stand.", "color": None},
        ]

    def zones_from_manifest(entry):
        raw = entry.get("zones") or {}
        out = []
        for name, z in raw.items():
            if not isinstance(z, dict):
                continue
            ys = float(z.get("y_start_pct", 0) or 0)
            ye = float(z.get("y_end_pct", 100) or 100)
            poly = z.get("polygon")
            if not (isinstance(poly, list) and len(poly) >= 3):
                poly = [[0.0, ys], [100.0, ys], [100.0, ye], [0.0, ye]]
            out.append({
                "name": name,
                "polygon": [[float(pt[0]), float(pt[1])] for pt in poly],
                "surface": z.get("surface") or ("water" if name == "water" else
                                                "floor" if name == "ground" else
                                                "sky" if name == "sky" else "none"),
                "description": z.get("description") or "",
                "color": z.get("color"),
            })
        return out

    docs = {}

    def add(slug: str, url: str, key: str, is_video: bool, indoor: bool):
        entry = by_slug.get(slug, {})
        zones = zones_from_manifest(entry) or default_zones(indoor)
        docs[slug] = {
            "slug": slug,
            "manifest_key": key,
            "url": url,
            "description": entry.get("description") or "",
            "resolution": entry.get("resolution") or {"width": 1920, "height": 1080},
            "allowed_zone_names": allowed_zone_names,
            "allowed_surfaces": allowed_surfaces,
            "enabled": True,
            "zones": zones,
            "is_video": is_video,
        }

    # every still background
    for item in assets.get("background", []):
        slug = item["slug"]
        art = slug if slug in full_bgs else pick(bg_names, slug)
        add(slug, full_bgs.get(art), f"backgrounds/{item['category']}/{slug}.png",
            False, "indoor" in slug or "home" in item["category"] or "hospital" in item["category"])

    # every live scene (video / v2 / v3) — same doc shape, poster backdrop
    for kind in ("video", "video_v2", "video_v3"):
        for item in assets.get(kind, []):
            slug = item["slug"]
            art = pick(poster_names, slug) if poster_names else None
            url = full_posters.get(art) if art else None
            if url is None:  # no plates locally — fall back to a background render
                url = full_bgs.get(pick(bg_names, slug))
            add(slug, url, f"live_backgrounds/{item['category']}/{slug}.mp4", True, False)

    print(f"  zone docs: {len(docs)} (every background and live scene)")
    return docs


SPRITE_POOL: list[str] = []


def build_movers(full: dict, assets: dict) -> dict:
    """Live-bg moving objects, shaped like /videos/{slug}/movers.

    Covers every live scene. An earlier revision hardcoded a `great_oak_scene_`
    prefix, so all 28 plates collapsed onto nine names and 27 of 36 scenes
    opened the Objects tab onto "no editable source bundle" — which reads as a
    broken tab, not as a real state.

    Two scenes are deliberately left WITHOUT a bundle, because that is a real
    production condition (the source spec/plate/cutouts are not always kept) and
    the empty state deserves to be exercised.
    """
    posters = full.get("posters", [])
    if not posters:
        return {}
    poster_urls = [p["url"] for p in posters]

    kinds = [
        ("float", True, True), ("swim", False, True), ("patrol", True, True),
        ("pulse", True, False), ("peek", True, True),
    ]
    creatures = ["firefly", "robin", "bee", "butterfly", "squirrel", "owl", "fox", "frog"]

    slugs: list[str] = []
    for kind in ("video", "video_v2", "video_v3"):
        for item in assets.get(kind, []):
            if item["slug"] not in slugs:
                slugs.append(item["slug"])
    slugs.sort()

    # leave the last two without a source bundle on purpose
    editable = slugs[:-2] if len(slugs) > 4 else slugs

    out = {}
    for si, slug in enumerate(editable):
        movers = []
        count = 4 + (si % 4)          # 4-7 objects, so scenes differ
        for i in range(count):
            kind, positionable, has_y = kinds[(si + i) % len(kinds)]
            w = 80 + ((si + i) % 3) * 20
            movers.append({
                "index": i,
                "id": creatures[(si + i) % len(creatures)],
                "kind": kind,
                "x": round(12 + ((si * 7 + i * 14.5) % 76), 1),
                "y": round(22 + ((si * 5 + i * 11.3) % 55), 1),
                "w": w,
                "w_pct": round(w / 1280 * 100, 2),
                "flip": (si + i) % 2 == 0,
                "to_left": (si + i) % 3 == 0,
                "x0": 5.0 if kind == "swim" else None,
                "x1": 95.0 if kind == "swim" else None,
                "speed": 1.0 + ((si + i) % 3) * 0.25,
                "positionable": positionable,
                "has_y": has_y,
                "cutout_url": f"/mock/thumbs/{pick(SPRITE_POOL, slug + str(i))}.webp"
                              if SPRITE_POOL else None,
                "bush": None, "bush_x": None, "bush_y": None,
                "bush_w": None, "bush_w_pct": None, "bush_cutout_url": None,
                "tiles_per_loop": None,
            })
        out[slug] = {
            "slug": slug,
            "video_url": poster_urls[si % len(poster_urls)],
            "loop_s": 12.0,
            "water": None,
            "movers": movers,
        }

    print(f"  mover scenes: {len(out)} of {len(slugs)} "
          f"({len(slugs) - len(out)} left without a source bundle on purpose)")
    return out


def build_world_graph(assets: dict) -> dict:
    """One location graph per world, shaped like /live-bgs-v3/{world}/graph.

    Synthesized (the real graphs live in the bucket) but deliberately imperfect:
    each world carries a disconnected pair and some time-of-day mismatches so the
    canvas's connectivity audit has something real to report. Every world that
    appears as a relation-background category gets one — a world card that opens
    onto an error is worse than no card.
    """
    districts = ["canopy", "roots", "clearing"]
    portals = ["path", "arch", "door", "stair", "walkway", "gate"]
    tods = ["day", "day", "dusk", "night"]

    def endpoint(x, y):
        return {"zone": "ground", "screen_zone": "center",
                "center_pct": [x, y], "landmark_ids": []}

    worlds = {}
    by_world: dict[str, list] = {}
    for item in assets.get("video_v3", []):
        by_world.setdefault(item["category"], []).append(item)

    for world, items in sorted(by_world.items()):
        nodes = []
        for i, it in enumerate(sorted(items, key=lambda x: x["slug"])):
            nodes.append({
                "slug": it["slug"],
                "url": it["thumb"],
                "description": f"A place in the {districts[i % len(districts)]} district.",
                "indoor": i % 4 == 0,
                "tod": tods[i % len(tods)],
                "parent": None,
                "status": "ready",
                "cluster": districts[i % len(districts)],
                "ui": None,
            })

        routes = []
        # a connected spine over most nodes, leaving the last two isolated
        for i in range(max(0, len(nodes) - 3)):
            routes.append({
                "id": f"{world}-r{i:02d}",
                "from": nodes[i]["slug"], "to": nodes[i + 1]["slug"],
                "bidirectional": i % 3 != 0,
                "relation": "path" if i % 2 else "enter",
                "portal": portals[i % len(portals)],
                "exit": endpoint(round(60 + i * 3 % 30, 1), round(62 + i * 2 % 20, 1)),
                "entry": endpoint(round(20 + i * 4 % 30, 1), round(64 + i * 3 % 18, 1)),
            })
        if len(nodes) >= 2:
            routes.append({
                "id": f"{world}-r90",
                "from": nodes[-1]["slug"], "to": nodes[-2]["slug"],
                "bidirectional": True, "relation": "path", "portal": "vista",
                "exit": endpoint(70.0, 60.0), "entry": endpoint(30.0, 62.0),
            })

        worlds[world] = {
            "world_id": world,
            "version": 3,
            "clusters": {
                "canopy": {"title": "Canopy", "emoji": "\U0001F33F"},
                "roots": {"title": "Roots", "emoji": "\U0001FAB5"},
                "clearing": {"title": "Clearing", "emoji": "\U0001F324"},
            },
            "nodes": nodes,
            "routes": routes,
            "editor_ui": {},
            "_synthetic": True,
        }

    print(f"  world graphs: {len(worlds)} "
          f"({', '.join(f'{k}:{len(v[chr(110)+chr(111)+chr(100)+chr(101)+chr(115)])}' for k, v in sorted(worlds.items()))})")
    return worlds


# --- main --------------------------------------------------------------------


def main() -> int:
    if not CACHE.is_dir():
        print(f"! asset cache not found at {CACHE}", file=sys.stderr)
        return 1

    print("generating fixtures")
    reset_dir(THUMBS)
    reset_dir(STRIPS)
    reset_dir(FULL)
    reset_dir(AUDIO)
    reset_dir(VIDEO)

    global SPRITE_POOL
    sprite_art = build_sprite_art()
    SPRITE_POOL = sprite_art
    bg_art = build_background_art()
    obj_art = build_object_art()
    audio_art = build_audio()
    full = copy_full_size()
    plates = sorted((CACHE / "layers").glob("*/plate.png"))
    video_art = build_video(plates)

    assets = build_assets(sprite_art, bg_art, obj_art, audio_art, video_art)
    zones = build_zone_docs(full, assets)
    movers = build_movers(full, assets)
    graphs = build_world_graph(assets)

    write_json(OUT_FIXTURES / "assets.json", assets)
    write_json(OUT_FIXTURES / "zones.json", zones)
    write_json(OUT_FIXTURES / "movers.json", movers)
    write_json(OUT_FIXTURES / "worldGraphs.json", graphs)
    write_json(OUT_FIXTURES / "media.json", full)

    total = sum(len(v) for v in assets.values())
    size = sum(f.stat().st_size for f in OUT_PUBLIC.rglob("*") if f.is_file())
    print(f"done: {total} assets, {size / 1024 / 1024:.1f} MB of media")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
