"""Bake a small, seamless *ambient overlay* Lottie for a background — offline.

Verbatim copy of story-gen-exps scripts/v5_build_ambient_lottie.py (pure Python + PIL).

The professional "plate + FX overlay" model: the background stays a static PNG;
the motion lives in a thin TRANSPARENT Lottie the engine already renders
(``lottie.render_lottie_frame`` -> a Pillow RGBA frame).

Two layer kinds, each INDEPENDENT (own params -> no two move alike):

* ``Float`` — a single placed cutout (a cloud, a bird, the boat, a fish) with its
  own 2-D sine drift: x = x0 + ax*sin(2pi t/Tx + phx), y = y0 + ay*sin(2pi t/Ty + phy).
  Periods snap to divide the loop -> seamless; different (T, phi, amp, dir) per element
  makes the motion organic, not lock-stepped.
* ``Strip`` — a tileable transparent band scrolled along one axis (x = shoreline
  foam / sea shimmer; y = rising bubbles) by an integer number of tiles -> seamless.

Smoothness: position is baked every ``kf_stride`` frames with bezier handles
(rlottie REQUIRES i/o handles or it drops the animation and pins the layer to 0,0).
The renderer samples integer frames; stride 1 lands exactly on keyframes (perfectly
smooth), stride 2 is imperceptibly interpolated for slow motion at half the size.
"""
from __future__ import annotations

import base64
import io
import json
import math
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image


@dataclass
class Float:
    """A single cutout with independent 2-D sine drift (placement in % of W,H)."""
    png: str
    x_pct: float
    y_pct: float
    scale: float = 1.0
    ax_pct: float = 0.0   # x amplitude, % of W
    tx_s: float = 10.0    # x period, seconds (snapped to divide the loop)
    phx: float = 0.0      # x phase, turns (0..1)
    ay_pct: float = 0.0   # y amplitude, % of H
    ty_s: float = 10.0    # y period, seconds
    phy: float = 0.0      # y phase, turns
    breathe: float = 0.0  # scale "breathing" amplitude, fraction of scale (0.08 = ±8%); 0 = static size
    tb_s: float = 4.0     # breathe period, seconds (snapped to divide the loop)
    name: str = "float"


@dataclass
class Swim:
    """A cutout that TRAVERSES the frame once per loop — enters one side off-screen,
    crosses, exits the other side, then waits parked off-screen until the loop
    restarts (so it re-enters cleanly). Stagger ``start_frac`` and vary ``y_pct`` /
    direction across several Swims to get organic traffic at different heights both
    ways. The cutout must FACE its travel direction (flip it for R->L). Seamless as
    long as start_frac + dur_frac <= 1 (it parks off-screen before the loop point)."""
    png: str
    y_pct: float
    scale: float = 1.0
    to_left: bool = False     # False: L->R (face right); True: R->L (face left)
    start_frac: float = 0.0   # when the crossing begins (0..1 of the loop)
    dur_frac: float = 0.55    # crossing duration (fraction of the loop)
    ay_pct: float = 2.0       # vertical bob amplitude, % of H
    ty_s: float = 5.0         # bob period, seconds
    phy: float = 0.0          # bob phase, turns
    y_end_pct: float | None = None  # if set, the crossing DESCENDS/RISES y_pct->y_end_pct (diagonal: enter high corner, exit the far side)
    x0_pct: float | None = None     # confine the flight to an IN-FRAME band [x0,x1] (fades in/out at the ends) instead of off-screen->off-screen — e.g. keep a shooting star inside a window
    x1_pct: float | None = None
    name: str = "swim"


@dataclass
class Strip:
    """A tileable transparent band scrolled along one axis.

    axis='x' -> horizontal scroll at vertical centre ``y_pct`` (foam, shimmer).
    axis='y' -> vertical scroll at horizontal centre ``x_pct`` (rising bubbles).
    ``to_negative`` scrolls left (x) or up (y). The png must tile along that axis.
    """
    png: str
    y_pct: float = 50.0
    x_pct: float = 50.0
    tiles_per_loop: int = 1
    axis: str = "x"
    to_negative: bool = True
    name: str = "strip"


