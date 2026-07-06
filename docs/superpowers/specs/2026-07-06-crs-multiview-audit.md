# CRS multi-view mixed-projection audit

**Date:** 2026-07-06 · **Branch:** feat/crs-mapview

Pre-upstream-PR risk item: deck.gl renders multiple `View`s in one `Deck`, and layers are shared
across views — each layer is drawn once per view, with that view's own viewport. The CRS work
introduced viewport-dependent layer behavior (tileset class selection, decode routing,
zoom-dependent style evaluation). This audits what happens when the SAME layer instance is
rendered into both a Mercator view and a CRS view in the same `Deck`.

## Architecture fact underlying every scenario below

Sublayer *generation* (`CompositeLayer.renderLayers()`/`renderSubLayers()`, `TileLayer`'s tileset
selection/class resolution, `getTileData()`) runs once per `layerManager.updateLayers()` cycle
(`layer-manager.ts`), using whatever `context.viewport` happens to hold — a single mutable field
(`layer-manager.ts#activateViewport`) shared by every view. It is **not** re-run once per drawn
viewport. `composite-layer.ts` documents this distinction itself: "draw can be called without
calling updateState (e.g. most viewport changes), while renderLayers can only be called during a
recursive layer update."

Actual GPU draw (`layers-pass.ts#_drawLayers`) *does* correctly loop over every viewport each
frame and re-activate `context.viewport` before drawing each one, rebinding the `project` shader
module's uniforms per viewport. This is why plain geometry layers (scenario 4) are fine: their
vertex projection is redone, correctly, per viewport, every draw. It's specifically layers whose
*sublayer generation* depends on the viewport (not just per-vertex projection) that are exposed:
whichever view's viewport is `context.viewport` at the one `updateLayers()` call this frame is the
only view whose needs get reflected in what's generated; every other view sharing the layer
receives the same, unchanged, sublayers.

`context.viewport` at any given `updateLayers()` call is, in practice, whichever view was drawn
*last* in the previous frame (the draw loop activates each viewport in `views` order and never
resets afterward) — stable frame-to-frame for a fixed `views` array, i.e. not visible thrashing
under normal operation, just a durable, silent bias toward one view.

## Verdicts

| Scenario | Verdict | Root cause / notes |
| --- | --- | --- |
| 1a. Shared `MVTLayer`, `state.binary` frozen at init | **Broken — fixed** | `initializeState()` derives `binary` from `usesFeatureRoute(context.viewport)` once, never revisited. |
| 1b. Shared `MVTLayer`/`TileLayer` (no `tileMatrixSet`), tile selection | **Broken — documented limitation** | Tileset region/zoom selection uses only the one shared viewport; no clean fix without per-view layer instancing. |
| 2. Shared `_WarpedTileLayer` / `MercatorCRSTileset2D` / `_CRSTileset2D` | **Fails loudly and safely — no fix needed** | Existing `requires a CRS view` guard throws an actionable error, isolated per-layer. |
| 3. Shared `_MapLibreStyleLayer`, zoom-bucket cache | **Broken — documented limitation** | `mercatorEquivalentZoom(context.viewport)` computed once per update; CRS/Mercator answers can differ by 5+ zoom levels. |
| 4. Shared plain `GeoJsonLayer` (baseline) | **Works — confirmed** | No `context.viewport` read outside per-vertex GPU projection. |
| 5. Bearing/pitch independence, picking | **Works — confirmed by architecture** | `ViewManager` keeps per-view `viewState`/`Viewport`/`Controller`; `DeckPicker` reuses the same correctly-per-viewport draw-loop machinery as scenario 4. |

## Scenario 1: shared `MVTLayer`/`TileLayer`

### 1a. `state.binary` frozen at init — broken, fixed

`mvt-layer.ts`'s `initializeState()`:

```ts
const binary = usesFeatureRoute(this.context.viewport) ? false : this.props.binary;
```

runs exactly once, at layer construction. `mvt-viewport-mode.ts`'s own doc comment on
`usesFeatureRoute` explains why this matters: "GlobeView/CRS views don't work well with binary
data". If the layer happens to initialize while `context.viewport` is a plain Mercator viewport
(`binary` stays `true`, the default) and is later updated/drawn while serving a CRS view — a live
`crs` swap on the same `MapView`, or (against the guidance this audit reinforces) genuinely
sharing the instance across two views — `state.binary` never gets revisited. Tile requests then
ask for `shape: 'binary'` while `getTileData()` independently asks for `coordinates: 'wgs84'`
(also keyed off `context.viewport`, read at a different call site and a different point in time)
— exactly the combination that doesn't work.

