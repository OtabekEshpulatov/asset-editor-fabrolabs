"""Live backgrounds v3 — RELATION backgrounds (world location graphs).

A world may declare a location graph in ``manifests/world_graphs/<world_id>.json``
(uploaded from story-gen-exps, the engine's source of truth). Nodes are ordinary
live backgrounds under ``live_backgrounds/`` — files are NOT moved or duplicated;
a background "belongs" to v3 simply by being a node of a world graph. This tab
is a read-only VIEW: the same mp4s keep their v1 zones/movers and their v2
re-animation pairing.

Sidecar shape (schema v2, mirrors backend/engine/world_graphs.py in
story-gen-exps): nodes ``{slug, indoor?, parent?, tod?, status?}``, routes
``{id, from, to, bidirectional, relation, portal?, exit, entry}`` where each
endpoint carries ``{zone, screen_zone, center_pct:[x,y], landmark_ids}``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app import videos
from app.storage import minio

log = logging.getLogger(__name__)

GRAPHS_PREFIX = "manifests/world_graphs/"


def _graph_keys() -> dict[str, str]:
    """Map world_id -> sidecar object key."""
    out: dict[str, str] = {}
    try:
        keys = minio.list_objects(GRAPHS_PREFIX)
    except Exception as exc:
        log.warning("live_bgs_v3: listing %s failed: %r", GRAPHS_PREFIX, exc)
        return {}
    for key in keys:
        if key.lower().endswith(".json"):
            out[Path(key).stem] = key
    return out


def _load_graph(key: str) -> dict[str, Any] | None:
    try:
        raw = minio.download_bytes(key)
        if raw is None:
            return None
        doc = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        log.warning("live_bgs_v3: reading %s failed: %r", key, exc)
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("nodes"), list):
        return None
    return doc


def _node_dicts(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Nodes normalized to dicts (v1 sidecars use bare strings)."""
    out = []
    for n in doc.get("nodes") or []:
        if isinstance(n, str):
            out.append({"slug": n})
        elif isinstance(n, dict) and n.get("slug"):
            out.append(n)
    return out


def catalog(*, include_disabled: bool = False) -> dict[str, Any]:
    """{kind,total,categories} like every other kind — one category per world
    graph; items are the graph's nodes in sidecar order, with live-bg URLs and
    descriptions resolved from the ordinary live_backgrounds/ discovery."""
    del include_disabled  # a graph node is always shown; hiding one would lie about the graph
    video_keys = videos._video_keys()
    manifest = videos._read_manifest()
    categories = []
    for world_id, gkey in sorted(_graph_keys().items()):
        doc = _load_graph(gkey)
        if doc is None:
            continue
        routes = [r for r in (doc.get("routes") or []) if isinstance(r, dict)]
        degree: dict[str, int] = {}
        for r in routes:
            degree[r.get("from", "")] = degree.get(r.get("from", ""), 0) + 1
            if r.get("bidirectional", False):
                degree[r.get("to", "")] = degree.get(r.get("to", ""), 0) + 1
        items = []
        for n in _node_dicts(doc):
            slug = n["slug"]
            key = video_keys.get(slug)
            entry = manifest.get(slug) if isinstance(manifest.get(slug), dict) else {}
            items.append({
                "slug": slug,
                "url": minio.public_url_for_key(key) if key else None,
                "description": str(entry.get("description") or ""),
                "enabled": key is not None,  # missing mp4 shows as disabled
                "indoor": bool(n.get("indoor", False)),
                "tod": str(n.get("tod") or "day"),
                "relations": degree.get(slug, 0),
            })
        categories.append({"name": world_id, "count": len(items), "items": items})
    total = sum(c["count"] for c in categories)
    return {"kind": "video_v3", "total": total, "categories": categories}


_ALLOWED_RELATIONS = {"path", "enter"}

# "released to engine" channel: the editor's sync button copies the live
# sidecar here; story-gen-exps pulls this prefix into backend/engine/world_graphs/
# before story runs (scripts/v5_pull_world_graphs.py).
ENGINE_PREFIX = "manifests/world_graphs_engine/"


def sync_engine(world_id: str) -> dict[str, Any]:
    """Release the CURRENT live sidecar to the engine channel with a top-level
    ``synced_at`` stamp (unknown top-level keys are ignored by the engine
    loader). Raises KeyError for an unknown world."""
    gkey = _graph_keys().get(world_id)
    if gkey is None:
        raise KeyError(world_id)
    doc = _load_graph(gkey)
    if doc is None:
        raise KeyError(world_id)
    doc = dict(doc)
    doc["synced_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    minio.upload_bytes(
        json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8"),
        key=f"{ENGINE_PREFIX}{world_id}.json", content_type="application/json",
    )
    return {
        "world_id": world_id,
        "synced_at": doc["synced_at"],
        "nodes": len(doc.get("nodes") or []),
        "routes": len(doc.get("routes") or []),
    }


