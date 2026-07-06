# CRS MVT + MapLibre Style Adapter (Chunk E1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage 1 — `MVTLayer` renders vector-tile geometry correctly inside a non-Mercator CRS `MapView`, by generalizing the existing `GlobeView`-only `wgs84`/non-binary/no-`ClipExtension` code path to also cover `PROJECTION_MODE.CRS`, and relying on `_CRSTileset2D` (already reachable via the inherited `tileMatrixSet` prop) for tile selection. Stage 2 — a new experimental `_MapLibreStyleLayer` composite converts a MapLibre style JSON + a vector tile source into styled deck.gl layers, with the MapLibre style-spec expression/filter evaluator injected by the caller (zero new runtime dependency). Spec: `docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md`.

**Architecture:** Stage 1 touches only `modules/geo-layers/src/mvt-layer/mvt-layer.ts`: a single new predicate (`usesFeatureRoute`) replaces four independent `viewport.resolution` checks, extending a code path Globe mode already exercises today — no new tileset-selection code (Phase 2's `TileLayer._getTilesetClass()` already promotes to `_CRSTileset2D` whenever `tileMatrixSet` is set, for any `TileLayer` subclass). Stage 2 is new: `modules/geo-layers/src/maplibre-style-layer/`, a `CompositeLayer` (`MapLibreStyleLayer`, exported as `_MapLibreStyleLayer`) that pre-compiles each MapLibre style layer's `filter`/paint/layout expressions once (via an injected `MapLibreStyleEvaluator`) into deck.gl accessor closures, then renders one `MVTLayer` (Stage-1-CRS-aware) per unique vector source with a `renderSubLayers` override that fans each tile's parsed content out into one mapped deck.gl layer per matching style layer, in style order.

**Tech Stack:** TypeScript, Vitest (`node` for pure compilation/mapping logic, `headless` for layer lifecycle), `@deck.gl/geo-layers` (`MVTLayer`, `TileLayer`, `_CRSTileset2D`), `@deck.gl/layers` (`GeoJsonLayer`, `IconLayer`, `TextLayer`, `SolidPolygonLayer`), `@deck.gl/extensions` (`PathStyleExtension`, `CollisionFilterExtension`, `ClipExtension`), `@maplibre/maplibre-gl-style-spec` (root devDependency only, used by tests and by consuming apps — never a `@deck.gl/geo-layers` runtime dependency).

## Global Constraints

- Repo: `/Users/adamthomann/dev/deck.gl`, branch `feat/crs-mapview`. All paths relative to repo root.
- **No new runtime dependencies in any published `@deck.gl/*` package.** `@maplibre/maplibre-gl-style-spec` is added only as a root `package.json` devDependency (mirrors `@math.gl/proj4`, `package.json:54`) — used by `test/` fixtures/specs and documented as an app-supplied injection for real usage. `@deck.gl/geo-layers`'s own `package.json` `dependencies` must not gain this package.
- **Zero behavior change outside CRS views (Stage 1).** Classic Mercator (`binary: true`) and existing `GlobeView` (`wgs84`, `binary: false`) MVTLayer paths must be byte-identical after Stage 1 — regression-tested, not just re-reviewed.
- **Stage 1 does not touch tile-selection code.** `_CRSTileset2D` promotion is already generic (`TileLayer._getTilesetClass()`, `tile-layer.ts:275-281`); do not add a new `TilesetClass` default or override in `MVTLayer`.
- **Stage 2 module is additive only** — no existing file changes outside `modules/geo-layers/src/index.ts` (new exports) and docs.
- **Out of scope (do NOT implement):** binary-mode MVT in CRS views; `symbol-placement: 'line'` true curved labels (only the documented midpoint-approximation fallback); `line-gradient`, `fill-pattern`, `raster`/`hillshade`/`heatmap` style-layer types; glyph-PBF font parity; continuous (non-integer-zoom-bucketed) paint re-evaluation; far-field/adaptive tile LOD (Chunk B1, unrelated).
- License header on every new file:
  ```ts
  // deck.gl
  // SPDX-License-Identifier: MIT
  // Copyright (c) vis.gl contributors
  ```
- Run a single test file: `npx vitest run --project node <path>` (or `--project headless`). The node project only auto-discovers `test/modules/**/*.node.spec.ts`.
- Commit after every green test cycle; message style `feat(geo-layers): <summary>`. Prettier must pass (pre-commit hook enforces eslint + prettier + node vitest).
- Per-module `tsc` requires built dists (pre-existing TS6305 environment issue) — gates are eslint/prettier/vitest, as in Phases 2–4.

---

## Stage 1 — MVT in CRS views (Tasks 1–4; independently shippable — stop here to ship E1 as originally scoped)

### Task 1: Extract and generalize the wgs84/CRS route predicate

Replace the four independent `viewport.resolution !== undefined` checks in `mvt-layer.ts` with one shared, exported predicate that also recognizes `PROJECTION_MODE.CRS`. Pure logic, no rendering change yet for existing viewports (Globe's checks all evaluate identically before/after; this task only changes *how* the condition is spelled, plus adds the new CRS branch, inert until nothing else changes — this task alone is a no-op for every existing test since `PROJECTION_MODE.CRS` viewports don't yet reach `MVTLayer` in any existing test).

**Files:**
- Create: `modules/geo-layers/src/mvt-layer/mvt-viewport-mode.ts`
- Test: `test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts`
- Modify: `modules/geo-layers/src/mvt-layer/mvt-layer.ts` (call sites only; behavior for existing viewports unchanged)

**Interfaces:**
- Produces: `usesFeatureRoute(viewport: Viewport): boolean` — `true` for `GlobeViewport` (`viewport.resolution !== undefined`, unchanged today's signal) or any viewport whose `projectionMode === PROJECTION_MODE.CRS`; `false` otherwise (classic Mercator, non-geospatial).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport, _GlobeViewport as GlobeViewport, _CRSViewport as CRSViewport} from '@deck.gl/core';
import {usesFeatureRoute} from '@deck.gl/geo-layers/mvt-layer/mvt-viewport-mode';
import {UTM18N} from '../../core/viewports/crs-fixtures';

test('usesFeatureRoute#Mercator: false (unchanged binary/local/CARTESIAN route)', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  expect(usesFeatureRoute(viewport)).toBe(false);
});

test('usesFeatureRoute#Globe: true (regression — same signal Globe already uses)', () => {
  const viewport = new GlobeViewport({width: 800, height: 600});
  expect(usesFeatureRoute(viewport)).toBe(true);
});

test('usesFeatureRoute#CRS: true (new)', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10
  });
  expect(usesFeatureRoute(viewport)).toBe(true);
});

