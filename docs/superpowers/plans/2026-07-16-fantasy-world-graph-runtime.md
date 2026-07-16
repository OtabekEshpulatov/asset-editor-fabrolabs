# Fantasy World Graph Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-off Fantasy Kingdom location graph that constrains authored routes, carries exact doorway/path coordinates into staging, and makes hero entrances plus iris transitions spatially coherent without changing legacy output.

**Architecture:** A strict, versioned JSON sidecar is loaded through a fail-open typed graph module. World, prompt, and authoring code consume one validated graph view; the runner resolves direct scene boundaries and passes additive route metadata to the existing compiler and compositor. Production activation stays all-or-nothing until every declared asset and endpoint zone exists.

**Tech Stack:** Python 3.12, Pydantic v2, pytest, Engine V5, JSON sidecars.

## Global Constraints

- Work in an isolated `codex/fantasy-relation-bg-pilot` worktree and preserve the user's dirty journey changes.
- Use TDD for every behavior: failing focused test, minimal implementation, passing focused test, then commit.
- Keep `ENGINE_V5_WORLD_GRAPH` false by default and force it false in shared test isolation.
- Flag-off behavior must not read a sidecar, call a route resolver, change the legacy first-eight palette, or change render output.
- Any missing node, endpoint zone, malformed sidecar, or unsupported version disables the whole Fantasy graph and falls back to legacy behavior.
- Keep relations out of `BackgroundAsset`; infer the single route from consecutive slugs instead of asking the LLM for `route_id`.
- Exact `center_pct` is authoritative for hero origin and iris center; `screen_zone` is only a left/right fallback and `center` is valid.
- Apply entrance motion only to the real story hero, never the journey fallback friend.
- Do not add a forced end-of-scene exit tween.
- Commit the reviewed structural sidecar before asset generation, but do not append connector ownership slugs or expect active-manifest graph validation until all three assets are registered.

---
## Task 1: Typed graph contract and default-off flag

**Files:**

- Create: `backend/engine/world_graphs.py`
- Create: `backend/engine/world_graphs/fantasy_kingdom.json`
- Create: `tests/engine_v5/test_world_graphs_v5.py`
- Modify: `backend/engine/config.py`
- Modify: `tests/engine_v5/conftest.py`

- [ ] Add synthetic-sidecar tests for flag-off no-read behavior, stable node/neighbor order, forward and reversed lookup, endpoint swapping, duplicate nodes/route IDs/directed pairs, self-routes, unknown or disconnected nodes, required explicit `bidirectional`, version rejection, percentage bounds, every `ScreenZone` including `center`, missing manifest assets/zones, and missing/malformed file fail-open logging.

- [ ] Run the focused test and confirm `ModuleNotFoundError: backend.engine.world_graphs`.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_world_graphs_v5.py -q
```

- [ ] Add `WORLD_GRAPH_ENABLED = _env_flag("ENGINE_V5_WORLD_GRAPH", False)` beside `WORLDS_ENABLED`.

- [ ] Implement immutable `RouteEndpoint`, `RouteSpec`, `DirectedRoute`, and `WorldGraph` types. Use Pydantic `extra="forbid"`, `Literal[1]`, aliased `from`/`to`, an explicit bool without a default, and percentage validation inside `0..100`.

```python
@dataclass(frozen=True)
class DirectedRoute:
    route_id: str
    from_slug: str
    to_slug: str
    relation: str
    exit: RouteEndpoint
    entry: RouteEndpoint