def engine_sync_status(world_id: str) -> dict[str, Any]:
    """When (if ever) this world's graph was last released to the engine
    channel, and whether the live sidecar has drifted since."""
    out: dict[str, Any] = {"world_id": world_id, "synced_at": None, "in_sync": False}
    try:
        raw = minio.download_bytes(f"{ENGINE_PREFIX}{world_id}.json")
        if raw is None:
            return out
        released = json.loads(raw.decode("utf-8"))
        out["synced_at"] = released.get("synced_at")
        gkey = _graph_keys().get(world_id)
        live = _load_graph(gkey) if gkey else None
        if live is not None:
            released.pop("synced_at", None)
            out["in_sync"] = released == live
    except Exception as exc:  # noqa: BLE001 — status is informational only
        log.warning("live_bgs_v3: engine sync status for %s failed: %r", world_id, exc)
    return out


def save_graph(world_id: str, routes: list[dict[str, Any]], ui: dict[str, Any]) -> dict[str, Any]:
    """Persist graph edits from the relation editor: the route list (rewired /
    created / deleted arrows) and per-node editor positions. Nodes themselves
    are never added or removed here — the graph editor only rearranges and
    rewires what exists. The previous sidecar is kept as ``<key>.bak``.

    ``routes`` arrive in the flattened view shape (``portal`` as a string) and
    are stored back in sidecar shape (``portal: {kind}``). Unknown slugs or
    malformed routes raise ValueError.
    """
    gkey = _graph_keys().get(world_id)
    if gkey is None:
        raise KeyError(world_id)
    raw = minio.download_bytes(gkey)
    doc = _load_graph(gkey)
    if raw is None or doc is None:
        raise KeyError(world_id)
    known = {n["slug"] for n in _node_dicts(doc)}
    old_routes = {r.get("id"): r for r in doc.get("routes") or [] if isinstance(r, dict)}

    norm_routes: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for r in routes:
        if not isinstance(r, dict):
            raise ValueError("route entries must be objects")
        rid = str(r.get("id") or "").strip()
        frm, to = r.get("from"), r.get("to")
        if not rid or rid in seen_ids:
            raise ValueError(f"route id missing or duplicated: {rid!r}")
        seen_ids.add(rid)
        if frm not in known or to not in known:
            raise ValueError(f"route {rid!r} references unknown background: {frm!r} -> {to!r}")
        if frm == to:
            raise ValueError(f"route {rid!r} connects a background to itself")
        relation = str(r.get("relation") or "path")
        if relation not in _ALLOWED_RELATIONS:
            raise ValueError(f"route {rid!r} has unknown relation {relation!r}")
        portal = r.get("portal")
        portal_kind = str(portal.get("kind") if isinstance(portal, dict) else portal or "walkway")
        # keep any extra portal fields (e.g. transition) the editor doesn't know about
        old_portal = old_routes.get(rid, {}).get("portal")
        if isinstance(old_portal, dict):
            portal_out = {**old_portal, "kind": portal_kind}
        else:
            portal_out = {"kind": portal_kind}
        norm_routes.append({
            "id": rid,
            "from": frm,
            "to": to,
            "bidirectional": bool(r.get("bidirectional", True)),
            "relation": relation,
            "portal": portal_out,
            "exit": r.get("exit") if isinstance(r.get("exit"), dict) else {},
            "entry": r.get("entry") if isinstance(r.get("entry"), dict) else {},
        })

    # editor positions live at DOC level ("editor_ui"), never on nodes — the
    # engine's NodeSpec is extra="forbid", so node-level extras would break a
    # future bucket→engine sync. Unknown top-level keys are ignored there.
    editor_ui = doc.get("editor_ui") if isinstance(doc.get("editor_ui"), dict) else {}
    for slug, pos in ui.items():
        if slug in known and isinstance(pos, dict) and "x" in pos and "y" in pos:
            editor_ui[slug] = {"x": round(float(pos["x"]), 1), "y": round(float(pos["y"]), 1)}
    doc["editor_ui"] = editor_ui
    doc["nodes"] = [{k: v for k, v in n.items() if k != "ui"} for n in _node_dicts(doc)]
    doc["routes"] = norm_routes

    minio.upload_bytes(raw, key=gkey + ".bak", content_type="application/json")
    minio.upload_bytes(
        json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8"),
        key=gkey, content_type="application/json",
    )
    return graph_view(world_id)


def _screen_zone_for(x: float) -> str:
    """Coarse horizontal label the engine uses alongside exact center_pct."""
    if x < 12:
        return "left_edge"
    if x < 38:
        return "left_third"
    if x <= 62:
        return "center"
    if x <= 88:
        return "right_third"
    return "right_edge"


