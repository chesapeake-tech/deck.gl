# CRS Terrain/3D (Phase 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `TerrainLayer` renders correctly in a non-Mercator CRS `MapView` for elevation sources indexed with `tileMatrixSet` (Phase 2's `_CRSTileset2D`); `SimpleMeshLayer`/`COORDINATE_SYSTEM.CARTESIAN` 3D positioning under pitch is verified (not changed) in CRS views. `TerrainExtension` and warping public Web-Mercator terrain-RGB sources are explicitly out of scope (future work). Spec: `docs/superpowers/specs/2026-07-05-crs-terrain-design.md`.

**Architecture:** `_CRSTileset2D`'s tile metadata already exposes `boundsCommon` — an exact affine of the tile's native CRS-grid rectangle, needing no reprojection. `TerrainLayer`'s tile-bounds logic is extracted into a pure, node-testable module (`terrain-bounds.ts`) that prefers `boundsCommon` when present and falls back to the existing Mercator/non-geospatial `viewport.projectFlat` paths unchanged; `TerrainLayer` then forwards `tileMatrixSet` to its internal `TileLayer` exactly as every other tileset prop already is. Elevation Z is untouched (Phase 1 kept Z-scaling "as today"). Part 2 adds a regression test proving CARTESIAN positions computed via `crs.transform.forward` project correctly under pitch — no source change.

**Tech Stack:** TypeScript, Vitest (`node` for pure math, `headless` for layer lifecycle), Phase 1 core (`_CRSViewport`, `distanceScales`), Phase 2 tile math (`_CRSTileset2D`, `tile-matrix-set.ts`), `@math.gl/web-mercator` (`worldToPixels`, existing `@deck.gl/core` dependency), `@loaders.gl/terrain` (existing `@deck.gl/geo-layers` dependency, untouched).

## Global Constraints

- Repo: `/Users/adamthomann/dev/deck.gl`, branch `feat/crs-mapview`. All paths relative to repo root.
- **No new runtime dependencies.**
- **Zero behavior change for existing paths**: classic Mercator `TerrainLayer`/`TileLayer` usage, the non-tiled single-mesh `TerrainLayer` path, and all `TerrainExtension` usage are unaffected. The two pre-existing tiled-bounds branches (Mercator, non-geospatial) must produce byte-identical results after the Task 1 extraction — this is a regression, not a behavior change.
- **No shader/GLSL/WGSL changes** — this item is CPU-only (tile-bounds math) plus a test/docs item.
- **Out of scope (do NOT implement):** `TerrainExtension` CRS support, warping public Web-Mercator terrain-RGB pyramids into CRS views, adaptive/distortion-aware terrain mesh resolution, elevation Z scaling/vertical datum conversion, `zRange`-based visibility culling in CRS views (a pre-existing, separately documented Phase 2 limitation, unrelated to this item).
- License header on every new file:
  ```ts
  // deck.gl
  // SPDX-License-Identifier: MIT
  // Copyright (c) vis.gl contributors
  ```
- Run a single test file: `npx vitest run --project node <path>` (or `--project headless`). The node project only auto-discovers `test/modules/**/*.node.spec.ts`.
- Commit after every green test cycle; message style `feat(geo-layers): <summary>`. Prettier must pass (pre-commit hook enforces eslint + prettier + node vitest).
- Per-module `tsc` requires built dists (pre-existing TS6305 environment issue) — gates are eslint/prettier/vitest, as in Phases 2–3.

---

### Task 1: Extract pure tile-bounds logic (`terrain-bounds.ts`)

Move `TerrainLayer`'s tile-bounds computation (`getOverlappedBounds`, the `MAX_LATITUDE`/`MAX_LONGITUDE`/`TILE_OVERLAP_PIXELS` constants, and a new `resolveTiledTerrainBounds` covering all three branches — CRS-native, Mercator, non-geospatial) into a standalone, pure, node-testable file. No behavior change: this task only relocates and unifies existing logic plus adds the new CRS branch (inert until Task 2 wires `tileMatrixSet` through).

**Files:**
- Create: `modules/geo-layers/src/terrain-layer/terrain-bounds.ts`
- Test: `test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts`
- Modify (Task 2 only touches call sites; this task creates the new file untouched by `terrain-layer.ts` so far)