```

- [ ] Expose manifest-aware `graph_for`, `route_between`, `graph_backgrounds`, `neighbors`, and `graph_prompt_text` functions plus a monkeypatchable sidecar-path seam. Validate endpoint zones against their assets, swap endpoints on reverse lookup, cache only validated results, and provide a test cache-clear seam.
- [ ] Author the reviewed 11-node, 13-route structural sidecar now so the asset endpoint audit has a hash-bound input. Test topology without an active manifest; `graph_for` must still fail open until the three connector assets exist.


- [ ] Force the flag false in the shared fixture, rerun, and commit.

```powershell
git add backend/engine/config.py backend/engine/world_graphs.py backend/engine/world_graphs/fantasy_kingdom.json tests/engine_v5/conftest.py tests/engine_v5/test_world_graphs_v5.py
git commit -m "feat: add fail-open world graph loader"
```

---

## Task 2: Graph palette and adjacency in Fantasy prompts

**Files:**

- Modify: `backend/engine/worlds.py`
- Modify: `backend/engine/agent/prompts/fantasy_storyteller.md`
- Modify: `backend/engine/agent/prompts/__init__.py`
- Modify: `backend/engine/agent/generate.py`
- Modify: `tests/engine_v5/test_worlds_v5.py`
- Modify: `tests/engine_v5/test_prompt_profiles.py`

- [ ] Test all graph nodes in sidecar order without the legacy cap, deterministic adjacency, exact legacy fallback, and graph-specific Fantasy prompt substitution. Update prompt test doubles to accept `manifest=None`.

- [ ] Confirm failures for capped output, absent adjacency, or the new manifest argument.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_worlds_v5.py `
  tests\engine_v5\test_prompt_profiles.py `
  -k "graph or fantasy_system_prompt or passes_prompt_profile" -q
```

- [ ] In `real_backgrounds`, return all nodes only when `graph_backgrounds(world_id, manifest)` succeeds; otherwise execute the existing body unchanged.

- [ ] Render compact context listing each node's neighbors and the rule to collapse repeats, use 3-6 nodes, and never revisit a departed node.

- [ ] Replace the Fantasy hardcoded block with `<<FANTASY_BACKGROUND_RULES>>`, retaining a byte-for-byte legacy replacement. Add `manifest: AssetManifest | None = None` to `system_prompt` and pass the already-loaded manifest from `generate.py`.

- [ ] Rerun and commit.

```powershell
git add backend/engine/worlds.py backend/engine/agent/prompts/fantasy_storyteller.md backend/engine/agent/prompts/__init__.py backend/engine/agent/generate.py tests/engine_v5/test_worlds_v5.py tests/engine_v5/test_prompt_profiles.py
git commit -m "feat: expose fantasy graph palette to authoring"
```

---

## Task 3: Repairable authoring validation

**Files:**

- Modify: `backend/engine/agent/authoring.py`
- Modify: `tests/engine_v5/test_worlds_v5.py`

- [ ] Add tests for shuffled scenes, a valid path, repeats, unknown graph setting, disconnected edge, compressed length outside 3-6, and revisit. Assert codes `background_not_in_world_graph`, `disconnected_background_route`, `world_graph_path_length`, and `revisited_background_node`.

- [ ] Confirm focused failures before implementation.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_worlds_v5.py `
  -k graph_authoring -q
```

- [ ] Pass the manifest into `_world_checks`; preserve the current legacy branch when no graph is active. Before calling any helper that truncates settings, construct a complete `raw_slug_for_setting_id` map from every dictionary in `payload["settings"]`. Resolve the sorted raw scene sequence through that full map, collapse consecutive equal slugs, then validate membership, length, revisit, and each adjacent edge.

- [ ] Include valid neighbors in disconnected-route diagnostics. Preserve dirty journey extraction, camera coercion, and `journey=` propagation during reconciliation.

- [ ] Rerun and commit.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_worlds_v5.py `
  tests\engine_v5\test_agent_authoring.py -q
git add backend/engine/agent/authoring.py tests/engine_v5/test_worlds_v5.py
git commit -m "feat: validate fantasy story paths against graph"
```

---
## Task 4: Legacy-safe route staging metadata

**Files:**

- Modify: `backend/engine/schemas/staging.py`
- Modify: `backend/engine/staging.py`
- Modify: `tests/engine_v5/test_staging_v5.py`

- [ ] Add tests for left/right screen-zone fallback mapping, valid `center` returning no side, and loading old run JSON without route fields.