**Fix** (`modules/geo-layers/src/mvt-layer/mvt-layer.ts`, `updateState()`): recompute the desired
`binary` value on every update, mirroring the pattern the base `TileLayer` already uses to
recreate its tileset when `_getTilesetClass()`'s answer changes:

```ts
const desiredBinary = usesFeatureRoute(context.viewport) ? false : props.binary;
if (this.state.binary !== desiredBinary) {
  this.setState({binary: desiredBinary});
  this.state.tileset?.reloadAll();
}
```

`reloadAll()` forces previously-cached tile content (decoded under the old, now-wrong,
shape/coordinates combination) to refetch. This is a narrow, contained, no-architecture-needed
fix — it does not depend on knowing whether the layer is genuinely shared across views or just
live-swapped in one; both hit the same staleness.

Red-before/green-after test:
`test/modules/geo-layers/mvt-layer/mvt-layer-multi-view.spec.ts` — an `MVTLayer` initialized under
a Mercator viewport (`binary: true`), then updated against a CRS viewport (must flip to `false`),
then back to Mercator (must restore the prop default `true`). Confirmed red (asserted `false`,
observed `true`) before the fix; green after.

### 1b. Tile selection region/class for the non-active view — broken, documented (not fixed)

Independent of 1a: `TileLayer._updateTileset()` calls `tileset.update(this.context.viewport, ...)`
— the tileset's *selected tiles* (which geographic region, which zoom level) are computed once,
for whichever viewport is currently shared/active. If an `MVTLayer` (no `tileMatrixSet`) is
shared across a Mercator view and a CRS view, `_getTilesetClass()`
(`this.context.viewport.projectionMode === PROJECTION_MODE.CRS ? MercatorCRSTileset2D :
Tileset2D`) also resolves differently per view — but since there is only one `state.tileset`,
whichever class/region was resolved for the last-active view is what both views receive tiles
from. The other view silently gets tiles selected for the wrong camera/zoom (and, if the *class*
itself differs, may be looking at a tileset built for an entirely different tile-indexing scheme).