**Interfaces:**
- Produces:
  - `MAX_LATITUDE = 90`, `MAX_LONGITUDE = 180` (moved from `terrain-layer.ts`)
  - `getOverlappedBounds(bounds: Bounds, tileSize: number, clampLngLat: boolean): Bounds` (moved verbatim)
  - `resolveTiledTerrainBounds(tile: {bbox: TileBoundingBox; boundsCommon?: Bounds}, viewport: Viewport): {bounds: Bounds; clampLngLat: boolean}` — prefers `tile.boundsCommon` (exact, CRS-native); else the existing Mercator `viewport.projectFlat` path (`clampLngLat = viewport instanceof GlobeViewport`); else the existing non-geospatial raw-bbox path (`clampLngLat = false`).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport, _GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {
  resolveTiledTerrainBounds,
  getOverlappedBounds,
  MAX_LATITUDE,
  MAX_LONGITUDE
} from '@deck.gl/geo-layers/terrain-layer/terrain-bounds';

const geoBbox = {west: -122.5, south: 37.6, east: -122.3, north: 37.8};
const nonGeoBbox = {left: 0, bottom: 0, right: 256, top: 256};

test('resolveTiledTerrainBounds#prefers boundsCommon when present (CRS-native tile)', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  const boundsCommon: [number, number, number, number] = [10, 20, 30, 40];
  const {bounds, clampLngLat} = resolveTiledTerrainBounds(
    {bbox: geoBbox, boundsCommon},
    viewport
  );
  expect(bounds).toEqual(boundsCommon);
  expect(clampLngLat).toBe(false);
});

test('resolveTiledTerrainBounds#Mercator regression: projectFlat path unchanged, not clamped', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: geoBbox}, viewport);
  const bottomLeft = viewport.projectFlat([geoBbox.west, geoBbox.south]);
  const topRight = viewport.projectFlat([geoBbox.east, geoBbox.north]);
  expect(bounds).toEqual([bottomLeft[0], bottomLeft[1], topRight[0], topRight[1]]);
  expect(clampLngLat).toBe(false);
});

test('resolveTiledTerrainBounds#GlobeViewport regression: projectFlat is identity, clamp true', () => {
  const viewport = new GlobeViewport({width: 800, height: 600});
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: geoBbox}, viewport);
  // GlobeViewport#projectFlat is identity: lng/lat pass through as common-space x/y
  expect(bounds).toEqual([geoBbox.west, geoBbox.south, geoBbox.east, geoBbox.north]);
  expect(clampLngLat).toBe(true);
});

test('resolveTiledTerrainBounds#non-geospatial regression: raw bbox, no clamp', () => {
  // WebMercatorViewport is always isGeospatial: true; a non-geospatial Viewport (e.g. plain
  // orthographic/OrbitView) only needs the `isGeospatial` flag for this branch, so a minimal
  // stub is sufficient and avoids depending on a specific non-geospatial viewport class.
  const fakeViewport = {isGeospatial: false} as any;
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: nonGeoBbox}, fakeViewport);
  expect(bounds).toEqual([nonGeoBbox.left, nonGeoBbox.bottom, nonGeoBbox.right, nonGeoBbox.top]);
  expect(clampLngLat).toBe(false);
});