- [ ] Confirm failures for the absent helper and fields.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_staging_v5.py -q
```

- [ ] Add only defaulted fields to `SceneStaging`:

```python
incoming_route_id: str | None = None
outgoing_route_id: str | None = None
hero_exit_side: Literal["left", "right"] | None = None
hero_route_origin_pct: tuple[float, float] | None = None
```

Keep the existing `hero_entrance_side` and its default. Map left zones to `left`, right zones to `right`, and `center` to `None`.

- [ ] Verify old payloads still validate and commit.

```powershell
git add backend/engine/schemas/staging.py backend/engine/staging.py tests/engine_v5/test_staging_v5.py
git commit -m "feat: add optional route staging metadata"
```

---

## Task 5: Resolve direct scene boundaries in the runner

**Files:**

- Modify: `backend/engine/orchestrator/runner.py`
- Create: `tests/engine_v5/test_runner_routes_v5.py`

- [ ] Test sorted scene order, `A,B,B,C` boundaries, setting IDs deliberately different from background slugs, first/last behavior, flag-off zero resolver calls, missing-route fallback, exact entry/exit centers, and persistence into copied staging.

- [ ] Confirm red failure because `_route_contexts_for_scenes` does not exist.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_runner_routes_v5.py -q
```

- [ ] Add an immutable internal `_SceneRouteContext` with defaulted incoming/outgoing route IDs, entrance/exit side fallbacks, `hero_route_origin_pct`, and separate transition centers.

- [ ] Resolve each background as `cast[plans[scene_id].setting_id].slug`, then inspect only adjacent sorted scene IDs. Skip same-slug pairs. For `A,A,B`, only the second `A` gets outgoing route data. First scene has no incoming route; last has no outgoing route.

- [ ] Assign `entry.center_pct` to the destination hero origin and opening iris; assign `exit.center_pct` to the current scene closing iris. Derive sides only as fallbacks.

- [ ] Keep route resolution independent of `STAGING_BIBLE_ENABLED`, pass metadata directly to compilation, and persist it when staging exists.

- [ ] Rerun and commit.

```powershell
git add backend/engine/orchestrator/runner.py tests/engine_v5/test_runner_routes_v5.py
git commit -m "feat: resolve fantasy routes at scene boundaries"
```

---

## Task 6: Start the real hero at the route landmark

**Files:**

- Modify: `backend/engine/render/compile.py`
- Modify: `tests/engine_v5/test_compile_v5.py`

- [ ] Add tests that route metadata reaches `RenderInput`, exact origin overrides side fallback, right-origin motion survives backstep cancellation, an `idle` or `wave` first hero row still receives a prepended walking entrance, only the real story hero gets route motion, `journey=True` suppresses route entry, absent route args equal legacy output, and exit metadata adds no tween.

- [ ] Confirm `compile_scene() got an unexpected keyword argument 'incoming_route_id'`.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_compile_v5.py `
  -k "route or entrance or backstep or carry" -q
```

- [ ] Add optional keyword arguments, all defaulting to `None`:

```python
incoming_route_id: str | None = None
outgoing_route_id: str | None = None
hero_entrance_side: Literal["left", "right"] | None = None
hero_exit_side: Literal["left", "right"] | None = None
hero_route_origin_pct: tuple[float, float] | None = None
transition_in_center_pct: tuple[float, float] | None = None
transition_out_center_pct: tuple[float, float] | None = None
```

- [ ] Clamp exact origin to configured walk bounds and prepend a locomotion segment from it to normal staging on the first actual hero row, even when that row's authored action is `idle`, `wave`, or another non-locomotion action. The entrance segment uses a walking pose; after arrival, the authored action resumes unchanged. If exact origin is absent, use side fallback; if both are absent, preserve the current left-entry algorithm exactly.

- [ ] Mark explicit route entrance motion so the small-backstep cancellation cannot remove a valid right-to-left walk. Do not alter cancellation for ordinary motion.

- [ ] Keep story hero identity separate from the journey fallback hero. When `journey=True`, the treadmill composition wins: keep the journey hero centered and suppress route-origin movement while retaining route IDs/iris metadata. Preserve the dirty journey signature, actor selection, `_apply_window`, and related blocks during reconciliation.

- [ ] Rerun compile and journey tests, then commit.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_compile_v5.py `
  tests\engine_v5\test_journey_v5.py -q
git add backend/engine/render/compile.py tests/engine_v5/test_compile_v5.py
git commit -m "feat: animate hero entrances from route landmarks"
```