**Not fixed.** A clean fix requires either (a) per-view layer/tileset instancing (the "real
architecture" escape hatch — this is exactly the deck.gl-wide multi-view sharing model, not a
CRS-only problem, and is out of scope for a contained fix here), or (b) a runtime detector — which
we deliberately did not build. A `context.viewport`-based single-frame check cannot reliably tell
"this layer is shared across two `View`s" from "this view's own camera just changed" (both look
identical from inside `updateState()`), and a `deck.getViewports()`-based check ("are there
multiple currently-configured viewports with different projections?") would false-positive on the
*correct*, documented pattern (duplicate layer instances + `layerFilter`, where each instance only
actually draws in one view) — which would violate the audit's own bar of a detector being a
*clear*, not noisy/misleading, failure. **Documented** instead, generalizing the pre-existing
`docs/developer-guide/views.md` "don't share tile layers across views" guidance to explicitly call
out the CRS-specific failure mode (see Docs below) — this is not a new category of hazard the CRS
branch introduces, but it does make the existing, already-documented hazard concretely worse
(wrong tile-indexing scheme, not just "stale region/zoom").

Plain `TileLayer` with a fixed `tileMatrixSet` (CRS-native tiling, not routed through
`_getTilesetClass()`'s projectionMode branch) doesn't have the *class*-mismatch half of this, but
does still have the region-selection half — its `CRSTileset2D` resolves the same "requires a CRS
view" guard as scenario 2 when the shared context lands on a non-CRS viewport, so that combination
actually fails loudly (see scenario 2) rather than silently.

## Scenario 2: shared `_WarpedTileLayer` / `_CRSTileset2D` — fails loudly, no fix needed

Initial hypothesis (from `renderSubLayers()` alone, which returns `null` when
`(this.context.viewport as any).crs` is absent) was silent dropout or stale-sublayer reuse.
Probing it directly (`test/modules/geo-layers/warped-tile-layer/warped-tile-layer-multi-view.spec.ts`)
shows better-than-hypothesized behavior: `MercatorCRSTileset2D.getTileIndices()`
(`mercator-crs-tileset-2d.ts:58-63`) — called from `_updateTileset()` every update cycle,
regardless of whether new tiles are needed — throws:

```
_WarpedTileLayer requires a CRS view — set the `crs` prop on MapView (use TileLayer in Web Mercator views)
```

the moment `context.viewport` lacks `.crs`. `layer-manager.ts`'s `_handleError` catches this
per-layer (`layer.raiseError()`), so it does not crash the rest of the scene or the other view's
other layers — this one shared layer just stops updating (in whichever view doesn't currently
have a CRS) until the shared context swings back. `_CRSTileset2D` (`crs-tileset-2d.ts:76`, used by
plain `TileLayer`/`MVTLayer` with `tileMatrixSet` set) has the identical guard.

This already **is** the audit's acceptable-v1 bar — "a layer can't be shared across mixed
projections, detect and warn/throw clearly" — pre-existing in the codebase. No fix implemented.
One caveat documented, not fixed: the error is not latched/deduped, so it can re-fire on every
subsequent update cycle for as long as the mismatch persists (e.g. while a user is actively
panning one of the views) — console-noise, not correctness, follow-up.

## Scenario 3: shared `_MapLibreStyleLayer` — broken, documented (not fixed)

`maplibre-style-layer.ts:304`, inside `renderLayers()`:

```ts
const zoom = mercatorEquivalentZoom(this.context.viewport);
```

feeds both (a) zoom-dependent style-expression evaluation and `minzoom`/`maxzoom` gating, and (b)
half of the per-`(tile, style-layer)` memoized sublayer cache key (`zoomBucket(zoom)`, the Round 8
bucket-crossing-regen perf fix). Computed once per update, shared by every view drawing the layer.

`style-eval-zoom.ts`'s own doc comment quantifies the CRS/Mercator zoom-numbering gap: a UTM zone
reaches the same zoom *number* at a far more zoomed-in ground scale than Web Mercator's whole
world — concretely **>5 zoom levels** at UTM 18N, lat 40. `test/modules/geo-layers/maplibre-style-layer/style-eval-zoom.node.spec.ts` adds a test pinning this from the multi-view angle
directly: a `WebMercatorViewport` and a same-nominal-`zoom: 7` `_CRSViewport` (UTM 18N) resolve to
`mercatorEquivalentZoom` values of `7` and `~12.52` — different `zoomBucket`s. If these two views
shared one `_MapLibreStyleLayer` instance, whichever isn't "active" when `renderLayers()` runs
gets label/line/fill styling and `minzoom`/`maxzoom` gating evaluated (and cached) for the wrong
view's ground scale.

**Not fixed**, for the same reason as 1b: no clean per-view-instancing-free fix exists, and a
runtime detector risks false-positiving on the correct duplicate-instance pattern. Documented in
`crs-viewport.md`'s new Multi-view subsection alongside 1b and 2.

## Scenario 4: shared plain `GeoJsonLayer` — baseline, confirmed working

`geojson-layer.ts`'s `updateState()`, and the plain sublayers it composes (`path-layer.ts`,
`solid-polygon-layer.ts`, `scatterplot-layer.ts`, ...), never read `this.context.viewport` to
decide what to build. The one `this.context.viewport.resolution` read present in this family
(`bitmap-layer.ts`, `path-layer.ts`, `solid-polygon-layer.ts`) is a GlobeView-only signal — `undefined`
for both a `WebMercatorViewport` and a `_CRSViewport` alike, so it cannot diverge between the two
view types audited here (a separate, pre-existing, out-of-scope Globe-multi-view question, not
raised by this audit and not chased further). `test/modules/geo-layers/geojson-layer-multi-view.spec.ts` confirms a `GeoJsonLayer` instance updates cleanly, with sublayers intact and no errors,
when swapped Mercator → CRS → Mercator. This is the control that proves shared layers are
fundamentally fine by construction — the hazard is specific to layers whose sublayer *generation*
(not just per-vertex projection) depends on the viewport.

## Scenario 5: bearing/pitch independence, picking — confirmed working by architecture

`view-manager.ts` keeps `viewState` (via `getViewState(view)`, matched by `view.viewStateId`/
`view.id`), `Viewport` (`_viewportMap`, built fresh per view every `_rebuildViewports()`), and
`Controller` (`this.controllers[view.id]`) all independently per view — there is no
`context.viewport`-style single shared slot at this layer of the architecture. Each view's
`bearing`/`pitch` feeds into that view's own `Viewport` construction only; mixing a Mercator view
and a CRS view with different camera angles is just two independent `Viewport` objects, same as
any other multi-view setup (already exercised repeatedly by prior CRS phases in single-view
tests, e.g. Phase 4's pitch+bearing terrain verification).

`deck-picker.ts` (`DeckPicker`) reuses `LayersPass`'s same per-viewport loop
(`onViewportActive`/`viewports`) as the regular draw pass — the mechanism scenario 4 already
confirms is per-viewport-correct — so picking coordinates and hit-testing are resolved against
the correct view's viewport (`getLastPickedObject` explicitly looks up `viewports.find(v => v.id
=== lastPickedViewportId)`). Picking would only inherit a wrong result if the layer *itself*
rendered wrong content for that view (scenarios 1b/3's already-documented hazard) — not an
additional, independent picking-specific failure mode. No new test added; confirmed by
architecture reading plus the pre-existing view-manager/picking test suites (`test/modules/core/
views/view-manager.spec.ts`, `test/modules/core/lib/deck-picker.spec.ts`).

## Files

* Fix: `modules/geo-layers/src/mvt-layer/mvt-layer.ts` (`updateState()`, `state.binary`
  re-derivation).
* New tests:
  * `test/modules/geo-layers/mvt-layer/mvt-layer-multi-view.spec.ts` (scenario 1a, red-before/
    green-after).
  * `test/modules/geo-layers/warped-tile-layer/warped-tile-layer-multi-view.spec.ts` (scenario 2).
  * `test/modules/geo-layers/maplibre-style-layer/style-eval-zoom.node.spec.ts` (scenario 3,
    appended test).
  * `test/modules/geo-layers/geojson-layer-multi-view.spec.ts` (scenario 4, baseline).
* Docs: `docs/api-reference/core/crs-viewport.md` (new "Multi-view" Limitations subsection),
  `docs/api-reference/core/map-view.md` (cross-reference in the `crs` section),
  `docs/developer-guide/views.md` (CRS cross-reference added to the existing "Rendering Layers in
  Multiple Views" guidance).

## Gates

Node core+geo-layers+layers: 227/227 passed. Headless: 792 passed / 2 known-pre-existing flakes
(`test/modules/react/deckgl.spec.ts` mount/unmount timeout, `test/modules/widgets/loading-widget.spec.ts`
spinner — both documented repeatedly elsewhere in `.superpowers/sdd/progress.md` as pre-existing/
environmental, unrelated to this change) / 8 skipped. `tsc --noEmit -p modules/core/tsconfig.json`
clean. `tsc --noEmit -p modules/geo-layers/tsconfig.json`: 7 pre-existing errors, all in files this
change did not touch (`crs-tileset-2d.ts`, `mercator-crs-tileset-2d.ts`, `warped-tile-layer.ts` —
the same stale-dist/prop-typing cascade noted repeatedly elsewhere in `progress.md`), none
referencing `mvt-layer.ts`. `eslint` on the changed source file: 0 errors/warnings. `prettier
--check` on all changed/new files: clean.

## Judgment call: does this block the upstream PR?

No. Scenario 2 already fails loudly by design (pre-existing). Scenario 1a was a genuine, narrow,
now-fixed bug. Scenarios 1b and 3 are real, but they are a CRS-specific *amplification* of an
already-documented, pre-existing, deck.gl-wide architectural limitation (sharing viewport-reactive
composite layers — `TileLayer`, `MVTLayer`, `HeatmapLayer`, `ScreenGridLayer` — across views), not
a new category of failure the CRS branch introduces from nothing. The honest, contained resolution
for that pre-existing class of problem is the same one upstream already recommends: don't share
these layer instances across views; duplicate + `layerFilter`. Fixing the *general* case (making
sublayer generation per-viewport) is real architecture, tracked as future-work for the upstream
RFC.