@dataclass
class Pulse:
    """A STATIONARY cutout whose OPACITY is animated (position fixed). For flashes
    (lightning), foam whitecap pops, god-ray pulses — the one motion rlottie does
    reliably besides transforms (track-mattes are broken in our build).

    Two modes (opacities are fractions 0..1):
    * continuous sine — set ``period_s`` > 0; opacity oscillates ``base_op``..``max_op``.
    * discrete flashes — give ``events`` = list of ``(center_s, half_width_s, peak_op)``
      triangular pulses (placed at irregular ``center_s`` that don't divide the loop ->
      looks random). Opacity = max(base_op, any active flash)."""
    png: str
    x_pct: float
    y_pct: float
    scale: float = 1.0
    period_s: float = 0.0                 # >0 -> continuous sine pulse
    phase: float = 0.0                    # turns (sine mode)
    base_op: float = 0.0                  # opacity outside pulses / sine trough
    max_op: float = 1.0                   # sine peak
    events: list = field(default_factory=list)   # (center_s, half_s, peak_op) flashes
    name: str = "pulse"


@dataclass
class Peek:
    """A cutout that POPS UP into view then ducks back down — a critter peeking from
    behind a bush. Hidden (opacity 0, sunk by ``rise_pct``) for most of the loop; at
    each ``starts`` fraction it rises + fades in over ``rise_s``, holds ``hold_s``, then
    sinks + fades out. Pair with a foreground bush layer (drawn ON TOP, i.e. earlier in
    the list) to hide its lower body. Seamless as long as no event crosses the loop end."""
    png: str
    x_pct: float
    y_pct: float                                  # revealed (up) centre
    scale: float = 1.0
    rise_pct: float = 7.0                         # how far it sinks when hidden, % of H
    starts: list = field(default_factory=lambda: [0.25])
    hold_s: float = 1.6
    rise_s: float = 0.5
    name: str = "peek"
    cover_y_pct: float | None = None              # the bush's BOTTOM edge, % of H. When set, the critter
    #                                               is kept invisible while it would poke out BELOW the bush
    #                                               (it only fades in once it has risen behind the bush).


@dataclass
class Snow:
    """A field of INDEPENDENT falling particles (snow / sugar / leaves) built from ONE
    tiny soft-dot cutout: each of ``count`` particles has its own x, fall speed, size,
    opacity and horizontal sine drift, and wraps off-screen seamlessly — so no two flakes
    move alike (fixes the lock-step look of a single scrolled Strip)."""
    png: str                                      # a small soft dot cutout
    count: int = 28
    size_min: float = 0.4                         # scale range of the dot
    size_max: float = 1.0
    drift_pct: float = 1.2                        # max horizontal sine drift, % of W
    name: str = "snow"


@dataclass
class Patrol:
    """A cutout that drifts horizontally BACK AND FORTH and FACES its travel direction
    — right-facing while moving right, left-facing while moving left (e.g. a swan gliding
    on a pond). Built as two layers (the png + its mirror) cross-faded at each turn, where
    the subject is momentarily still, so the flip reads as the swan turning around."""
    png: str                                      # right-facing cutout
    png_left: str                                 # left-facing (horizontally flipped)
    x_pct: float                                  # centre of the patrol
    y_pct: float
    ax_pct: float = 6.0                           # half-range, % of W
    period_s: float = 14.0                        # one full back-and-forth, seconds
    phase: float = 0.0
    scale: float = 1.0
    ay_pct: float = 0.0                           # vertical bob amplitude, % of H
    ty_s: float = 9.0
    phy: float = 0.0
    name: str = "patrol"