---
## Task 7: Independent opening and closing iris centers

**Files:**

- Modify: `backend/video/types.py`
- Modify: `backend/video/compositor.py`
- Modify: `tests/video/test_iris_transition.py`
- Modify: `tests/engine_v5/test_iris_every_scene_v5.py`

- [ ] Add default-compatibility tests and capture distinct iris centers. On a `120x80` frame, `(20,30)` must map to `(24,24)` and `(80,60)` to `(96,48)`.

- [ ] Confirm red failure because `RenderInput` rejects the route center fields.

- [ ] Append all route metadata to `RenderInput` with `None` defaults, preserving every direct constructor including math-tutor and intro paths.

- [ ] Convert incoming and outgoing percentages independently to pixels. Each falls back to the existing hero center, and metadata is inert when its corresponding transition is absent.

- [ ] Run iris suites and commit.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\video\test_iris_transition.py `
  tests\engine_v5\test_iris_every_scene_v5.py -q
git add backend/video/types.py backend/video/compositor.py tests/video/test_iris_transition.py tests/engine_v5/test_iris_every_scene_v5.py
git commit -m "feat: center irises on route endpoints"
```

---

## Task 8: Activate the production Fantasy graph after asset registration

**Files:**

- Modify if selected connector coordinates moved: `backend/engine/world_graphs/fantasy_kingdom.json`
- Modify: `backend/engine/worlds.py`
- Modify: `tests/engine_v5/test_world_graphs_v5.py`

- [ ] Confirm all three connector slugs exist in the active manifest, expose reviewed zones, and are remotely retrievable.

- [ ] Append, without reordering the current tuple, `fk_castle_crossroads_live`, `fk_castle_grand_hall_live`, and `fk_castle_cloister_live` to Fantasy ownership. Appending preserves the disabled first-eight result.

- [ ] Recheck the structural sidecar against the selected connector plates. If an exact generated-node coordinate moved, update the design matrix and sidecar together without changing route identity or endpoint ordering.

- [ ] Run structural invariants again, then add active-manifest assertions that all 11 nodes and every endpoint zone resolve while connector degrees remain 4/5/4 and all 26 directed pairs remain unique.

- [ ] Run the sidecar gate and commit.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5\test_world_graphs_v5.py `
  -k fantasy_sidecar -q
git add backend/engine/world_graphs/fantasy_kingdom.json backend/engine/worlds.py tests/engine_v5/test_world_graphs_v5.py
git commit -m "feat: activate fantasy kingdom route graph"
```

---

## Task 9: Regression, graph-on samples, and reconciliation

- [ ] Run all focused graph/runtime tests.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider `
  tests\engine_v5\test_world_graphs_v5.py `
  tests\engine_v5\test_worlds_v5.py `
  tests\engine_v5\test_prompt_profiles.py `
  tests\engine_v5\test_agent_authoring.py `
  tests\engine_v5\test_staging_v5.py `
  tests\engine_v5\test_runner_routes_v5.py `
  tests\engine_v5\test_compile_v5.py `
  tests\video\test_iris_transition.py `
  tests\engine_v5\test_iris_every_scene_v5.py -q
```

- [ ] Run full regression with the graph disabled.

```powershell
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\engine_v5 -q
& C:\Users\Claude2\Desktop\Projects\story-gen-exps\.venv\Scripts\python.exe `
  -m pytest -p no:cacheprovider tests\video -q
```

- [ ] In a fresh process with `ENGINE_V5_WORLD_GRAPH=true`, generate ten Fantasy samples. Require 100% valid adjacency, 3-6-node simple paths, and at least five distinct compressed slug sequences.

- [ ] Render one center-door and one side-route sequence. Inspect exact route-origin movement and different opening/closing iris centers.

- [ ] Reconcile onto the user's dirty tree with a surgical three-way review. Run `git diff --check` and journey tests, then request code review before integration.

## References

- Approved design: `docs/superpowers/specs/2026-07-16-fantasy-relation-background-pilot-design.md`
- Asset plan: `docs/superpowers/plans/2026-07-16-fantasy-relation-livebg-assets.md`