test('usesFeatureRoute#non-geospatial: false', () => {
  const fakeViewport = {resolution: undefined, projectionMode: 0} as any;
  expect(usesFeatureRoute(fakeViewport)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts`
Expected: FAIL — cannot resolve `@deck.gl/geo-layers/mvt-layer/mvt-viewport-mode`.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/mvt-layer/mvt-viewport-mode.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {PROJECTION_MODE, Viewport} from '@deck.gl/core';

/** True when `MVTLayer` should use the "feature route": tile-local coordinates decoded to
 * plain lnglat (loader `coordinates: 'wgs84'`), `binary` forced `false`, no Mercator
 * power-of-two `modelMatrix`/`CARTESIAN` sublayer transform, no `ClipExtension`. This is the
 * route `GlobeView` has used since MVTLayer added globe support (`viewport.resolution` is a
 * Globe-only signal) — CRS views need the identical route for the identical reason: neither
 * is a Mercator XYZ power-of-two tile pyramid, so the Mercator-specific sublayer transform
 * (`WORLD_SIZE / 2^z` scaling) does not apply, and both already have per-tile lnglat bounds
 * available (`GeoBoundingBox`) to decode against. See
 * `docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md`, Stage 1 Design. */
export function usesFeatureRoute(viewport: Viewport): boolean {
  return (
    (viewport as {resolution?: number}).resolution !== undefined ||
    viewport.projectionMode === PROJECTION_MODE.CRS
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `mvt-layer.ts`; regression**

Modify `modules/geo-layers/src/mvt-layer/mvt-layer.ts`:

```ts
// Add import alongside existing imports:
import {usesFeatureRoute} from './mvt-viewport-mode';

// initializeState (~line 130-131): replace
//   const binary = this.context.viewport.resolution !== undefined ? false : this.props.binary;
// with:
const binary = usesFeatureRoute(this.context.viewport) ? false : this.props.binary;

// getTileData (~line 236): replace
//   coordinates: this.context.viewport.resolution ? 'wgs84' : 'local',
// with:
coordinates: usesFeatureRoute(this.context.viewport) ? 'wgs84' : 'local',

// renderSubLayers (~line 268): replace
//   if (!this.context.viewport.resolution) {
// with:
if (!usesFeatureRoute(this.context.viewport)) {

// _isWGS84 (~line 313-315): replace
//   protected _isWGS84(): boolean {
//     return Boolean(this.context.viewport.resolution);
//   }
// with:
protected _isWGS84(): boolean {
  return usesFeatureRoute(this.context.viewport);
}
```

Run: `npx vitest run --project headless test/modules/geo-layers/mvt-layer.spec.ts && npx vitest run --project node test/modules/geo-layers/mvt-layer`
Expected: PASS — every existing assertion (Mercator, Globe) unchanged, since `usesFeatureRoute` evaluates identically to the old inline checks for every viewport type exercised today.

- [ ] **Step 6: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/mvt-layer/mvt-viewport-mode.ts modules/geo-layers/src/mvt-layer/mvt-layer.ts test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts
git add modules/geo-layers/src/mvt-layer/mvt-viewport-mode.ts modules/geo-layers/src/mvt-layer/mvt-layer.ts test/modules/geo-layers/mvt-layer/mvt-viewport-mode.node.spec.ts
git commit -m "feat(geo-layers): extract MVTLayer feature-route predicate, generalize to CRS"
```

---

### Task 2: `MVTLayer` in a CRS `MapView` — headless integration test

Prove Task 1's wiring actually produces correct tiling/positioning/mode selection end to end: `tileMatrixSet` + a CRS viewport selects `_CRSTileset2D`, forces `binary: false`, and the resulting sublayer is a plain lnglat `GeoJsonLayer` with no `ClipExtension`.

**Files:**
- Test: `test/modules/geo-layers/mvt-layer-crs.spec.ts` (headless; mirrors `test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts` and Phase 4's `terrain-layer-crs.spec.ts` pattern)
- Fixture: reuse `test/modules/geo-layers/tileset-2d/tms-fixtures.ts`'s `makeUTM18NTms`, `test/modules/core/viewports/crs-fixtures.ts`'s `UTM18N`, and existing MVT test data (`test/data/mvt-tiles/3/1/2.mvt` etc. — served via a fake `fetch` returning the fixture buffer, mirroring `test/modules/geo-layers/mvt-layer.spec.ts`'s own fixture-loading convention)

**Interfaces:**
- Consumes (Task 1): `usesFeatureRoute`. Consumes (Phase 2, already exported): `_CRSTileset2D`.
- Produces: no new exports; a regression/integration spec.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/mvt-layer-crs.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {MVTLayer, _CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';
import {GeoJsonLayer} from '@deck.gl/layers';
import {ClipExtension} from '@deck.gl/extensions';
import {makeUTM18NTms} from './tileset-2d/tms-fixtures';
import {UTM18N} from '../core/viewports/crs-fixtures';

test('MVTLayer#tileMatrixSet + CRS MapView selects _CRSTileset2D, forces binary:false, no ClipExtension', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const tileMatrixSet = makeUTM18NTms(6);

  const testCases = [
    {
      title: 'CRS-native MVT tiling',
      props: {
        data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        tileMatrixSet,
        binary: true // explicit default; must still be forced off for the CRS route
      },
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers[0].state.tileset).toBeInstanceOf(CRSTileset2D);
        expect(subLayers[0].props.binary).toBe(false);
      }
    }
  ];

  await testLayerAsync({
    Layer: MVTLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});

test('MVTLayer#renderSubLayers: CRS route sublayer has no ClipExtension, plain lnglat GeoJsonLayer defaults', () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const layer = new MVTLayer({
    data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
    tileMatrixSet: makeUTM18NTms(6)
  });
  // @ts-expect-error - accessing protected context for a unit-level render check
  layer.context = {viewport, layerManager: null, deck: null};
  const subLayers = (layer as any).renderSubLayers({
    id: 'test-tile',
    data: {},
    _offset: 0,
    tile: {index: {x: 0, y: 0, z: 0}, bbox: {west: -75, south: 39, east: -74, north: 40}}
  });
  const sub = Array.isArray(subLayers) ? subLayers[0] : subLayers;
  expect(sub.props.coordinateSystem).toBeUndefined(); // GeoJsonLayer default (LNGLAT), not CARTESIAN
  expect((sub.props.extensions || []).some((e: unknown) => e instanceof ClipExtension)).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/mvt-layer-crs.spec.ts`
Expected: FAIL before Task 1's wiring existed; PASS if Task 1 already landed correctly (this task is verification — if it fails after Task 1, investigate before proceeding: it means one of Task 1's four call sites was mis-wired).

- [ ] **Step 3: Fix any wiring gap found**

If Step 2 fails, re-check each of Task 1's four call sites against `mvt-layer.ts` — likely culprits: `getSubLayerPropsByTile`/`getHighlightedObjectIndex` still branching on the old `state.binary` flag in a way inconsistent with the new predicate (this method reads `this.state.binary`, already correctly forced by Task 1's `initializeState` change — no additional edit expected here, but confirm).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/mvt-layer-crs.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write test/modules/geo-layers/mvt-layer-crs.spec.ts
git add test/modules/geo-layers/mvt-layer-crs.spec.ts
git commit -m "test(geo-layers): verify MVTLayer CRS-view tiling, mode selection, no ClipExtension"
```

---

### Task 3: Unsupported-without-`tileMatrixSet` warning

When `projectionMode === PROJECTION_MODE.CRS` and no `tileMatrixSet` is set, `MVTLayer` should warn once rather than silently requesting nonsensical Mercator-XYZ tiles against CRS-native content (Non-goals: "explicitly unsupported, not silently wrong").

**Files:**
- Modify: `modules/geo-layers/src/mvt-layer/mvt-layer.ts`
- Test: `test/modules/geo-layers/mvt-layer-crs.spec.ts` (extend Task 2's file)

**Interfaces:**
- No new exports; adds one `log.warn` call inside `initializeState` (alongside the existing `log` import already used at `mvt-layer.ts:278`).

- [ ] **Step 1: Write the failing test**

Append to `test/modules/geo-layers/mvt-layer-crs.spec.ts`:

```ts
import {log} from '@deck.gl/core';

test('MVTLayer#CRS MapView without tileMatrixSet warns once', () => {
  const warnSpy = vi.spyOn(log, 'warn');
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const layer = new MVTLayer({data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'});
  // @ts-expect-error - unit-level context injection, mirrors the renderSubLayers test above
  layer.context = {viewport, layerManager: null, deck: null};
  (layer as any).initializeState();
  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining('tileMatrixSet')
  );
  warnSpy.mockRestore();
});
```

(Add `import {vi} from 'vitest';` to the file's existing `vitest` import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/mvt-layer-crs.spec.ts`
Expected: FAIL — no warning emitted today.

- [ ] **Step 3: Write the implementation**

Modify `initializeState` in `modules/geo-layers/src/mvt-layer/mvt-layer.ts`, immediately after the `binary` assignment from Task 1:

```ts
initializeState(): void {
  super.initializeState();
  const binary = usesFeatureRoute(this.context.viewport) ? false : this.props.binary;

  if (
    this.context.viewport.projectionMode === PROJECTION_MODE.CRS &&
    !this.props.tileMatrixSet
  ) {
    log.warn(
      `MVTLayer ${this.id}: CRS MapView without \`tileMatrixSet\` is unsupported — tiles ` +
        'will be requested using the Mercator XYZ scheme, which does not match a CRS-native ' +
        'source. Set `tileMatrixSet` (see docs/api-reference/geo-layers/mvt-layer.md#crs-views).'
    )();
  }

  this.setState({
    binary,
    // ...unchanged remainder of initializeState
  });
}
```

(Add `PROJECTION_MODE` to the file's existing `@deck.gl/core` import list.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/mvt-layer-crs.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Regression, prettier, commit**

```bash
npx vitest run --project headless test/modules/geo-layers/mvt-layer.spec.ts
npx prettier --config .prettierrc --write modules/geo-layers/src/mvt-layer/mvt-layer.ts test/modules/geo-layers/mvt-layer-crs.spec.ts
git add modules/geo-layers/src/mvt-layer/mvt-layer.ts test/modules/geo-layers/mvt-layer-crs.spec.ts
git commit -m "feat(geo-layers): warn once when MVTLayer is used in a CRS MapView without tileMatrixSet"
```

---

### Task 4: Stage 1 docs + roadmap correction + app verification

> **Post-review addendum (Finding 2, task-e1s1-fix):** as originally shipped, this task documented
> a `tileMatrixSet`-only story and a warn-once for the no-`tileMatrixSet` CRS case. Review found
> that gap unacceptable — the no-`tileMatrixSet` case is the *universal* real-world MVT source
> shape (Esri "Ocean Reference", most public MVT endpoints) — and it now has a real route
> (`MVTLayer._getTilesetClass()` selects `MercatorCRSTileset2D`, see the spec's Design and Goals
> #1b). `mvt-layer.md`, `crs-viewport.md`, and the app demo below are updated accordingly to
> describe/exercise **three** source cases: CRS-native (`tileMatrixSet` set) via `_CRSTileset2D`;
> Mercator-pyramid (no `tileMatrixSet`) via `MercatorCRSTileset2D`, automatic; classic Mercator
> `MapView` (unchanged). The steps below are left as originally written for history; the shipped
> docs reflect the addendum, not the original tileMatrixSet-only wording.

**Files:**
- Modify: `docs/api-reference/geo-layers/mvt-layer.md`
- Modify: `docs/api-reference/core/crs-viewport.md`
- Modify: `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`
- Modify: `docs/superpowers/specs/2026-07-05-crs-roadmap.md` (correct E1's tileset-class wording)
- Modify: `test/apps/crs-viewport/app.jsx`

- [ ] **Step 1: `mvt-layer.md`**

Add a `## CRS views` section (after the intro, mirroring Phase 4's `terrain-layer.md` addition):

```md
## CRS views

Vector tile content renders correctly inside a non-Mercator CRS
[`MapView`](../core/map-view.md#crs) when [`tileMatrixSet`](./tile-layer.md#tilematrixset) is
set — the same `_CRSTileset2D` indexing `TileLayer`/`TerrainLayer` already support. `MVTLayer`
automatically switches to the same tile-local-to-lnglat decode route (`coordinates: 'wgs84'`)
already used for `GlobeView`, and `binary` is forced to `false` (typed-array fast-path
allocation savings are not available in CRS or Globe views — see Performance below).

`tileMatrixSet` is required for CRS views: without it, `MVTLayer` logs a warning and falls back
to requesting tiles on the (meaningless, for CRS-native content) Mercator XYZ scheme.

### Performance

`binary: false` (forced) means each tile's features are allocated as plain GeoJSON objects
(`Feature[]`) rather than kept in typed arrays — the same cost `GlobeView` MVT users already
pay. For high-feature-density sources, budget for this allocation/GC cost; there is no v1
mitigation (a future binary-mode CRS/Globe path would need typed-array reprojection in the
loader itself).
```

- [ ] **Step 2: `crs-viewport.md`**

Replace the `MVTLayer`/`_WMSLayer` "not yet CRS-aware" line (`crs-viewport.md:260`) with:

```md
* **`MVTLayer`** renders CRS-native tiled vector sources (set
  [`tileMatrixSet`](../geo-layers/tile-layer.md#tilematrixset)) correctly in CRS views, via the
  same `wgs84`-decode route `GlobeView` already uses; the `binary` typed-array fast path is not
  available in CRS views (same cost already accepted for Globe).
* **`_WMSLayer`** is not yet CRS-aware.
```

- [ ] **Step 3: RFC future work**

In `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`'s "Future work" list, update the
`_WMSLayer`/`MVTLayer` line (`:193`) to:

```md
* **MVTLayer support** (implemented on this branch, Chunk E1): reuses the existing
  `GlobeView` wgs84-decode route, generalized to `PROJECTION_MODE.CRS`; `_CRSTileset2D`
  selection via the already-generic `tileMatrixSet` prop. `_WMSLayer` support remains future
  work.
```

- [ ] **Step 4: Roadmap wording correction**

In `docs/superpowers/specs/2026-07-05-crs-roadmap.md`, update the E1 bullet (`:50-51`) to:

```md
- **E1. MVT in CRS views** — wgs84-decode route (generalizing the existing GlobeView path) +
  `_CRSTileset2D` selection (already generic via `tileMatrixSet`, not `MercatorCRSTileset2D` —
  that class is Phase 3's raster-only warp mechanism); costs the binary fast path. Shipped —
  see `docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md`.
```

- [ ] **Step 5: App verification**

In `test/apps/crs-viewport/app.jsx`, add an `MVTLayer` option (with a small in-repo or public
CRS-native vector `tileMatrixSet` fixture, mirroring Phase 4's `TerrainLayer` demo addition) to
the UTM basemap selector, layered over the existing warped Esri Ocean basemap demo — this is
Stage 1's half of the Fathom acceptance scenario (Stage 2's task adds the styled version).

```bash
cd test/apps/crs-viewport && yarn && npx vite --config ../vite.config.local.mjs --host 0.0.0.0
```

Verify (screenshots into `.superpowers/sdd/`):
1. **UTM + CRS-native MVTLayer over warped raster basemap**: vector features (polygons/lines/points) register correctly against the raster basemap and graticule at multiple zooms; hover/`autoHighlight` works; no console errors except the expected `tileMatrixSet` warning is absent (since this demo sets it). Screenshot `task-e1-utm-mvt.png`.
2. **Mercator + Globe regression**: existing MVTLayer demos unaffected (quick re-check).

- [ ] **Step 6: Full suite, commit**

```bash
yarn test
git add docs/api-reference/geo-layers/mvt-layer.md docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md docs/superpowers/specs/2026-07-05-crs-roadmap.md test/apps/crs-viewport/app.jsx
git commit -m "docs(geo-layers): document CRS-view MVTLayer support, correct E1 roadmap wording"
```

---

## Stage 2 — MapLibre style-spec adapter (Tasks 5–13; depends on Stage 1 only in the acceptance-scenario demo, not in code)

> **Post-review addendum (Finding 2, task-e1s1-fix):** Stage 1's `MVTLayer` tile-selection now
> covers two source shapes — CRS-native (`tileMatrixSet` set, `_CRSTileset2D`) and Mercator-
> pyramid (no `tileMatrixSet`, auto-routed through `MercatorCRSTileset2D`). Tasks below that
> reference a vector source's `tileMatrixSet` (Task 5's `MapLibreVectorSource`, Task 13's
> acceptance-scenario demo) should keep it optional exactly as already drafted — `tileMatrixSet`
> unset is not a fallback/error case for the adapter's `MVTLayer` sublayer, it is the primary,
> more common case (Esri's real "Ocean Reference" service has no `tileMatrixSet`). No task
> bodies need structural changes; this note exists so an implementer does not "fix" the optional
> `tileMatrixSet?` as an oversight when Stage 2 work resumes.

### Task 5: Add `@maplibre/maplibre-gl-style-spec` devDependency; scaffold module + evaluator type

**Files:**
- Modify: root `package.json` (devDependency)
- Create: `modules/geo-layers/src/maplibre-style-layer/types.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts`

**Interfaces:**
- Produces: `MapLibreStyleEvaluator` (`{createPropertyExpression, featureFilter}`, structurally matching the real package's exports so the real package can be passed directly), `MapLibreVectorSource` (`{data: string; tileMatrixSet?: TileMatrixSet}`), `MapLibreStyleLayerProps` (`{style, source, evaluator, spriteAtlas?}`).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import * as styleSpec from '@maplibre/maplibre-gl-style-spec';
import type {MapLibreStyleEvaluator} from '@deck.gl/geo-layers/maplibre-style-layer/types';

test('the real @maplibre/maplibre-gl-style-spec package satisfies MapLibreStyleEvaluator structurally', () => {
  const evaluator: MapLibreStyleEvaluator = {
    createPropertyExpression: styleSpec.createPropertyExpression,
    featureFilter: styleSpec.featureFilter
  };
  expect(typeof evaluator.createPropertyExpression).toBe('function');
  expect(typeof evaluator.featureFilter).toBe('function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts`
Expected: FAIL — `@maplibre/maplibre-gl-style-spec` is not a resolvable devDependency yet (even though transitively present via `maplibre-gl`, it is not declared, so resolution should not be relied upon — add it explicitly first) and `.../types` does not exist.

- [ ] **Step 3: Add the devDependency and write the implementation**

```bash
# Root package.json devDependencies, alongside "@math.gl/proj4": "^4.1.0",
```

Add to root `package.json`'s `devDependencies` (pin the major used in this repo's transitive
copy for test determinism):

```json
"@maplibre/maplibre-gl-style-spec": "^24.3.1",
```

Create `modules/geo-layers/src/maplibre-style-layer/types.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileMatrixSet} from '../tileset-2d/tile-matrix-set';

/** The two `@maplibre/maplibre-gl-style-spec` entry points the adapter needs. Injected by the
 * caller — mirrors `CRSDefinition.transform` (`modules/core/src/viewports/crs-utils.ts:30-54`):
 * `@deck.gl/geo-layers` never imports `@maplibre/maplibre-gl-style-spec` itself, so it stays
 * free of the runtime dependency; pass the package's own exports directly (they satisfy this
 * interface structurally with zero adaptation — see the accompanying test). */
export interface MapLibreStyleEvaluator {
  createPropertyExpression: (
    value: unknown,
    propertySpec: unknown,
    globalState?: unknown
  ) => {value?: {kind: string; evaluate: (globals: unknown, feature?: unknown) => unknown}};
  featureFilter: (
    filter: unknown,
    globalState?: unknown
  ) => {filter: (globals: unknown, feature?: unknown) => boolean};
}

/** A single vector tile source: a `{z}/{x}/{y}` URL template plus optional CRS-native tiling
 * (Stage 1). Mirrors `MVTLayerProps`'s own `data`/`tileMatrixSet` shape. */
export interface MapLibreVectorSource {
  data: string;
  tileMatrixSet?: TileMatrixSet;
}

/** A resolved sprite sheet: the fetched atlas image URL/data plus its parsed sprite JSON
 * mapping (app-fetched — the adapter does not fetch `style.sprite` itself, matching
 * `IconLayer.iconAtlas`/`iconMapping`'s existing "you provide the resolved asset" contract). */
export interface MapLibreSpriteAtlas {
  image: string;
  mapping: Record<
    string,
    {x: number; y: number; width: number; height: number; pixelRatio?: number; sdf?: boolean}
  >;
}

export interface MapLibreStyleLayerProps {
  style: {layers: unknown[]; [key: string]: unknown};
  source: MapLibreVectorSource;
  evaluator: MapLibreStyleEvaluator;
  spriteAtlas?: MapLibreSpriteAtlas;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
yarn install # picks up the new devDependency
npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts
```
Expected: PASS.

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write package.json modules/geo-layers/src/maplibre-style-layer/types.ts test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts
git add package.json yarn.lock modules/geo-layers/src/maplibre-style-layer/types.ts test/modules/geo-layers/maplibre-style-layer/types.node.spec.ts
git commit -m "feat(geo-layers): scaffold MapLibre style-adapter types, add style-spec test devDependency"
```

---

### Task 6: Filter compilation (`compileFilter`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/compile-filter.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts`

**Interfaces:**
- Produces: `compileFilter(filter: unknown, evaluator: MapLibreStyleEvaluator): (zoom: number, feature: {properties: Record<string, unknown>}) => boolean` — compiles once, evaluates per feature; a missing/undefined `filter` (a style layer with no `filter` key) always passes.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {compileFilter} from '@deck.gl/geo-layers/maplibre-style-layer/compile-filter';

const evaluator = {createPropertyExpression, featureFilter};

test('compileFilter#no filter always passes', () => {
  const fn = compileFilter(undefined, evaluator);
  expect(fn(10, {properties: {}})).toBe(true);
});

test('compileFilter#["==", ["get", "class"], "park"]', () => {
  const fn = compileFilter(['==', ['get', 'class'], 'park'], evaluator);
  expect(fn(10, {properties: {class: 'park'}})).toBe(true);
  expect(fn(10, {properties: {class: 'water'}})).toBe(false);
});

test('compileFilter#zoom-dependent filter (>=)', () => {
  const fn = compileFilter(['>=', ['zoom'], 12], evaluator);
  expect(fn(11, {properties: {}})).toBe(false);
  expect(fn(12, {properties: {}})).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/compile-filter.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';

export type CompiledFilter = (
  zoom: number,
  feature: {properties: Record<string, unknown>}
) => boolean;

/** Compiles a MapLibre style layer's `filter` once via the injected evaluator's
 * `featureFilter`, returning a cheap per-feature predicate. A style layer with no `filter`
 * (undefined) always passes — MapLibre itself treats a missing filter as "match everything". */
export function compileFilter(
  filter: unknown,
  evaluator: MapLibreStyleEvaluator
): CompiledFilter {
  if (filter === undefined) {
    return () => true;
  }
  const compiled = evaluator.featureFilter(filter);
  return (zoom, feature) => compiled.filter({zoom}, feature as never);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/compile-filter.ts test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/compile-filter.ts test/modules/geo-layers/maplibre-style-layer/compile-filter.node.spec.ts
git commit -m "feat(geo-layers): compile MapLibre style-layer filters via injected evaluator"
```

---

### Task 7: Paint/layout expression compilation + zoom-bucket helper (`compileExpression`, `zoomBucket`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/compile-expression.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts`

**Interfaces:**
- Produces:
  - `zoomBucket(zoom: number): number` — `Math.floor(zoom)` (Decisions for review #3).
  - `compileExpression<T>(value: unknown, propertySpec: unknown, evaluator: MapLibreStyleEvaluator): {evaluate: (zoom: number, feature: {properties: Record<string, unknown>}) => T; isZoomDependent: boolean}` — `isZoomDependent` is `true` for `'camera'`/`'composite'` compiled-expression kinds, `false` for `'constant'`/`'source'` (drives whether the caller adds this accessor to `updateTriggers`).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {compileExpression, zoomBucket} from '@deck.gl/geo-layers/maplibre-style-layer/compile-expression';

const evaluator = {createPropertyExpression, featureFilter};

test('zoomBucket#floors to integer', () => {
  expect(zoomBucket(11.9)).toBe(11);
  expect(zoomBucket(12)).toBe(12);
});

test('compileExpression#constant color, not zoom-dependent', () => {
  const {evaluate, isZoomDependent} = compileExpression<string>(
    '#ff0000',
    {type: 'color'},
    evaluator
  );
  expect(isZoomDependent).toBe(false);
  expect(evaluate(10, {properties: {}})).toBeTruthy();
});

test('compileExpression#zoom-interpolated line-width, zoom-dependent', () => {
  const {evaluate, isZoomDependent} = compileExpression<number>(
    ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 6],
    {type: 'number'},
    evaluator
  );
  expect(isZoomDependent).toBe(true);
  const narrow = evaluate(10, {properties: {}});
  const wide = evaluate(16, {properties: {}});
  expect(Number(wide)).toBeGreaterThan(Number(narrow));
});

test('compileExpression#data-driven (["get", ...]) evaluates per feature', () => {
  const {evaluate} = compileExpression<number>(['get', 'height'], {type: 'number'}, evaluator);
  expect(evaluate(10, {properties: {height: 42}})).toBe(42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/compile-expression.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';

/** MapLibre's own camera/composite expressions are defined as interpolation between integer
 * zoom stops (tile buckets are built per integer zoom in mapbox-gl-js/maplibre-gl-js itself) —
 * bucketing to `Math.floor(zoom)` re-evaluates at the same granularity upstream already uses,
 * not a deck.gl-specific shortcut. See
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md, Decisions for review #3. */
export function zoomBucket(zoom: number): number {
  return Math.floor(zoom);
}

export interface CompiledExpression<T> {
  evaluate: (zoom: number, feature: {properties: Record<string, unknown>}) => T;
  /** True for 'camera'/'composite' expression kinds (depend on `["zoom"]`) — callers should
   * key this accessor's `updateTriggers` entry on `zoomBucket(viewport.zoom)`. False for
   * 'constant'/'source' (data-driven only) — no updateTrigger needed; evaluated once (or on
   * data change only). */
  isZoomDependent: boolean;
}

/** Compiles one paint/layout property value once via the injected evaluator's
 * `createPropertyExpression`, returning a per-feature evaluator plus whether it needs
 * per-zoom-bucket re-evaluation (Decisions for review #3). */
export function compileExpression<T>(
  value: unknown,
  propertySpec: unknown,
  evaluator: MapLibreStyleEvaluator
): CompiledExpression<T> {
  const result = evaluator.createPropertyExpression(value, propertySpec);
  const compiled = result.value;
  if (!compiled) {
    throw new Error(`Invalid MapLibre style expression: ${JSON.stringify(value)}`);
  }
  const isZoomDependent = compiled.kind === 'camera' || compiled.kind === 'composite';
  return {
    isZoomDependent,
    evaluate: (zoom, feature) => compiled.evaluate({zoom}, feature as never) as T
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/compile-expression.ts test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/compile-expression.ts test/modules/geo-layers/maplibre-style-layer/compile-expression.node.spec.ts
git commit -m "feat(geo-layers): compile MapLibre paint/layout expressions with zoom-bucket re-evaluation"
```

---

### Task 8: Sprite sheet → `IconLayer` mapping (`spriteToIconMapping`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/sprite-mapping.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts`

**Interfaces:**
- Produces: `spriteToIconMapping(sprite: MapLibreSpriteAtlas['mapping']): IconMapping` (from `@deck.gl/layers`'s `IconMapping` shape, `{x,y,width,height,anchorX?,anchorY?,mask?}`) — drops `pixelRatio`, renames `sdf` → `mask`.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {spriteToIconMapping} from '@deck.gl/geo-layers/maplibre-style-layer/sprite-mapping';

test('spriteToIconMapping#drops pixelRatio, renames sdf to mask', () => {
  const mapping = spriteToIconMapping({
    'harbor-15': {x: 0, y: 0, width: 15, height: 15, pixelRatio: 2, sdf: true},
    'park-11': {x: 15, y: 0, width: 11, height: 11, pixelRatio: 2}
  });
  expect(mapping['harbor-15']).toEqual({x: 0, y: 0, width: 15, height: 15, mask: true});
  expect(mapping['park-11']).toEqual({x: 15, y: 0, width: 11, height: 11, mask: false});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/sprite-mapping.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {IconMapping} from '@deck.gl/layers';
import type {MapLibreSpriteAtlas} from './types';

/** A MapLibre/Mapbox sprite JSON entry (`{x,y,width,height,pixelRatio,sdf}`) is almost exactly
 * deck.gl's `IconMapping` entry shape (`modules/layers/src/icon-layer/icon-manager.ts:28-67`,
 * `{x,y,width,height,anchorX?,anchorY?,mask?}`) — same rectangle keys, no restructuring. Only
 * `pixelRatio` (deck.gl doesn't need it; the atlas image is used at its native resolution) is
 * dropped and `sdf` (recolorable single-channel icon) is renamed to deck.gl's `mask`. */
export function spriteToIconMapping(sprite: MapLibreSpriteAtlas['mapping']): IconMapping {
  const mapping: IconMapping = {};
  for (const [name, entry] of Object.entries(sprite)) {
    mapping[name] = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      mask: Boolean(entry.sdf)
    };
  }
  return mapping;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/sprite-mapping.ts test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/sprite-mapping.ts test/modules/geo-layers/maplibre-style-layer/sprite-mapping.node.spec.ts
git commit -m "feat(geo-layers): map MapLibre sprite sheets to IconLayer's iconMapping shape"
```

---

### Task 9: Line-midpoint helper for `symbol-placement: 'line'` fallback (`lineMidpoint`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/line-midpoint.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts`

**Interfaces:**
- Produces: `lineMidpoint(coordinates: [number, number][]): [number, number]` — the point at half the cumulative line length along a `LineString`'s vertex chain (not the geometric bbox center), so it lands on the line itself.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {lineMidpoint} from '@deck.gl/geo-layers/maplibre-style-layer/line-midpoint';

test('lineMidpoint#straight 2-point line: exact midpoint', () => {
  expect(lineMidpoint([[0, 0], [10, 0]])).toEqual([5, 0]);
});

test('lineMidpoint#3-point line: half cumulative length, not bbox center', () => {
  // Segment lengths: 1 (0,0)->(1,0), then 9 (1,0)->(1,9). Total 10; midpoint at length 5,
  // i.e. 4 units into the second segment: (1, 4).
  const [x, y] = lineMidpoint([[0, 0], [1, 0], [1, 9]]);
  expect(x).toBeCloseTo(1, 6);
  expect(y).toBeCloseTo(4, 6);
});

test('lineMidpoint#single point: returns it unchanged', () => {
  expect(lineMidpoint([[3, 4]])).toEqual([3, 4]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/line-midpoint.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The v1 `symbol-placement: 'line'` fallback (Decisions for review #4 in
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md): one horizontal label
 * anchored at the point half the cumulative line length along the vertex chain — not the
 * geometric bounding-box center, which can land off the line entirely for bent/L-shaped
 * geometries. No curve, no repeated labeling; documented as a fidelity cut, not silently
 * dropped (the caller emits a console.warn once per style-layer id — see symbol-text mapper). */
export function lineMidpoint(coordinates: [number, number][]): [number, number] {
  if (coordinates.length <= 1) {
    return coordinates[0] ?? [0, 0];
  }
  const segmentLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [x0, y0] = coordinates[i - 1];
    const [x1, y1] = coordinates[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    segmentLengths.push(length);
    total += length;
  }
  const half = total / 2;
  let cumulative = 0;
  for (let i = 0; i < segmentLengths.length; i++) {
    const length = segmentLengths[i];
    if (cumulative + length >= half || i === segmentLengths.length - 1) {
      const t = length === 0 ? 0 : (half - cumulative) / length;
      const [x0, y0] = coordinates[i];
      const [x1, y1] = coordinates[i + 1];
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    cumulative += length;
  }
  return coordinates[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/line-midpoint.ts test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/line-midpoint.ts test/modules/geo-layers/maplibre-style-layer/line-midpoint.node.spec.ts
git commit -m "feat(geo-layers): line-midpoint helper for symbol-placement:line label fallback"
```

---

### Task 10: Per-style-layer mappers (`background`, `fill`, `line`, `fill-extrusion`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/style-layer-mappers.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts`

**Interfaces:**
- Produces: `mapBackgroundLayer`, `mapFillLayer`, `mapLineLayer`, `mapFillExtrusionLayer` — each `(styleLayer, features, evaluator, zoom) => Layer | null`, using `GeoJsonLayer`/`SolidPolygonLayer`/`PathStyleExtension` as designed in the spec's mapping table. `null` when `features` is empty after filtering (avoids an empty-data layer churning `updateTriggers`).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {GeoJsonLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import {
  mapBackgroundLayer,
  mapFillLayer,
  mapLineLayer,
  mapFillExtrusionLayer
} from '@deck.gl/geo-layers/maplibre-style-layer/style-layer-mappers';

const evaluator = {createPropertyExpression, featureFilter};

const polygonFeature = {
  type: 'Feature' as const,
  properties: {class: 'park'},
  geometry: {type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
};

test('mapBackgroundLayer#produces a SolidPolygonLayer-backed layer with background-color', () => {
  const layer = mapBackgroundLayer(
    {id: 'bg', type: 'background', paint: {'background-color': '#e0e0e0'}},
    evaluator,
    10
  );
  expect(layer).not.toBeNull();
});

test('mapFillLayer#filters, colors via fill-color, null when nothing matches', () => {
  const styleLayer = {
    id: 'parks',
    type: 'fill',
    filter: ['==', ['get', 'class'], 'park'],
    paint: {'fill-color': '#00ff00', 'fill-opacity': 0.5}
  };
  const layer = mapFillLayer(styleLayer, [polygonFeature], evaluator, 10);
  expect(layer).toBeInstanceOf(GeoJsonLayer);

  const noMatch = mapFillLayer(
    {...styleLayer, filter: ['==', ['get', 'class'], 'water']},
    [polygonFeature],
    evaluator,
    10
  );
  expect(noMatch).toBeNull();
});

test('mapLineLayer#applies line-dasharray via PathStyleExtension', () => {
  const lineFeature = {
    type: 'Feature' as const,
    properties: {},
    geometry: {type: 'LineString' as const, coordinates: [[0, 0], [1, 1]]}
  };
  const layer = mapLineLayer(
    {id: 'border', type: 'line', paint: {'line-color': '#000', 'line-dasharray': [2, 1]}},
    [lineFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.extensions?.some(e => e instanceof PathStyleExtension)).toBe(true);
});

test('mapFillExtrusionLayer#extruded true, getElevation from fill-extrusion-height', () => {
  const extrudedFeature = {...polygonFeature, properties: {'fill-extrusion-height': 30}};
  const layer = mapFillExtrusionLayer(
    {
      id: 'buildings',
      type: 'fill-extrusion',
      paint: {'fill-extrusion-height': ['get', 'fill-extrusion-height']}
    },
    [extrudedFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.extruded).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/style-layer-mappers.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {GeoJsonLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileFilter} from './compile-filter';
import {compileExpression, zoomBucket} from './compile-expression';
import type {MapLibreStyleEvaluator} from './types';

type StyleLayer = {
  id: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

function filterFeatures(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Feature[] {
  const filter = compileFilter(styleLayer.filter, evaluator);
  return features.filter(f => filter(zoom, f as {properties: Record<string, unknown>}));
}

/** `background` style layers have no source data — one full-viewport-covering polygon. The
 * caller (the composite layer, Task 12) supplies the covering polygon via `features`; this
 * mapper only compiles `background-color`/`background-opacity`. */
export function mapBackgroundLayer(
  styleLayer: StyleLayer,
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  coveringFeature?: Feature
): Layer | null {
  const paint = styleLayer.paint ?? {};
  const color = compileExpression<string>(
    paint['background-color'] ?? '#000000',
    {type: 'color'},
    evaluator
  );
  const opacity = compileExpression<number>(paint['background-opacity'] ?? 1, {type: 'number'}, evaluator);
  const feature =
    coveringFeature ?? {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'Polygon' as const,
        coordinates: [[[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]]
      }
    };
  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: [feature],
    filled: true,
    stroked: false,
    getFillColor: () => toRGBA(color.evaluate(zoom, feature), opacity.evaluate(zoom, feature)),
    updateTriggers: {
      getFillColor: color.isZoomDependent || opacity.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}

export function mapFillLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(paint['fill-color'] ?? '#000000', {type: 'color'}, evaluator);
  const opacity = compileExpression<number>(paint['fill-opacity'] ?? 1, {type: 'number'}, evaluator);
  const outlineColor = paint['fill-outline-color']
    ? compileExpression<string>(paint['fill-outline-color'], {type: 'color'}, evaluator)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    filled: true,
    stroked: Boolean(outlineColor),
    getFillColor: (f: Feature) => toRGBA(fillColor.evaluate(zoom, f), opacity.evaluate(zoom, f)),
    getLineColor: outlineColor ? (f: Feature) => toRGBA(outlineColor.evaluate(zoom, f), 1) : undefined,
    updateTriggers: {
      getFillColor: zoomDependentBucket(zoom, fillColor, opacity),
      getLineColor: outlineColor ? zoomDependentBucket(zoom, outlineColor) : undefined
    }
  });
}

export function mapLineLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const lineColor = compileExpression<string>(paint['line-color'] ?? '#000000', {type: 'color'}, evaluator);
  const lineWidth = compileExpression<number>(paint['line-width'] ?? 1, {type: 'number'}, evaluator);
  const dashArray = paint['line-dasharray']
    ? compileExpression<[number, number]>(paint['line-dasharray'], {type: 'array'}, evaluator)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    stroked: true,
    filled: false,
    getLineColor: (f: Feature) => toRGBA(lineColor.evaluate(zoom, f), 1),
    getLineWidth: (f: Feature) => lineWidth.evaluate(zoom, f),
    extensions: dashArray ? [new PathStyleExtension({dash: true})] : [],
    getDashArray: dashArray ? (f: Feature) => dashArray.evaluate(zoom, f) : undefined,
    updateTriggers: {
      getLineColor: zoomDependentBucket(zoom, lineColor),
      getLineWidth: zoomDependentBucket(zoom, lineWidth),
      getDashArray: dashArray ? zoomDependentBucket(zoom, dashArray) : undefined
    }
  });
}

export function mapFillExtrusionLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(paint['fill-extrusion-color'] ?? '#cccccc', {type: 'color'}, evaluator);
  const height = compileExpression<number>(paint['fill-extrusion-height'] ?? 0, {type: 'number'}, evaluator);
  const base = paint['fill-extrusion-base']
    ? compileExpression<number>(paint['fill-extrusion-base'], {type: 'number'}, evaluator)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    filled: true,
    extruded: true,
    getFillColor: (f: Feature) => toRGBA(fillColor.evaluate(zoom, f), 1),
    getElevation: (f: Feature) =>
      height.evaluate(zoom, f) - (base ? base.evaluate(zoom, f) : 0),
    updateTriggers: {
      getFillColor: zoomDependentBucket(zoom, fillColor),
      getElevation: zoomDependentBucket(zoom, height, base ?? undefined)
    }
  });
}

function zoomDependentBucket(
  zoom: number,
  ...compiled: Array<{isZoomDependent: boolean} | undefined>
): number | undefined {
  return compiled.some(c => c?.isZoomDependent) ? zoomBucket(zoom) : undefined;
}

/** Minimal `#rrggbb`/`rgba(...)`-agnostic passthrough: `createPropertyExpression({type:
 * 'color'})` already returns a parsed `{r,g,b,a}` (0-1 range) object per the style-spec's own
 * color type — converts to deck.gl's `[r,g,b,a]` (0-255) `Color` tuple, folding in a separate
 * opacity multiplier where the style separates `-color` and `-opacity` paint properties. */
function toRGBA(color: unknown, opacity: number): [number, number, number, number] {
  const c = color as {r: number; g: number; b: number; a: number};
  return [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
    Math.round(c.a * opacity * 255)
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts`
Expected: PASS (4 tests). If `toRGBA`'s assumed `{r,g,b,a}` shape doesn't match the real
package's color-expression evaluate output, adjust `toRGBA` to match the actual runtime shape
observed in this step (the style-spec's documented color type; verify against
`@maplibre/maplibre-gl-style-spec`'s `Color` class in `node_modules` if the test fails on shape).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/style-layer-mappers.ts test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/style-layer-mappers.ts test/modules/geo-layers/maplibre-style-layer/style-layer-mappers.node.spec.ts
git commit -m "feat(geo-layers): map background/fill/line/fill-extrusion style layers to deck.gl layers"
```

---

### Task 11: Symbol mappers (`icon` via `IconLayer`, `text` via `TextLayer` + `CollisionFilterExtension`)

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/symbol-mappers.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts`

**Interfaces:**
- Produces: `mapSymbolIconLayer(styleLayer, features, evaluator, zoom, spriteAtlas) => Layer | null`, `mapSymbolTextLayer(styleLayer, features, evaluator, zoom, warnOnce) => Layer | null` — the latter applies Task 9's `lineMidpoint` fallback for `LineString` features when `layout['symbol-placement'] === 'line'`, calling `warnOnce(styleLayer.id)` exactly once per distinct layer id (Decisions for review #4).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {IconLayer, TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import {
  mapSymbolIconLayer,
  mapSymbolTextLayer
} from '@deck.gl/geo-layers/maplibre-style-layer/symbol-mappers';

const evaluator = {createPropertyExpression, featureFilter};

const pointFeature = {
  type: 'Feature' as const,
  properties: {name: 'Overfalls', 'symbol-sort-key': 5},
  geometry: {type: 'Point' as const, coordinates: [-74, 40]}
};

test('mapSymbolIconLayer#produces an IconLayer using spriteAtlas mapping', () => {
  const layer = mapSymbolIconLayer(
    {id: 'poi', type: 'symbol', layout: {'icon-image': 'harbor-15'}},
    [pointFeature],
    evaluator,
    10,
    {image: 'atlas.png', mapping: {'harbor-15': {x: 0, y: 0, width: 15, height: 15}}}
  );
  expect(layer).toBeInstanceOf(IconLayer);
});

test('mapSymbolTextLayer#point placement: TextLayer with CollisionFilterExtension, priority from symbol-sort-key', () => {
  const warnOnce = vi.fn();
  const layer = mapSymbolTextLayer(
    {
      id: 'labels',
      type: 'symbol',
      layout: {'text-field': ['get', 'name'], 'symbol-sort-key': ['get', 'symbol-sort-key']}
    },
    [pointFeature],
    evaluator,
    10,
    warnOnce
  ) as TextLayer;
  expect(layer).toBeInstanceOf(TextLayer);
  expect(layer.props.extensions?.some(e => e instanceof CollisionFilterExtension)).toBe(true);
  expect(warnOnce).not.toHaveBeenCalled();
});

test('mapSymbolTextLayer#symbol-placement:line falls back to midpoint, warns once', () => {
  const lineFeature = {
    type: 'Feature' as const,
    properties: {name: 'Main St'},
    geometry: {type: 'LineString' as const, coordinates: [[0, 0], [10, 0]]}
  };
  const warnOnce = vi.fn();
  const layer = mapSymbolTextLayer(
    {id: 'road-labels', type: 'symbol', layout: {'text-field': ['get', 'name'], 'symbol-placement': 'line'}},
    [lineFeature],
    evaluator,
    10,
    warnOnce
  ) as TextLayer;
  expect(layer.props.data).toEqual([
    expect.objectContaining({geometry: {type: 'Point', coordinates: [5, 0]}})
  ]);
  expect(warnOnce).toHaveBeenCalledWith('road-labels');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/symbol-mappers.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer} from '@deck.gl/core';
import {IconLayer, TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileFilter} from './compile-filter';
import {compileExpression, zoomBucket} from './compile-expression';
import {spriteToIconMapping} from './sprite-mapping';
import {lineMidpoint} from './line-midpoint';
import type {MapLibreStyleEvaluator, MapLibreSpriteAtlas} from './types';

type StyleLayer = {
  id: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

function filterFeatures(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Feature[] {
  const filter = compileFilter(styleLayer.filter, evaluator);
  return features.filter(f => filter(zoom, f as {properties: Record<string, unknown>}));
}

/** Reduces every feature to a single labeling point: `Point` geometries pass through
 * unchanged; `LineString` geometries with `symbol-placement: 'line'` use Task 9's
 * `lineMidpoint` fallback (Decisions for review #4), warning once per style-layer id. */
function toLabelPoints(
  styleLayer: StyleLayer,
  features: Feature[],
  warnOnce: (id: string) => void
): Feature[] {
  const placement = styleLayer.layout?.['symbol-placement'];
  return features.map(f => {
    if (f.geometry.type === 'Point') return f;
    if (f.geometry.type === 'LineString' && placement === 'line') {
      warnOnce(styleLayer.id);
      const point = lineMidpoint(f.geometry.coordinates as [number, number][]);
      return {...f, geometry: {type: 'Point', coordinates: point}} as Feature;
    }
    return f;
  });
}

export function mapSymbolIconLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  spriteAtlas: MapLibreSpriteAtlas
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0 || !styleLayer.layout?.['icon-image']) return null;

  const iconImage = compileExpression<string>(styleLayer.layout['icon-image'], {type: 'string'}, evaluator);
  const iconSize = compileExpression<number>(
    (styleLayer.layout?.['icon-size'] as unknown) ?? 1,
    {type: 'number'},
    evaluator
  );

  return new IconLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    iconAtlas: spriteAtlas.image,
    iconMapping: spriteToIconMapping(spriteAtlas.mapping),
    getPosition: (f: Feature) => (f.geometry as {coordinates: [number, number]}).coordinates,
    getIcon: (f: Feature) => iconImage.evaluate(zoom, f),
    getSize: (f: Feature) => iconSize.evaluate(zoom, f),
    updateTriggers: {
      getIcon: iconImage.isZoomDependent ? zoomBucket(zoom) : undefined,
      getSize: iconSize.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}

export function mapSymbolTextLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  warnOnce: (id: string) => void
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0 || !styleLayer.layout?.['text-field']) return null;

  const labelPoints = toLabelPoints(styleLayer, matched, warnOnce);
  const textField = compileExpression<string>(styleLayer.layout['text-field'], {type: 'string'}, evaluator);
  const priorityValue = styleLayer.layout?.['symbol-sort-key'];
  const priority = priorityValue
    ? compileExpression<number>(priorityValue, {type: 'number'}, evaluator)
    : null;

  return new TextLayer({
    id: `maplibre-${styleLayer.id}`,
    data: labelPoints,
    getPosition: (f: Feature) => (f.geometry as {coordinates: [number, number]}).coordinates,
    getText: (f: Feature) => textField.evaluate(zoom, f),
    // Browser-font approximation of `text-font` (Decisions for review — accepted v1 cut, no
    // glyph-PBF fetch/parity with the style's `glyphs` URL).
    fontFamily: 'sans-serif',
    collisionEnabled: true,
    getCollisionPriority: priority ? (f: Feature) => priority.evaluate(zoom, f) : undefined,
    extensions: [new CollisionFilterExtension()],
    updateTriggers: {
      getText: textField.isZoomDependent ? zoomBucket(zoom) : undefined,
      getCollisionPriority: priority?.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/symbol-mappers.ts test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/symbol-mappers.ts test/modules/geo-layers/maplibre-style-layer/symbol-mappers.node.spec.ts
git commit -m "feat(geo-layers): map symbol icon/text style layers, midpoint fallback for line placement"
```

---

### Task 12: `MapLibreStyleLayer` composite — assembles mapped layers per tile, in style order

Wires Tasks 5–11 into a `CompositeLayer` over an `MVTLayer` (Stage-1-CRS-aware), fanning each
tile's parsed content out into one mapped layer per matching, non-`background`/unsupported style
layer, plus one `background` layer for the whole view.

**Files:**
- Create: `modules/geo-layers/src/maplibre-style-layer/maplibre-style-layer.ts`
- Test: `test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts` (headless)
- Modify: `modules/geo-layers/src/index.ts` (export `_MapLibreStyleLayer`, `MapLibreStyleLayerProps as _MapLibreStyleLayerProps`)

**Interfaces:**
- Produces: `class MapLibreStyleLayer extends CompositeLayer<MapLibreStyleLayerProps>` — `renderLayers()` returns `[backgroundLayer, mvtLayer]` where `mvtLayer`'s `renderSubLayers` returns, per tile, the ordered list of `style.layers` mapped via Task 10/11's functions against that tile's parsed `GeoJsonLayer`-shape feature array (unsupported types skipped with a one-time `log.warn`).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {_MapLibreStyleLayer as MapLibreStyleLayer, MVTLayer} from '@deck.gl/geo-layers';

const evaluator = {createPropertyExpression, featureFilter};

const style = {
  layers: [
    {id: 'bg', type: 'background', paint: {'background-color': '#e8e8e8'}},
    {
      id: 'water',
      type: 'fill',
      filter: ['==', ['get', 'class'], 'water'],
      paint: {'fill-color': '#a0c8f0'}
    },
    {
      id: 'raster-unsupported',
      type: 'raster'
    }
  ]
};

test('MapLibreStyleLayer#renders a background layer and one mapped fill layer, skips unsupported types', async () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600, longitude: -74, latitude: 40, zoom: 3});

  const testCases = [
    {
      props: {
        style,
        source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
        evaluator
      },
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers.some(l => l.id.includes('maplibre-bg'))).toBe(true);
        expect(subLayers.some(l => l instanceof MVTLayer)).toBe(true);
      }
    }
  ];

  await testLayerAsync({Layer: MapLibreStyleLayer, viewport, testCases, onError: e => expect(e).toBeFalsy()});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts`
Expected: FAIL — `_MapLibreStyleLayer` is not exported yet.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/maplibre-style-layer/maplibre-style-layer.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, Layer, LayersList, log} from '@deck.gl/core';
import {binaryToGeojson} from '@loaders.gl/gis';
import type {Feature} from 'geojson';

import MVTLayer from '../mvt-layer/mvt-layer';
import {mapBackgroundLayer, mapFillLayer, mapLineLayer, mapFillExtrusionLayer} from './style-layer-mappers';
import {mapSymbolIconLayer, mapSymbolTextLayer} from './symbol-mappers';
import type {MapLibreStyleLayerProps} from './types';

type StyleLayer = {id: string; type: string; [key: string]: unknown};

const SUPPORTED_TYPES = new Set(['fill', 'line', 'fill-extrusion', 'symbol']);
const warnedUnsupportedIds = new Set<string>();
const warnedLinePlacementIds = new Set<string>();

function warnUnsupportedOnce(styleLayer: StyleLayer): void {
  if (warnedUnsupportedIds.has(styleLayer.id)) return;
  warnedUnsupportedIds.add(styleLayer.id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${styleLayer.id}" has unsupported type "${styleLayer.type}" ` +
      '(raster/hillshade/heatmap are not implemented in v1) — skipped.'
  )();
}

function warnLinePlacementOnce(id: string): void {
  if (warnedLinePlacementIds.has(id)) return;
  warnedLinePlacementIds.add(id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${id}" uses symbol-placement:'line' — approximated as a ` +
      'single horizontal label at the line midpoint (no curved along-line placement in v1).'
  )();
}

export class MapLibreStyleLayer extends CompositeLayer<MapLibreStyleLayerProps> {
  static layerName = 'MapLibreStyleLayer';

  renderLayers(): LayersList {
    const {style, source, evaluator, spriteAtlas} = this.props;
    const zoom = this.context.viewport.zoom;
    const layers: LayersList = [];

    const backgroundStyleLayer = (style.layers as StyleLayer[]).find(l => l.type === 'background');
    if (backgroundStyleLayer) {
      layers.push(mapBackgroundLayer(backgroundStyleLayer as never, evaluator, zoom));
    }

    const featureStyleLayers = (style.layers as StyleLayer[]).filter(l => l.type !== 'background');

    layers.push(
      new MVTLayer(this.getSubLayerProps({id: 'source'}), {
        data: source.data,
        tileMatrixSet: source.tileMatrixSet,
        renderSubLayers: (tileProps: {data: unknown; tile: unknown}) => {
          const features = toFeatureArray(tileProps.data);
          const sublayers: LayersList = [];
          for (const styleLayer of featureStyleLayers) {
            if (!SUPPORTED_TYPES.has(styleLayer.type)) {
              warnUnsupportedOnce(styleLayer);
              continue;
            }
            const mapped = mapOneStyleLayer(styleLayer, features, evaluator, zoom, spriteAtlas);
            if (mapped) sublayers.push(mapped);
          }
          return sublayers;
        }
      })
    );

    return layers;
  }
}

function mapOneStyleLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleLayerProps['evaluator'],
  zoom: number,
  spriteAtlas: MapLibreStyleLayerProps['spriteAtlas']
): Layer | null {
  switch (styleLayer.type) {
    case 'fill':
      return mapFillLayer(styleLayer as never, features, evaluator, zoom);
    case 'line':
      return mapLineLayer(styleLayer as never, features, evaluator, zoom);
    case 'fill-extrusion':
      return mapFillExtrusionLayer(styleLayer as never, features, evaluator, zoom);
    case 'symbol':
      if ((styleLayer as {layout?: {'icon-image'?: unknown}}).layout?.['icon-image'] && spriteAtlas) {
        return mapSymbolIconLayer(styleLayer as never, features, evaluator, zoom, spriteAtlas);
      }
      return mapSymbolTextLayer(styleLayer as never, features, evaluator, zoom, warnLinePlacementOnce);
    default:
      return null;
  }
}

function toFeatureArray(tileData: unknown): Feature[] {
  if (Array.isArray(tileData)) return tileData as Feature[];
  // Binary-shape tile content (classic Mercator route, `binary: true`): reuse the loader's own
  // conversion so style-layer mappers always see a plain Feature[] regardless of MVTLayer's
  // internal coordinate/shape mode.
  return (binaryToGeojson(tileData as never) as {features: Feature[]}).features ?? [];
}
```

Add to `modules/geo-layers/src/index.ts` (alongside the `_WarpedTileLayer` exports):

```ts
export {MapLibreStyleLayer as _MapLibreStyleLayer} from './maplibre-style-layer/maplibre-style-layer';
export type {MapLibreStyleLayerProps as _MapLibreStyleLayerProps} from './maplibre-style-layer/types';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts`
Expected: PASS.

- [ ] **Step 5: Regression, prettier, commit**

```bash
npx vitest run --project headless test/modules/geo-layers/mvt-layer.spec.ts test/modules/geo-layers/mvt-layer-crs.spec.ts
npx prettier --config .prettierrc --write modules/geo-layers/src/maplibre-style-layer/maplibre-style-layer.ts modules/geo-layers/src/index.ts test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts
git add modules/geo-layers/src/maplibre-style-layer/maplibre-style-layer.ts modules/geo-layers/src/index.ts test/modules/geo-layers/maplibre-style-layer/maplibre-style-layer.spec.ts
git commit -m "feat(geo-layers): add _MapLibreStyleLayer composite, export from geo-layers barrel"
```

---

### Task 13: Docs + Fathom hybrid acceptance-scenario app verification

**Files:**
- Create: `docs/api-reference/geo-layers/maplibre-style-layer.md`
- Modify: `docs/table-of-contents.json` (flat entry, no "Experimental" section exists — mirrors `warped-tile-layer`'s listing)
- Modify: `docs/superpowers/specs/2026-07-05-crs-roadmap.md` (mark E1 shipped, note the Stage 2 expansion)
- Modify: `test/apps/crs-viewport/app.jsx`

- [ ] **Step 1: `maplibre-style-layer.md`**

```md
# MapLibreStyleLayer (Experimental)

import {_MapLibreStyleLayer as MapLibreStyleLayer} from '@deck.gl/geo-layers';

`MapLibreStyleLayer` converts a MapLibre GL style JSON plus a vector tile source into styled
deck.gl layers — one deck.gl layer per style layer, per tile, in style order. It works in both
classic Mercator `MapView`s and non-Mercator CRS `MapView`s (see [MVTLayer CRS
support](./mvt-layer.md#crs-views)); the vector source's `tileMatrixSet` follows the same
convention as `MVTLayer`/`TileLayer`.

## No bundled style-spec dependency

`MapLibreStyleLayer` does not depend on `@maplibre/maplibre-gl-style-spec` at runtime — you
supply its two entry points (`createPropertyExpression`, `featureFilter`) as the `evaluator`
prop:

```js
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';

new MapLibreStyleLayer({
  style: myStyleJson,
  source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
  evaluator: {createPropertyExpression, featureFilter}
});
```

## v1 support

Implemented: `background`, `fill` (+ outline), `line` (+ `line-dasharray`), `fill-extrusion`,
`symbol` icons (via a resolved sprite atlas passed as `spriteAtlas`) and point-placed text labels
(collision handled via `CollisionFilterExtension`; `symbol-sort-key` maps to collision priority).

Not implemented in v1 (style layers of these types/features are skipped, with a console warning
naming the offending style-layer `id`): `raster`, `raster-particle`, `hillshade`, `heatmap` style
layers; `line-gradient`; `fill-pattern`; true curved `symbol-placement: 'line'` labels (a single
horizontal label at the line's midpoint is substituted instead — see the design doc's Decisions
for review #4); glyph-PBF font parity (`text-font` is approximated by one browser `fontFamily`).

Paint/layout expressions that depend on `["zoom"]` are re-evaluated once per integer zoom level
(`Math.floor(viewport.zoom)`), not continuously — see the design doc's Decisions for review #3.
```

- [ ] **Step 2: `table-of-contents.json`**

Add a `maplibre-style-layer` entry alongside the existing `warped-tile-layer` line (flat listing,
no "Experimental" section exists on this branch).

- [ ] **Step 3: Roadmap update**

In `docs/superpowers/specs/2026-07-05-crs-roadmap.md`, replace the E1 bullet (already edited in
Stage 1 Task 4) with a final version noting the Stage 2 expansion:

```md
- **E1. MVT in CRS views + MapLibre style adapter** — shipped. wgs84-decode route (generalizing
  the existing GlobeView path) + `_CRSTileset2D` selection (already generic via
  `tileMatrixSet`); costs the binary fast path. Expanded with a new experimental
  `_MapLibreStyleLayer` (style JSON -> deck.gl layers, style-spec evaluator injected, no new
  runtime dependency) — see
  `docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md`.
```

- [ ] **Step 4: App verification — Fathom hybrid acceptance scenario**

In `test/apps/crs-viewport/app.jsx`, add a demo combining (a) the existing warped Esri-Ocean-style
raster basemap (`_WarpedTileLayer`, Phase 3) and (b) an `_MapLibreStyleLayer` instance over a
small demo/synthetic point-label vector source, styled via a minimal MapLibre-shaped style JSON
(`background` + a `symbol` point-label layer, at minimum — extend with `fill`/`line` if a
convenient boundary/soundings fixture is available), both in one UTM `MapView`.

```bash
cd test/apps/crs-viewport && yarn && npx vite --config ../vite.config.local.mjs --host 0.0.0.0
```

Verify (screenshots into `.superpowers/sdd/`):
1. **Warped raster basemap + styled vector point labels, UTM view**: labels render at the
   correct UTM-projected position over the warped basemap, at multiple zooms; collision
   filtering thins overlapping labels at low zoom; no console errors beyond any intentionally
   unsupported style-layer-type warnings. Screenshot `task-e1-fathom-hybrid.png`.
2. **Mercator regression**: `_MapLibreStyleLayer` renders the same demo style correctly in a
   classic Mercator `MapView` too (not CRS-specific). Screenshot `task-e1-mercator-style.png`.

- [ ] **Step 5: Full suite, wrap-up, commit**

```bash
yarn test
```

Expected: PASS except any machine-known failures already recorded in `.superpowers/sdd/progress.md`.

```bash
git add docs/api-reference/geo-layers/maplibre-style-layer.md docs/table-of-contents.json docs/superpowers/specs/2026-07-05-crs-roadmap.md test/apps/crs-viewport/app.jsx
git commit -m "docs(geo-layers): document _MapLibreStyleLayer, verify Fathom hybrid acceptance scenario"
```

Append a Chunk E1 section to `.superpowers/sdd/progress.md` (tasks, findings, screenshot paths, suite results).

---

## Follow-ups (out of scope for this plan)

- Binary-mode (typed-array) MVT support in CRS/Globe views — would need typed-array
  reprojection in the loader itself.
- `symbol-placement: 'line'` true curved labels, `line-gradient`, `fill-pattern`,
  `raster`/`hillshade`/`heatmap` style-layer types, glyph-PBF font parity (Stage 2 Non-goals).
- Continuous (non-integer-zoom-bucketed) paint re-evaluation, if a demonstrated need for
  sub-zoom-level smoothness arises (Decisions for review #3).
- Far-field/adaptive tile LOD for `_CRSTileset2D` (Chunk B1) — orthogonal, unaffected by this
  item either way.
- E2 (exact CPU reprojection opt-in, "Approach B") — next in the roadmap's Chunk E order.
