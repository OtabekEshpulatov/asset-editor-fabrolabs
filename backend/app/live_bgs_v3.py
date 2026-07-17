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