def node_transitions(slug: str) -> dict[str, Any]:
    """All transitions of ONE background: for each related route, the endpoint
    that sits ON THIS bg (exit if from==slug; entry if to==slug on a
    bidirectional route) plus the neighbor's mp4 url for preview. Searches
    every world graph; raises KeyError if the slug is in none of them."""
    for world_id, gkey in sorted(_graph_keys().items()):
        doc = _load_graph(gkey)
        if doc is None:
            continue
        if slug not in {n["slug"] for n in _node_dicts(doc)}:
            continue
        video_keys = videos._video_keys()
        items = []
        for r in doc.get("routes") or []:
            if not isinstance(r, dict):
                continue
            if r.get("from") == slug:
                side, other = "exit", r.get("to")
            elif r.get("to") == slug and r.get("bidirectional", False):
                side, other = "entry", r.get("from")
            else:
                continue
            ep = r.get(side) if isinstance(r.get(side), dict) else {}
            okey = video_keys.get(other)
            items.append({
                "route_id": r.get("id"),
                "side": side,
                "other": other,
                "other_url": minio.public_url_for_key(okey) if okey else None,
                "far": (r.get("portal") or {}).get("kind") == "edge",
                "center_pct": ep.get("center_pct") or [50, 60],
                "zone": ep.get("zone") or "floor",
            })
        return {"world_id": world_id, "slug": slug, "transitions": items}
    raise KeyError(slug)


def set_transition_point(world_id: str, route_id: str, side: str, center_pct: list[float]) -> dict[str, Any]:
    """Move ONE route endpoint's on-frame point; screen_zone derives from x.
    Everything else about the route is left untouched."""
    if side not in ("exit", "entry"):
        raise ValueError("side must be 'exit' or 'entry'")
    if not isinstance(center_pct, (list, tuple)) or len(center_pct) != 2:
        raise ValueError("center_pct must be [x, y]")
    x = min(100.0, max(0.0, float(center_pct[0])))
    y = min(100.0, max(0.0, float(center_pct[1])))
    gkey = _graph_keys().get(world_id)
    if gkey is None:
        raise KeyError(world_id)
    raw = minio.download_bytes(gkey)
    doc = _load_graph(gkey)
    if raw is None or doc is None:
        raise KeyError(world_id)
    for r in doc.get("routes") or []:
        if isinstance(r, dict) and r.get("id") == route_id:
            ep = dict(r[side]) if isinstance(r.get(side), dict) else {}
            ep["center_pct"] = [round(x, 1), round(y, 1)]
            ep["screen_zone"] = _screen_zone_for(x)
            ep.setdefault("zone", "floor")
            ep.setdefault("landmark_ids", [])
            r[side] = ep
            break
    else:
        raise ValueError(f"route {route_id!r} not found in world {world_id!r}")
    minio.upload_bytes(raw, key=gkey + ".bak", content_type="application/json")
    minio.upload_bytes(
        json.dumps(doc, indent=2, ensure_ascii=False).encode("utf-8"),
        key=gkey, content_type="application/json",
    )
    return {"world_id": world_id, "route_id": route_id, "side": side,
            "center_pct": [round(x, 1), round(y, 1)], "screen_zone": _screen_zone_for(x)}


def graph_view(world_id: str) -> dict[str, Any]:
    """The full graph for one world, with node URLs resolved — the data the
    relation-map UI draws. Raises KeyError for an unknown world."""
    gkey = _graph_keys().get(world_id)
    if gkey is None:
        raise KeyError(world_id)
    doc = _load_graph(gkey)
    if doc is None:
        raise KeyError(world_id)
    video_keys = videos._video_keys()
    manifest = videos._read_manifest()
    editor_ui = doc.get("editor_ui") if isinstance(doc.get("editor_ui"), dict) else {}
    nodes = []
    for n in _node_dicts(doc):
        slug = n["slug"]
        key = video_keys.get(slug)
        entry = manifest.get(slug) if isinstance(manifest.get(slug), dict) else {}
        nodes.append({
            "slug": slug,
            "url": minio.public_url_for_key(key) if key else None,
            "description": str(entry.get("description") or ""),
            "indoor": bool(n.get("indoor", False)),
            "tod": str(n.get("tod") or "day"),
            "parent": n.get("parent"),
            "status": str(n.get("status") or "active"),
            "cluster": n.get("cluster"),
            "ui": editor_ui.get(slug) if isinstance(editor_ui.get(slug), dict) else None,
        })
    routes = []
    for r in doc.get("routes") or []:
        if not isinstance(r, dict):
            continue
        routes.append({
            "id": r.get("id"),
            "from": r.get("from"),
            "to": r.get("to"),
            "bidirectional": bool(r.get("bidirectional", False)),
            "relation": str(r.get("relation") or "path"),
            "portal": (r.get("portal") or {}).get("kind", "walkway"),
            "exit": r.get("exit") or {},
            "entry": r.get("entry") or {},
        })
    clusters = doc.get("clusters") if isinstance(doc.get("clusters"), dict) else {}
    return {"world_id": world_id, "version": doc.get("version"),
            "clusters": clusters, "nodes": nodes, "routes": routes}
