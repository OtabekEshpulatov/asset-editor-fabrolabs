"""Renderer stage envelope. Mirrors story-gen-exps engine_v4/config.py STAGE_*.

`backgrounds.py` clamps manifest placement coordinates into this envelope so the
zone editor never writes a coordinate the downstream renderer would reject.
"""

from __future__ import annotations

STAGE_MIN_X = 5.0
STAGE_MAX_X = 95.0
STAGE_MIN_Y = 5.0
STAGE_MAX_Y = 96.0