test('getOverlappedBounds#pads proportionally and clamps only when requested', () => {
  expect(getOverlappedBounds([0, 0, 256, 256], 256, false)).toEqual([-1, -1, 257, 257]);
  const clamped = getOverlappedBounds([179, 89, 180, 90], 256, true);
  expect(clamped[2]).toBe(MAX_LONGITUDE);
  expect(clamped[3]).toBe(MAX_LATITUDE);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts`
Expected: FAIL — cannot resolve `@deck.gl/geo-layers/terrain-layer/terrain-bounds`.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/terrain-layer/terrain-bounds.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport, Viewport} from '@deck.gl/core';
import type {Bounds, GeoBoundingBox, TileBoundingBox} from '../tileset-2d/index';

export const TILE_OVERLAP_PIXELS = 1;
export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

/** Pads a tile's bounds rectangle by one tile-overlap pixel-equivalent on each side, so
 * adjacent tile meshes stitch without seams. `clampLngLat` clamps the result to the lnglat
 * domain — only correct when `bounds` is itself in lnglat degrees (the GlobeViewport case,
 * where `projectFlat` is identity); common-space and non-geospatial bounds must not be
 * clamped to +/-180/+/-90. */
export function getOverlappedBounds(
  bounds: Bounds,
  tileSize: number,
  clampLngLat: boolean
): Bounds {
  const xPad = ((bounds[2] - bounds[0]) / tileSize) * TILE_OVERLAP_PIXELS;
  const yPad = ((bounds[3] - bounds[1]) / tileSize) * TILE_OVERLAP_PIXELS;
  const overlappedBounds: Bounds = [
    bounds[0] - xPad,
    bounds[1] - yPad,
    bounds[2] + xPad,
    bounds[3] + yPad
  ];

  if (!clampLngLat) {
    return overlappedBounds;
  }

  return [
    Math.max(overlappedBounds[0], -MAX_LONGITUDE),
    Math.max(overlappedBounds[1], -MAX_LATITUDE),
    Math.min(overlappedBounds[2], MAX_LONGITUDE),
    Math.min(overlappedBounds[3], MAX_LATITUDE)
  ];
}

/** Resolves a terrain tile's mesh-bounds rectangle (the `@loaders.gl/terrain` loader's
 * `bounds` argument) and whether it should be clamped to the lnglat domain.
 *
 * Prefers `tile.boundsCommon` — set by `_CRSTileset2D` (`modules/geo-layers/src/tileset-2d/
 * crs-tileset-2d.ts`) when `TileLayer`'s `tileMatrixSet` prop is used. It is exact, not an
 * approximation: a `tileMatrixSet`-indexed tile is by construction a rectangle in the CRS's
 * own native grid units, and CRS-view common space is that same plane, only offset and
 * uniformly rescaled — so `boundsCommon` needs no reprojection, unlike a source pyramid in a
 * *different* projection from the view (the Phase 3 warped-tile problem).
 *
 * Falls back to the pre-existing behavior, unchanged, when `boundsCommon` is absent: Mercator
 * geospatial viewports use `viewport.projectFlat` on the tile's lnglat `bbox` corners
 * (`clampLngLat` true only for `GlobeViewport`, where `projectFlat` is identity and the result
 * is lnglat degrees, not common-space units); non-geospatial viewports use the raw
 * pixel-space `bbox` directly. */
export function resolveTiledTerrainBounds(
  tile: {bbox: TileBoundingBox; boundsCommon?: Bounds},
  viewport: Viewport
): {bounds: Bounds; clampLngLat: boolean} {
  if (tile.boundsCommon) {
    return {bounds: tile.boundsCommon, clampLngLat: false};
  }
  if (viewport.isGeospatial) {
    const bbox = tile.bbox as GeoBoundingBox;
    const bottomLeft = viewport.projectFlat([bbox.west, bbox.south]);
    const topRight = viewport.projectFlat([bbox.east, bbox.north]);
    return {
      bounds: [bottomLeft[0], bottomLeft[1], topRight[0], topRight[1]],
      clampLngLat: viewport instanceof GlobeViewport
    };
  }
  const bbox = tile.bbox as Exclude<TileBoundingBox, GeoBoundingBox>;
  return {
    bounds: [bbox.left, bbox.bottom, bbox.right, bbox.top],
    clampLngLat: false
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/terrain-layer/terrain-bounds.ts test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts
git add modules/geo-layers/src/terrain-layer/terrain-bounds.ts test/modules/geo-layers/terrain-layer/terrain-bounds.node.spec.ts
git commit -m "feat(geo-layers): extract pure terrain tile-bounds resolution"
```

---

### Task 2: Wire `terrain-bounds.ts` into `TerrainLayer`; forward `tileMatrixSet`

`TerrainLayer` switches to `resolveTiledTerrainBounds` (Task 1) and forwards `tileMatrixSet` to its internal `TileLayer` — the same one-line-in-two-places pattern every other tileset prop (`tileSize`, `maxZoom`, `extent`, ...) already uses. `_CRSTileset2D` is then reachable exactly as it already is for a plain `TileLayer` (`tile-layer.ts:277-279`).

**Files:**
- Modify: `modules/geo-layers/src/terrain-layer/terrain-layer.ts`
- Test: `test/modules/geo-layers/terrain-layer-crs.spec.ts` (headless; mirrors `test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts`)

**Interfaces:**
- Consumes (Task 1): `resolveTiledTerrainBounds`, `getOverlappedBounds`, `MAX_LATITUDE`, `MAX_LONGITUDE` from `./terrain-bounds`.
- Consumes (Phase 2, already exported from `@deck.gl/geo-layers`): `_CRSTileset2D`, `TileLayer`'s `tileMatrixSet` prop.
- Produces: `TerrainLayer` accepts `tileMatrixSet` (inherited type, already part of `TerrainLayerProps` via `TileLayerProps<MeshAndTexture>`; only the destructure/forwarding was missing) and renders correctly-positioned tiled terrain when it and a CRS `MapView` are both set.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/terrain-layer-crs.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {TerrainLayer, _CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';
import {TerrainLoader} from '@loaders.gl/terrain';
import {makeUTM18NTms} from './tileset-2d/tms-fixtures';
import {UTM18N} from '../core/viewports/crs-fixtures';

test('TerrainLayer#tileMatrixSet selects _CRSTileset2D and bakes exact common-space bounds', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const tileMatrixSet = makeUTM18NTms(6);

  const testCases = [
    {
      title: 'CRS-native terrain tiling',
      props: {
        elevationData: 'https://example.com/dem/{z}/{x}/{y}.png',
        tileMatrixSet,
        loaders: [TerrainLoader]
      },
      onAfterUpdate: ({layer, subLayers}) => {
        const tileLayer = subLayers[0];
        expect(tileLayer.state.tileset).toBeInstanceOf(CRSTileset2D);
        const tile = tileLayer.state.tileset.selectedTiles?.[0];
        if (tile) {
          expect((tile as any).boundsCommon).toBeDefined();
        }
      }
    }
  ];

  await testLayerAsync({
    Layer: TerrainLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/terrain-layer-crs.spec.ts`
Expected: FAIL — `subLayers[0].state.tileset` is the plain `Tileset2D` (`tileMatrixSet` is silently dropped today).

- [ ] **Step 3: Write the implementation**

Modify `modules/geo-layers/src/terrain-layer/terrain-layer.ts`:

1. Replace the top-of-file constants/`getOverlappedBounds` with imports from Task 1:

```ts
// Remove: const TILE_OVERLAP_PIXELS = 1; const MAX_LATITUDE = 90; const MAX_LONGITUDE = 180;
// Remove: function getOverlappedBounds(...) { ... }
// Add, alongside the existing imports:
import {resolveTiledTerrainBounds, getOverlappedBounds, MAX_LATITUDE, MAX_LONGITUDE} from './terrain-bounds';
```

(`MIN_TERRAIN_MESH_MAX_ERROR`/`getEffectiveMeshMaxError` stay in `terrain-layer.ts` — unrelated to tile bounds.)

2. Simplify `getTiledTerrainData` (replaces lines ~228–251, the bounds-computation block only; the `loadTerrain`/texture-fetch/`Promise.all` tail is unchanged):

```ts
  getTiledTerrainData(tile: TileLoadProps): Promise<MeshAndTexture> {
    const {elevationData, fetch, texture, elevationDecoder, meshMaxError} = this.props;
    const {viewport} = this.context;
    const dataUrl = getURLFromTemplate(elevationData, tile);
    const textureUrl = texture && getURLFromTemplate(texture, tile);
    const {signal} = tile;

    const {bounds, clampLngLat} = resolveTiledTerrainBounds(
      tile as unknown as {bbox: TileBoundingBox; boundsCommon?: Bounds},
      viewport
    );
    const overlappedBounds = getOverlappedBounds(bounds, this.props.tileSize, clampLngLat);

    const terrain = this.loadTerrain({
      elevationData: dataUrl,
      bounds: overlappedBounds,
      elevationDecoder,
      meshMaxError,
      signal
    });
    const surface = textureUrl
      ? fetch(textureUrl, {propName: 'texture', layer: this, loaders: [], signal}).catch(_ => null)
      : Promise.resolve(null);

    return Promise.all([terrain, surface]);
  }
```

(`GeoBoundingBox`, `TileBoundingBox` stay imported from `../tileset-2d/index` as before — `resolveTiledTerrainBounds`'s parameter type needs `TileBoundingBox` in scope.)

3. Forward `tileMatrixSet` in `renderLayers()` — add it to the destructure (~line 341) and to the `new TileLayer(...)` props object (~line 364), in both cases alongside `tileSize`:

```ts
  renderLayers(): Layer | null | LayersList {
    const {
      color,
      material,
      elevationData,
      texture,
      wireframe,
      meshMaxError,
      elevationDecoder,
      tileSize,
      tileMatrixSet,
      maxZoom,
      minZoom,
      extent,
      maxRequests,
      onTileLoad,
      onTileUnload,
      onTileError,
      maxCacheSize,
      maxCacheByteSize,
      refinementStrategy,
      zoomOffset
    } = this.props;

    if (this.state.isTiled) {
      return new TileLayer<MeshAndTexture>(
        this.getSubLayerProps({id: 'tiles'}),
        {
          getTileData: this.getTiledTerrainData.bind(this),
          renderSubLayers: this.renderSubLayers.bind(this),
          updateTriggers: {
            getTileData: {
              elevationData: urlTemplateToUpdateTrigger(elevationData),
              texture: urlTemplateToUpdateTrigger(texture),
              meshMaxError,
              elevationDecoder,
              projectionMode: this.context.viewport.projectionMode,
              zoomOffset
            }
          },
          onViewportLoad: this.onViewportLoad.bind(this),
          zRange: this.state.zRange || null,
          tileSize,
          tileMatrixSet,
          maxZoom,
          minZoom,
          extent,
          maxRequests,
          onTileLoad,
          onTileUnload,
          onTileError,
          maxCacheSize,
          maxCacheByteSize,
          refinementStrategy,
          zoomOffset
        }
      );
    }
    // ...unchanged below (non-tiled single-mesh path)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/terrain-layer-crs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Regression**

Run: `npx vitest run --project headless test/modules/geo-layers/terrain-layer.spec.ts test/modules/geo-layers/terrain-layer-loading.spec.ts && npx vitest run --project node test/modules/geo-layers/terrain-layer`
Expected: PASS — no changes to existing Mercator/non-tiled test assertions.

- [ ] **Step 6: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/terrain-layer/terrain-layer.ts test/modules/geo-layers/terrain-layer-crs.spec.ts
git add modules/geo-layers/src/terrain-layer/terrain-layer.ts test/modules/geo-layers/terrain-layer-crs.spec.ts
git commit -m "feat(geo-layers): TerrainLayer supports CRS-native tileMatrixSet elevation sources"
```

---

### Task 3: Verify `SimpleMeshLayer`/`CARTESIAN` positioning under pitch in CRS views

No source change. Proves the Part 2 claim: an app-computed `CARTESIAN` common-space position (via `crs.transform.forward` + Phase 1's common-space normalization, equivalently `viewport.projectFlat`) projects to the same screen pixel a pitched/bearing camera predicts, and that elevation Z survives the round trip unscaled (Decisions for review #3 — no new Z-scaling).

**Files:**
- Test: `test/modules/geo-layers/terrain-layer/cartesian-crs-pitch.node.spec.ts`

**Interfaces:**
- Consumes: `_CRSViewport` from `@deck.gl/core`, `normalizeCRS`/`lngLatToCommon` from `@deck.gl/core/viewports/crs-utils` (deep import — the same pattern Phase 3's spec already uses for `normalizeCRS`), `worldToPixels` from `@math.gl/web-mercator` (existing `@deck.gl/core` dependency — the exact function `Viewport.project()` uses internally, `modules/core/src/viewports/viewport.ts:248`), `UTM18N` from `test/modules/core/viewports/crs-fixtures.ts`.
- Produces: no new exports; a standalone regression spec.

- [ ] **Step 1: Write the test**

Create `test/modules/geo-layers/terrain-layer/cartesian-crs-pitch.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {normalizeCRS, lngLatToCommon} from '@deck.gl/core/viewports/crs-utils';
import {worldToPixels} from '@math.gl/web-mercator';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// The convention a CARTESIAN-positioned SimpleMeshLayer (e.g. Fathom's app-side-positioned
// bathymetry mesh) must follow in a CRS view: common-space XY via `lngLatToCommon` (the CRS's
// own forward transform + Phase 1's extent-normalization, equivalently `viewport.projectFlat`),
// Z as raw elevation meters — unchanged from classic Mercator (no new Z-scaling; Decisions for
// review #3). `crs` here is normalized independently of the viewport under test (fresh
// `normalizeCRS` call) so the two computations below are genuinely independent, not the same
// cached object reused twice.
const crs = normalizeCRS(UTM18N);

test('CARTESIAN position (app-computed via lngLatToCommon) matches viewport.projectFlat', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10,
    bearing: 20,
    pitch: 45
  });
  for (const lnglat of [
    [-72, 40],
    [-72.02, 40.01]
  ] as [number, number][]) {
    const [cx, cy] = lngLatToCommon(crs, lnglat);
    const [px, py] = viewport.projectFlat(lnglat);
    expect(cx).toBeCloseTo(px, 6);
    expect(cy).toBeCloseTo(py, 6);
  }
});

test('CARTESIAN mesh position projects to the same screen pixel the pitched camera predicts', () => {
  for (const pitch of [0, 30, 60]) {
    for (const bearing of [0, 45, 200]) {
      const viewport = new CRSViewport({
        crs: UTM18N,
        width: 800,
        height: 600,
        longitude: -72,
        latitude: 40,
        zoom: 12,
        bearing,
        pitch
      });
      const elevationMeters = 25; // e.g. a bathymetry mesh vertex above/below the datum
      const lnglat: [number, number] = [-72.001, 40.001];
      const [cx, cy] = lngLatToCommon(crs, lnglat);
      const common: [number, number, number] = [cx, cy, elevationMeters];

      // What CARTESIAN rendering does at the GPU: worldToPixels(commonSpaceXYZ, pixelProjectionMatrix).
      const pixel = worldToPixels(common, viewport.pixelProjectionMatrix);

      // Independently: project the same lnglat+elevation through the viewport's own
      // projectPosition (also common-space XY via projectFlat, Z passed through unscaled)
      // followed by the same pixel matrix — must agree with the app-computed point above.
      const expectedCommon = viewport.projectPosition([lnglat[0], lnglat[1], elevationMeters]);
      const expectedPixel = worldToPixels(expectedCommon, viewport.pixelProjectionMatrix);

      expect(pixel[0]).toBeCloseTo(expectedPixel[0], 6);
      expect(pixel[1]).toBeCloseTo(expectedPixel[1], 6);
      // Z survives the round trip unscaled (unproject recovers the same elevation)
      const unprojected = viewport.unprojectPosition(common);
      expect(unprojected[2]).toBeCloseTo(elevationMeters, 4);
    }
  }
});
```

- [ ] **Step 2: Run and verify it passes as-is (no source change expected)**

Run: `npx vitest run --project node test/modules/geo-layers/terrain-layer/cartesian-crs-pitch.node.spec.ts`
Expected: PASS with zero source changes, confirming Decisions for review #4 — if this fails, STOP: it means Phase 1's `CARTESIAN`/pitch camera math is not actually viewport-generic, which is a Phase 1 regression outside this plan's scope; do not paper over it here, escalate.

- [ ] **Step 3: Commit**

```bash
npx prettier --config .prettierrc --write test/modules/geo-layers/terrain-layer/cartesian-crs-pitch.node.spec.ts
git add test/modules/geo-layers/terrain-layer/cartesian-crs-pitch.node.spec.ts
git commit -m "test(geo-layers): verify CARTESIAN/pitch positioning for CRS-view 3D meshes"
```

---

### Task 4: Docs and app verification

**Files:**
- Modify: `docs/api-reference/geo-layers/terrain-layer.md`
- Modify: `docs/api-reference/core/crs-viewport.md`
- Modify: `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`
- Modify: `test/apps/crs-viewport/app.jsx`

- [ ] **Step 1: `terrain-layer.md`**

After the intro paragraph (before the JS/TS tabs, ~line 8), add:

```md
## CRS views

`elevationData` URL-template (tiled) sources render correctly inside a non-Mercator CRS
[`MapView`](../core/map-view.md#crs) when [`tileMatrixSet`](./tile-layer.md#tilematrixset) is
set — the same OGC TileMatrixSet indexing `TileLayer` already supports, reused unchanged here.
`TerrainLayer` then composes a `tileMatrixSet`-driven `TileLayer` internally (`_CRSTileset2D`),
and each tile's exact common-space rectangle (`boundsCommon`, an affine of the tile's native
CRS-grid rectangle — no reprojection needed) positions its mesh precisely, with no
reprojecting server. Elevation values are unaffected: decoded meters are baked as common-space
Z exactly as in a Mercator view.

The non-tiled single-mesh path (`bounds` prop, "world coordinates") already worked in CRS views
before this — the caller supplies pre-projected common-space units directly, the same
convention [`SimpleMeshLayer`](../mesh-layers/simple-mesh-layer.md) positioning uses.

Not supported in CRS views: warping a public Web-Mercator terrain-RGB source (e.g. Mapbox
Terrain-RGB, AWS/Terrarium tiles) without a `tileMatrixSet` — use a CRS-native elevation
service, or reproject it server-side. `zRange`-based visibility culling under pitch does not
yet account for terrain height in CRS views (a pre-existing `TileLayer`/`_CRSTileset2D`
limitation, tracked separately).
```

- [ ] **Step 2: `crs-viewport.md`**

Replace the `TerrainExtension`-only bullet in "Known not to work yet" (currently line 226) with two bullets — keep the `TerrainExtension` sentence, add a `TerrainLayer` line documenting the new support and its limit:

```md
* **`TerrainLayer`** renders CRS-native tiled elevation sources (set
  [`tileMatrixSet`](../geo-layers/tile-layer.md#tilematrixset)) correctly in CRS views;
  warping a public Web-Mercator terrain-RGB source (no `tileMatrixSet`) is not supported.
* **`TerrainExtension`** — its anchor math assumes a Mercator viewport.
```

- [ ] **Step 3: RFC future work**

In `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`'s "Future work" list, after the Phase 3 bullet, add:

```md
* **Phase 4 — Terrain/3D in CRS views** (implemented on this branch):
  `TerrainLayer` forwards `tileMatrixSet` to its internal `TileLayer`, reaching `_CRSTileset2D`
  and its exact `boundsCommon` tile rectangles — no reprojection needed for CRS-native
  elevation sources. `SimpleMeshLayer`/`COORDINATE_SYSTEM.CARTESIAN` 3D positioning under pitch
  is verified unchanged. Warping public Web-Mercator terrain-RGB sources and generalizing
  `TerrainExtension`'s Mercator anchor math to CRS views are both future work.
```

- [ ] **Step 4: App verification**

In `test/apps/crs-viewport/app.jsx`, add a `TerrainLayer` option to the UTM basemap selector (extending Task 4 of the Phase 3 plan's `utmBasemap` state) using a synthetic or public CRS-native DEM `tileMatrixSet` fixture (reuse `makeUTM18NTms`-style construction, or a small in-app TMS matching whatever demo elevation tiles are available), plus a separately toggled pitched `SimpleMeshLayer` demo mesh (a small synthetic seabed-like mesh positioned via `crs.transform.forward`, per Task 3's convention).

```bash
cd test/apps/crs-viewport && yarn && npx vite --config ../vite.config.local.mjs --host 0.0.0.0
```

Verify (screenshots into `.superpowers/sdd/`):
1. **UTM + CRS-native TerrainLayer**: mesh registers correctly against the graticule/vector overlays at multiple zooms; no console errors. Screenshot `task-p4-utm-terrain.png`.
2. **UTM + pitched SimpleMeshLayer**: pitch to 45-60deg, rotate; mesh stays correctly positioned and doesn't distort/drift. Screenshot `task-p4-utm-mesh-pitch.png`.
3. **Mercator regression**: existing `TerrainLayer` demos/tests unaffected (quick re-check).

- [ ] **Step 5: Full suite and wrap-up**

```bash
yarn test
```

Expected: PASS except the machine-known failures already recorded in `.superpowers/sdd/task-6-report.md`. Anything else: investigate before committing.

```bash
git add docs/api-reference/geo-layers/terrain-layer.md docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md test/apps/crs-viewport/app.jsx
git commit -m "docs(geo-layers): document CRS-view TerrainLayer and CARTESIAN mesh positioning"
```

Append a Phase 4 section to `.superpowers/sdd/progress.md` (tasks, findings, screenshot paths, suite results).

---

## Follow-ups (out of scope for this plan)

- Generalizing `TerrainExtension` to CRS views (CPU reference-viewport + a shader-side `PROJECTION_MODE_CRS` branch analogous to the Globe one).
- Warping public Web-Mercator terrain-RGB pyramids (Mapbox Terrain-RGB, AWS/Terrarium) into CRS views — an in-repo, fixed-grid elevation decode + mesh builder bypassing `@loaders.gl/terrain`'s Martini simplification.
- `zRange`-based visibility culling under pitch in CRS views (pre-existing Phase 2 limitation).
- Adaptive/distortion-aware terrain mesh resolution.