# --------------------------------------------------------------------------- #
def _asset(cache: dict, assets: list, png: str) -> tuple[str, int, int]:
    if png in cache:
        return cache[png]
    with Image.open(png) as im:
        im = im.convert("RGBA")
        w, h = im.size
        buf = io.BytesIO()
        im.save(buf, "PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    aid = f"img_{len(assets)}"
    assets.append({"id": aid, "w": w, "h": h, "u": "", "p": f"data:image/png;base64,{b64}", "e": 1})
    cache[png] = (aid, w, h)
    return cache[png]


def _layer(ind: int, aid: str, pw: int, ph: int, pos: dict, scale: float, op: int, name: str,
           opacity: dict | None = None, scale_kf: dict | None = None) -> dict:
    return {
        "ddd": 0, "ind": ind, "ty": 2, "nm": name, "refId": aid, "sr": 1,
        "ks": {
            "o": opacity if opacity is not None else {"a": 0, "k": 100}, "r": {"a": 0, "k": 0}, "p": pos,
            "a": {"a": 0, "k": [pw / 2.0, ph / 2.0, 0]},
            "s": scale_kf if scale_kf is not None else {"a": 0, "k": [scale * 100.0, scale * 100.0, 100]},
        },
        "ao": 0, "ip": 0, "op": op, "st": 0, "bm": 0,
    }


def _breathe_kf(scale: float, amp: float, tb_s: float, fps: int, op: int, loop_s: float, stride: int) -> dict:
    """Animated transform scale: gently oscillate the cutout's size between
    scale*(1-amp) and scale*(1+amp) — an in-place 'breathing' idle. Same keyframe
    shape as the position animations (rlottie needs the i/o handles _animated adds)."""
    wv = 2 * math.pi / (_snap_period(tb_s, loop_s) * fps)
    kf = []
    for t in _frames(op, stride):
        s = round(scale * (1.0 + amp * math.sin(wv * t)) * 100.0, 2)
        kf.append({"t": t, "s": [s, s, 100]})
    return _animated(kf)


def _snap_period(t_s: float, loop_s: float) -> float:
    k = max(1, round(loop_s / max(0.1, t_s)))
    return loop_s / k


def _frames(op: int, stride: int) -> list[int]:
    ts = list(range(0, op + 1, max(1, stride)))
    if ts[-1] != op:
        ts.append(op)
    return ts


def _rng(i: int, salt: float) -> float:
    """Deterministic pseudo-random in [0,1) per particle index (GLSL-style hash)."""
    x = math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
    return x - math.floor(x)


def _animated(kf: list) -> dict:
    """rlottie needs i/o bezier handles on each keyframe to parse an animated
    position (without them it drops the animation and pins the layer to 0,0)."""
    for k in kf[:-1]:
        k["o"] = {"x": [0.5], "y": [0.5]}
        k["i"] = {"x": [0.5], "y": [0.5]}
    return {"a": 1, "k": kf}


def _float_kf(fl: Float, w: int, h: int, fps: int, op: int, loop_s: float, stride: int) -> dict:
    x0, y0 = fl.x_pct / 100.0 * w, fl.y_pct / 100.0 * h
    ax, ay = fl.ax_pct / 100.0 * w, fl.ay_pct / 100.0 * h
    wx = 2 * math.pi / (_snap_period(fl.tx_s, loop_s) * fps)
    wy = 2 * math.pi / (_snap_period(fl.ty_s, loop_s) * fps)
    px, py = 2 * math.pi * fl.phx, 2 * math.pi * fl.phy
    return _animated([{"t": t, "s": [round(x0 + ax * math.sin(wx * t + px), 2),
                                     round(y0 + ay * math.sin(wy * t + py), 2), 0]} for t in _frames(op, stride)])


def _lin_kf(x0: float, y0: float, x1: float, y1: float, op: int, stride: int) -> dict:
    return _animated([{"t": t, "s": [round(x0 + (x1 - x0) * (t / op), 2),
                                     round(y0 + (y1 - y0) * (t / op), 2), 0]} for t in _frames(op, stride)])


def _swim_kf(sw: Swim, fw: float, w: int, h: int, fps: int, op: int, loop_s: float, stride: int) -> dict:
    if sw.x0_pct is not None and sw.x1_pct is not None:   # confined in-frame band (fades at the ends)
        bx0, bx1 = sw.x0_pct / 100.0 * w, sw.x1_pct / 100.0 * w
        cx_a, cx_b = (bx1, bx0) if sw.to_left else (bx0, bx1)
    else:                                                 # default: enter/exit fully off-screen
        off_l, off_r = -fw, w + fw
        cx_a, cx_b = (off_r, off_l) if sw.to_left else (off_l, off_r)
    t0, t1 = sw.start_frac * op, min(op, (sw.start_frac + sw.dur_frac) * op)
    y0, ay = sw.y_pct / 100.0 * h, sw.ay_pct / 100.0 * h
    y1 = (sw.y_end_pct / 100.0 * h) if sw.y_end_pct is not None else y0
    wy, py = 2 * math.pi / (_snap_period(sw.ty_s, loop_s) * fps), 2 * math.pi * sw.phy
    kf = []
    for t in _frames(op, stride):
        if t <= t0:
            cx, yb = cx_a, y0
        elif t >= t1:
            cx, yb = cx_b, y1
        else:
            f = (t - t0) / (t1 - t0)
            cx, yb = cx_a + (cx_b - cx_a) * f, y0 + (y1 - y0) * f
        kf.append({"t": t, "s": [round(cx, 2), round(yb + ay * math.sin(wy * t + py), 2), 0]})
    return _animated(kf)


def _swim_op_kf(sw: Swim, op: int, stride: int) -> dict:
    """Opacity for a CONFINED swim: 0 while parked, fading in/out over the band ends so it
    appears and vanishes within the band instead of sliding off-screen."""
    t0, t1 = sw.start_frac * op, min(op, (sw.start_frac + sw.dur_frac) * op)
    span = max(1.0, t1 - t0)
    fade = 0.16 * span
    kf = []
    for t in _frames(op, stride):
        if t <= t0 or t >= t1:
            o = 0.0
        elif t < t0 + fade:
            o = (t - t0) / fade
        elif t > t1 - fade:
            o = (t1 - t) / fade
        else:
            o = 1.0
        kf.append({"t": t, "s": [round(100.0 * max(0.0, min(1.0, o)), 2)]})
    return _animated(kf)


def _pulse_op(pl: Pulse, t: int, fps: int, loop_s: float) -> float:
    """Opacity (0..1) of a Pulse at frame ``t``."""
    if pl.period_s > 0:
        w = 2 * math.pi / (_snap_period(pl.period_s, loop_s) * fps)
        return pl.base_op + (pl.max_op - pl.base_op) * 0.5 * (1 + math.sin(w * t + 2 * math.pi * pl.phase))
    v = pl.base_op
    for c_s, half_s, peak in pl.events:
        c, half = c_s * fps, max(1e-6, half_s * fps)
        d = abs(t - c)
        if d < half:
            v = max(v, peak * (1 - d / half))
    return v


def _pulse_kf(pl: Pulse, fps: int, op: int, loop_s: float, stride: int) -> dict:
    return _animated([{"t": t, "s": [round(100.0 * max(0.0, min(1.0, _pulse_op(pl, t, fps, loop_s))), 2)]}
                      for t in _frames(op, stride)])


def _peek_r(pk: Peek, t: float, fps: int, op: int) -> float:
    """Reveal factor 0..1 at frame t (0 = hidden/sunk, 1 = fully up), smoothstep-eased."""
    rf = max(1.0, pk.rise_s * fps)
    hf = max(0.0, pk.hold_s * fps)
    r = 0.0
    for s in pk.starts:
        t0 = s * op
        up1, hd1, dn1 = t0 + rf, t0 + rf + hf, t0 + 2 * rf + hf
        if t0 <= t < up1:
            r = max(r, (t - t0) / rf)
        elif up1 <= t < hd1:
            r = max(r, 1.0)
        elif hd1 <= t < dn1:
            r = max(r, 1.0 - (t - hd1) / rf)
    return r * r * (3 - 2 * r)


def _peek_pos_kf(pk: Peek, w: int, h: int, fps: int, op: int, stride: int) -> dict:
    x = pk.x_pct / 100.0 * w
    y_up = pk.y_pct / 100.0 * h
    rise = pk.rise_pct / 100.0 * h
    return _animated([{"t": t, "s": [round(x, 2), round(y_up + (1 - _peek_r(pk, t, fps, op)) * rise, 2), 0]}
                      for t in _frames(op, stride)])


def _peek_op_kf(pk: Peek, fps: int, op: int, stride: int, h: int | None = None, ch: float | None = None) -> dict:
    """Opacity over the loop. Without a bush (cover_y_pct None) it's the plain reveal fade.
    WITH a bush, opacity is GATED by the critter's vertical position: it stays 0 while the
    critter's bottom would poke out BELOW the bush bottom, and fades to full only once it has
    risen behind the bush — so you never see it appear/leave below the bush. The revealed (up)
    position is always shown, even if the bush is small."""
    if pk.cover_y_pct is None or h is None or ch is None:
        return _animated([{"t": t, "s": [round(100.0 * _peek_r(pk, t, fps, op), 2)]} for t in _frames(op, stride)])
    y_up = pk.y_pct / 100.0 * h
    rise = pk.rise_pct / 100.0 * h
    cover_y = pk.cover_y_pct / 100.0 * h
    b_up = y_up + ch / 2.0                              # critter's bottom edge when fully revealed
    band = max(8.0, 0.045 * h)                          # smooth fade width, px
    thresh = max(cover_y, b_up + band)                 # gate line; +band guarantees the up pose stays visible
    kf = []
    for t in _frames(op, stride):
        r = _peek_r(pk, t, fps, op)
        cb = b_up + (1.0 - r) * rise                    # critter's bottom edge at this frame (lower when sunk)
        gate = max(0.0, min(1.0, (thresh - cb) / band))
        kf.append({"t": t, "s": [round(100.0 * gate, 2)]})
    return _animated(kf)


def _patrol_pos_kf(pt: Patrol, w: int, h: int, fps: int, op: int, loop_s: float, stride: int) -> dict:
    x0, y0 = pt.x_pct / 100.0 * w, pt.y_pct / 100.0 * h
    ax, ay = pt.ax_pct / 100.0 * w, pt.ay_pct / 100.0 * h
    wx, px = 2 * math.pi / (_snap_period(pt.period_s, loop_s) * fps), 2 * math.pi * pt.phase
    wy, py = 2 * math.pi / (_snap_period(pt.ty_s, loop_s) * fps), 2 * math.pi * pt.phy
    return _animated([{"t": t, "s": [round(x0 + ax * math.sin(wx * t + px), 2),
                                     round(y0 + ay * math.sin(wy * t + py), 2), 0]} for t in _frames(op, stride)])


def _patrol_op_kf(pt: Patrol, fps: int, op: int, loop_s: float, stride: int, right: bool) -> dict:
    """Opacity that favours the right-facing layer while moving right (dx/dt>0) and the
    left-facing layer while moving left, with a soft flip as the velocity crosses 0."""
    wx, px = 2 * math.pi / (_snap_period(pt.period_s, loop_s) * fps), 2 * math.pi * pt.phase
    kf = []
    for t in _frames(op, stride):
        v = math.cos(wx * t + px)                       # sign of dx/dt
        r = max(0.0, min(1.0, 0.5 + v / 0.5))           # smooth crossfade near the turn
        kf.append({"t": t, "s": [round(100.0 * (r if right else 1.0 - r), 2)]})
    return _animated(kf)


def build_overlay(layers: list, *, w: int, h: int, fps: int, loop_s: float, kf_stride: int = 1) -> dict:
    """Assemble the overlay. List order = paint order: index 0 is drawn ON TOP."""
    op = int(round(loop_s * fps))
    cache: dict = {}
    assets: list = []
    out: list = []
    ind = 1
    for layer in layers:
        aid, pw, ph = _asset(cache, assets, layer.png)
        if isinstance(layer, Float):
            skf = (_breathe_kf(layer.scale, layer.breathe, layer.tb_s, fps, op, loop_s, kf_stride)
                   if layer.breathe > 0 else None)
            out.append(_layer(ind, aid, pw, ph, _float_kf(layer, w, h, fps, op, loop_s, kf_stride),
                              layer.scale, op, layer.name, scale_kf=skf))
            ind += 1
        elif isinstance(layer, Swim):
            op_anim = _swim_op_kf(layer, op, kf_stride) if layer.x0_pct is not None else None
            out.append(_layer(ind, aid, pw, ph, _swim_kf(layer, pw * layer.scale, w, h, fps, op, loop_s, kf_stride),
                              layer.scale, op, layer.name, opacity=op_anim))
            ind += 1
        elif isinstance(layer, Pulse):
            pos = {"a": 0, "k": [round(layer.x_pct / 100.0 * w, 2), round(layer.y_pct / 100.0 * h, 2), 0]}
            out.append(_layer(ind, aid, pw, ph, pos, layer.scale, op, layer.name,
                              opacity=_pulse_kf(layer, fps, op, loop_s, kf_stride)))
            ind += 1
        elif isinstance(layer, Peek):
            out.append(_layer(ind, aid, pw, ph, _peek_pos_kf(layer, w, h, fps, op, kf_stride),
                              layer.scale, op, layer.name,
                              opacity=_peek_op_kf(layer, fps, op, kf_stride, h=h, ch=ph * layer.scale)))
            ind += 1
        elif isinstance(layer, Patrol):
            aidR, pwR, phR = aid, pw, ph
            aidL, pwL, phL = _asset(cache, assets, layer.png_left)
            out.append(_layer(ind, aidR, pwR, phR, _patrol_pos_kf(layer, w, h, fps, op, loop_s, kf_stride),
                              layer.scale, op, layer.name + "_r", opacity=_patrol_op_kf(layer, fps, op, loop_s, kf_stride, True)))
            ind += 1
            out.append(_layer(ind, aidL, pwL, phL, _patrol_pos_kf(layer, w, h, fps, op, loop_s, kf_stride),
                              layer.scale, op, layer.name + "_l", opacity=_patrol_op_kf(layer, fps, op, loop_s, kf_stride, False)))
            ind += 1
        elif isinstance(layer, Snow):
            for i in range(layer.count):
                scale = layer.size_min + (layer.size_max - layer.size_min) * _rng(i, 1.0)
                x0 = _rng(i, 2.0) * w
                k = 2 + int(_rng(i, 3.0) * 4)               # 2..5 descents per loop (varied fall speed)
                phase_y = _rng(i, 4.0)
                drift = layer.drift_pct / 100.0 * w * (0.3 + 0.7 * _rng(i, 5.0))
                kd = 1 + int(_rng(i, 6.0) * 3)              # 1..3 horizontal drift cycles per loop
                px = 2 * math.pi * _rng(i, 7.0)
                m = ph * scale + 4                          # off-screen margin (wrap is invisible)
                opac = 55.0 + 45.0 * _rng(i, 8.0)
                fall, drf = op / k, op / kd
                kf = [{"t": t, "s": [round(x0 + drift * math.sin(2 * math.pi * t / drf + px), 1),
                                     round(-m + (h + 2 * m) * (((t / fall) + phase_y) % 1.0), 1), 0]}
                      for t in _frames(op, 1)]               # stride 1 -> the off-screen wrap never streaks on-screen
                out.append(_layer(ind, aid, pw, ph, _animated(kf), scale, op, f"{layer.name}{i}",
                                  opacity={"a": 0, "k": round(opac, 1)}))
                ind += 1
        else:  # Strip
            tiles = max(1, layer.tiles_per_loop)
            if layer.axis == "y":
                dy = (-tiles * h) if layer.to_negative else (tiles * h)
                x = layer.x_pct / 100.0 * w
                for c in range(tiles + 1):
                    y0 = (h / 2.0) + c * h
                    out.append(_layer(ind, aid, pw, ph, _lin_kf(x, y0, x, y0 + dy, op, kf_stride), 1.0, op, f"{layer.name}_{c}"))
                    ind += 1
            else:  # x
                dx = (-tiles * w) if layer.to_negative else (tiles * w)
                y = layer.y_pct / 100.0 * h
                for c in range(tiles + 1):
                    x0 = (w / 2.0) + c * w
                    out.append(_layer(ind, aid, pw, ph, _lin_kf(x0, y, x0 + dx, y, op, kf_stride), 1.0, op, f"{layer.name}_{c}"))
                    ind += 1
    return {"v": "5.7.0", "fr": fps, "ip": 0, "op": op, "w": w, "h": h,
            "nm": "ambient_overlay", "ddd": 0, "assets": assets, "layers": out}


def write_overlay(layers: list, path: Path, *, w: int, h: int, fps: int, loop_s: float, kf_stride: int = 1) -> dict:
    doc = build_overlay(layers, w=w, h=h, fps=fps, loop_s=loop_s, kf_stride=kf_stride)
    Path(path).write_text(json.dumps(doc), encoding="utf-8")
    return doc
