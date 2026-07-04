# CRS Raster Warp (Phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Web-Mercator raster tile sources (OSM, Esri World Imagery) inside a non-Mercator CRS `MapView` via client-side per-tile mesh warping (`_WarpedTileLayer`).

**Architecture:** The OSM pyramid expressed as a Phase 2 `TileMatrixSet` over deck's 512-unit Mercator world + a `MercatorCRSTileset2D` that indexes it from a CRS view (ground-resolution level matching), rendered as one `SimpleMeshLayer` per tile whose (N+1)² vertex grid is transformed Mercator→lnglat→view-CRS common space exactly on CPU (`COORDINATE_SYSTEM.CARTESIAN`, instance-positioned for fp64 precision). Spec: `docs/superpowers/specs/2026-07-04-crs-raster-warp-design.md`.

**Tech Stack:** TypeScript, Vitest (`node` for pure math/tileset, `headless` for layer lifecycle), Phase 1 core (`_CRSViewport`), Phase 2 tile math (`tile-matrix-set.ts`), `@math.gl/web-mercator` (existing dep), `@deck.gl/mesh-layers` `SimpleMeshLayer` (existing dep, used the same way by `TerrainLayer`).

## Global Constraints

- Repo: `/Users/adamthomann/dev/deck.gl`, branch `feat/crs-mapview`. All paths relative to repo root.
- **No new runtime dependencies** (`@math.gl/web-mercator` and `@deck.gl/mesh-layers` are already `@deck.gl/geo-layers` dependencies).
- **Zero behavior change for existing paths**: no edits to `TileLayer`, `Tileset2D`, `CRSTileset2D`, or any shader. New files + exports only (plus docs).
- **No new shader/projection code** — rendering is stock `SimpleMeshLayer` in both GLSL and WGSL.
- License header on every new file:
  ```ts
  // deck.gl
  // SPDX-License-Identifier: MIT
  // Copyright (c) vis.gl contributors
  ```
- Run a single test file: `npx vitest run --project node <path>` (or `--project headless`). The node project only auto-discovers `test/modules/**/*.node.spec.ts`.
- Commit after every green test cycle; message style `feat(geo-layers): <summary>`. Prettier must pass (pre-commit hook enforces eslint + prettier + node vitest).
- Per-module `tsc` requires built dists (pre-existing TS6305 environment issue) — gates are eslint/prettier/vitest, as in Phase 2.
- Out of scope (do NOT implement): antimeridian wrap, texture gutters, cross-zoom fading, non-Mercator warp sources, terrain/zRange.

---

### Task 1: Warp math and mesh builder (`warp-mesh.ts`)

Pure functions: the WebMercatorQuad TMS over deck's 512-unit world, source-level selection, and the warped-mesh builder. No tileset or layer dependency.

**Files:**
- Create: `modules/geo-layers/src/warped-tile-layer/warp-mesh.ts`
- Test: `test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts`

**Interfaces:**
- Consumes (Phase 2): `normalizeTileMatrixSet`, type `NormalizedTileMatrixSet` from `../tileset-2d/tile-matrix-set`; `lngLatToWorld`/`worldToLngLat` from `@math.gl/web-mercator`.
- Produces (used by Tasks 2–3):
  - `MAX_MERCATOR_LATITUDE = 85.051129`
  - `type WarpTargetCRS = {code: string; units: 'meters' | 'degrees'; extent: [number, number, number, number]; commonUnitsPerCRSUnit: number; transform: {forward(lnglat: [number, number]): [number, number]; inverse(xy: [number, number]): [number, number]}}` — the shape of `_CRSViewport.crs` (same duck type as Phase 2's `CRSViewportLike['crs']`)
  - `makeWebMercatorQuadTms(tileSizePx: number, numLevels: number): NormalizedTileMatrixSet` — OSM pyramid in 512-unit Mercator world coordinates (`pointOfOrigin: [0, 512]`, `cornerOfOrigin: 'topLeft'`, level z: `2^z × 2^z`, `cellSize = 512 / (2^z · tileSizePx)`)
  - `selectMercatorSourceZoom(viewport: {zoom: number; latitude?: number; distanceScales: {metersPerUnit: number[]}}, tileSizePx: number, zoomOffset?: number): number` — `round(log2(C·cos(φ) / (tileSizePx · gView)) + zoomOffset)` with `gView = metersPerUnit[0] · 2^−zoom`
  - `type WarpedTileMesh = {origin: [number, number, number]; attributes: {positions: {value: Float32Array; size: 3}; texCoords: {value: Float32Array; size: 2}}; indices: {value: Uint32Array; size: 1}}`
  - `buildWarpedTileMesh(boundsWorld: [number, number, number, number], crs: WarpTargetCRS, resolution: number): WarpedTileMesh` — positions `Float32` **relative to `origin`** (the tile's top-left vertex in common space, computed in float64); `texCoords` v=0 at the image top; CCW triangle indices

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {
  makeWebMercatorQuadTms,
  selectMercatorSourceZoom,
  buildWarpedTileMesh,
  MAX_MERCATOR_LATITUDE
} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {getTileBoundsCRS} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {normalizeCRS} from '@deck.gl/core/viewports/crs-utils';

test('makeWebMercatorQuadTms#matches OSM tile math', () => {
  const tms = makeWebMercatorQuadTms(256, 5);
  expect(tms.tileMatrices).toHaveLength(5);
  expect(tms.tileMatrices[0].matrixWidth).toBe(1);
  expect(tms.tileMatrices[3].matrixWidth).toBe(8);
  expect(tms.tileMatrices[0].cellSize).toBe(2); // 512 world units / 256 px
  // tile (x, y, z) world bounds agree with osmTile2lngLat corners
  for (const [x, y, z] of [
    [0, 0, 0],
    [2, 1, 2],
    [5, 9, 4]
  ]) {
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tms.tileMatrices[z], x, y);
    const [westWorldX, northWorldY] = lngLatToWorld(osmTile2lngLat(x, y, z));
    const [eastWorldX, southWorldY] = lngLatToWorld(osmTile2lngLat(x + 1, y + 1, z));
    expect(minX).toBeCloseTo(westWorldX, 6);
    expect(maxY).toBeCloseTo(northWorldY, 6);
    expect(maxX).toBeCloseTo(eastWorldX, 6);
    expect(minY).toBeCloseTo(southWorldY, 6);
  }
});

test('selectMercatorSourceZoom#reduces to the OSM rule for a Mercator view', () => {
  // The OSM path uses round(zoom + log2(512 / tileSize)); the ground-resolution
  // formula must reproduce it when the view itself is Web Mercator
  for (const zoom of [0, 3.4, 7, 12.7]) {
    for (const lat of [0, 40, 70]) {
      const viewport = new WebMercatorViewport({
        width: 800,
        height: 600,
        longitude: -72,
        latitude: lat,
        zoom
      });
      expect(selectMercatorSourceZoom(viewport, 256)).toBe(Math.round(zoom + Math.log2(512 / 256)));
      expect(selectMercatorSourceZoom(viewport, 512)).toBe(Math.round(zoom));
    }
  }
});

test('selectMercatorSourceZoom#UTM view known answer', () => {
  // UTM 18N at lat 40: ground m/px = metersPerUnit * 2^-zoom.
  // commonUnitsPerCRSUnit = 512 / 667957.12, so at zoom 7 the view resolves
  // ~10.2 m/px ground; OSM 256px at lat 40 resolves C*cos(40)/(256*2^z) —
  // z should land at 12 (11.96 m/px) or 13; assert the formula's exact rounding.
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  const g = viewport.distanceScales.metersPerUnit[0] * 2 ** -7;
  const expected = Math.round(
    Math.log2((40075016.686 * Math.cos((40 * Math.PI) / 180)) / (256 * g))
  );
  expect(selectMercatorSourceZoom(viewport, 256)).toBe(expected);
  // zoomOffset shifts the result by exactly its value
  expect(selectMercatorSourceZoom(viewport, 256, 1)).toBe(expected + 1);
});

test('buildWarpedTileMesh#exact vertices for a 4326 target', () => {
  // For the built-in EPSG:4326 CRS, common space is linear in lnglat, so mesh
  // vertices must equal worldToLngLat of the grid points, scaled by 512/360
  const crs = normalizeCRS('EPSG:4326');
  const tms = makeWebMercatorQuadTms(256, 4);
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[2], 1, 1);
  const mesh = buildWarpedTileMesh(boundsWorld, crs, 4);
  const rows = 5;
  expect(mesh.attributes.positions.value).toHaveLength(rows * rows * 3);
  expect(mesh.attributes.texCoords.value).toHaveLength(rows * rows * 2);
  expect(mesh.indices.value).toHaveLength(4 * 4 * 6);
  // corner vertex (i=0, j=0) is the tile's top-left: matches osmTile2lngLat(1,1,2)
  const k = 512 / 360;
  const [west, north] = osmTile2lngLat(1, 1, 2);
  const expectX = (west - -180) * k;
  const expectY = (north - -90) * k;
  expect(mesh.origin[0]).toBeCloseTo(expectX, 6);
  expect(mesh.origin[1]).toBeCloseTo(expectY, 6);
  // positions are origin-relative: vertex 0 is exactly [0, 0, 0]
  expect(mesh.attributes.positions.value[0]).toBeCloseTo(0, 6);
  expect(mesh.attributes.positions.value[1]).toBeCloseTo(0, 6);
  // texCoords: v=0 at the image top, u/v span [0, 1]
  expect(mesh.attributes.texCoords.value[0]).toBe(0);
  expect(mesh.attributes.texCoords.value[1]).toBe(0);
  const last = rows * rows - 1;
  expect(mesh.attributes.texCoords.value[last * 2]).toBe(1);
  expect(mesh.attributes.texCoords.value[last * 2 + 1]).toBe(1);
});

test('buildWarpedTileMesh#UTM vertices match the exact transform', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 12);
  // An OSM z=11 tile over the UTM 18N anchor (-75, 0 -> easting 500000)
  const z = 11;
  const scale = 2 ** z;
  const x = Math.floor(((-75 + 180) / 360) * scale);
  const y = Math.floor(scale / 2); // equator row
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[z], x, y);
  const n = 8;
  const mesh = buildWarpedTileMesh(boundsWorld, crs, n);
  // center vertex: recompute independently through the same chain
  const cxWorld = (boundsWorld[0] + boundsWorld[2]) / 2;
  const cyWorld = (boundsWorld[1] + boundsWorld[3]) / 2;
  const lnglat = worldToLngLat([cxWorld, cyWorld]);
  const utm = UTM18N.transform.forward([lnglat[0], lnglat[1]]);
  const k = 512 / (UTM18N.extent[2] - UTM18N.extent[0]);
  const expectX = (utm[0] - UTM18N.extent[0]) * k;
  const expectY = (utm[1] - UTM18N.extent[1]) * k;
  const rows = n + 1;
  const center = (n / 2) * rows + n / 2;
  expect(mesh.origin[0] + mesh.attributes.positions.value[center * 3]).toBeCloseTo(expectX, 5);
  expect(mesh.origin[1] + mesh.attributes.positions.value[center * 3 + 1]).toBeCloseTo(
    expectY,
    5
  );
});

test('buildWarpedTileMesh#neighbor tiles share identical edge vertices (seams)', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 12);
  const z = 10;
  const x = 300;
  const y = 380;
  const n = 8;
  const rows = n + 1;
  const left = buildWarpedTileMesh(getTileBoundsCRS(tms.tileMatrices[z], x, y), crs, n);
  const right = buildWarpedTileMesh(getTileBoundsCRS(tms.tileMatrices[z], x + 1, y), crs, n);
  // left tile's right edge (i = n) equals right tile's left edge (i = 0), in absolute terms
  for (let j = 0; j <= n; j++) {
    const li = j * rows + n;
    const ri = j * rows + 0;
    const lxAbs = left.origin[0] + left.attributes.positions.value[li * 3];
    const rxAbs = right.origin[0] + right.attributes.positions.value[ri * 3];
    const lyAbs = left.origin[1] + left.attributes.positions.value[li * 3 + 1];
    const ryAbs = right.origin[1] + right.attributes.positions.value[ri * 3 + 1];
    // float32 relative-to-origin quantization only
    expect(Math.abs(lxAbs - rxAbs)).toBeLessThan(1e-5);
    expect(Math.abs(lyAbs - ryAbs)).toBeLessThan(1e-5);
  }
});

test('MAX_MERCATOR_LATITUDE export', () => {
  expect(MAX_MERCATOR_LATITUDE).toBeCloseTo(85.051129, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts`
Expected: FAIL — cannot resolve `@deck.gl/geo-layers/warped-tile-layer/warp-mesh`.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/warped-tile-layer/warp-mesh.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {worldToLngLat} from '@math.gl/web-mercator';
import {normalizeTileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '../tileset-2d/tile-matrix-set';

/** Width of deck's Mercator common-space world, and of the world expressed here */
const MERCATOR_WORLD_SIZE = 512;
/** Earth circumference at the equator, meters (matches @math.gl/web-mercator) */
const EARTH_CIRCUMFERENCE = 40075016.686;
/** Latitude bound of the square Web Mercator world */
export const MAX_MERCATOR_LATITUDE = 85.051129;

/** The shape of `_CRSViewport.crs` (duck-typed; same as Phase 2's CRSViewportLike['crs']) */
export type WarpTargetCRS = {
  code: string;
  units: 'meters' | 'degrees';
  extent: [number, number, number, number];
  commonUnitsPerCRSUnit: number;
  transform: {
    forward: (lnglat: [number, number]) => [number, number];
    inverse: (xy: [number, number]) => [number, number];
  };
};

/** The OSM/WebMercatorQuad pyramid as a TileMatrixSet over deck's 512-unit Mercator world.
 * World y grows northward, OSM row 0 is the top row: origin [0, 512], cornerOfOrigin topLeft. */
export function makeWebMercatorQuadTms(
  tileSizePx: number,
  numLevels: number
): NormalizedTileMatrixSet {
  return normalizeTileMatrixSet({
    id: 'WebMercatorQuad',
    crs: 'EPSG:3857',
    tileMatrices: Array.from({length: numLevels}, (_, z) => ({
      id: String(z),
      cellSize: MERCATOR_WORLD_SIZE / (2 ** z * tileSizePx),
      pointOfOrigin: [0, MERCATOR_WORLD_SIZE] as [number, number],
      tileWidth: tileSizePx,
      tileHeight: tileSizePx,
      matrixWidth: 2 ** z,
      matrixHeight: 2 ** z
    }))
  });
}

/** Source OSM level whose ground resolution at the view center best matches the view.
 * gView = metersPerUnit[0] * 2^-zoom; source level z resolves
 * C*cos(lat) / (tileSizePx * 2^z) ground meters per pixel. For a Web Mercator view this
 * reduces exactly to the OSM rule round(zoom + log2(512 / tileSize)). */
export function selectMercatorSourceZoom(
  viewport: {zoom: number; latitude?: number; distanceScales: {metersPerUnit: number[]}},
  tileSizePx: number,
  zoomOffset: number = 0
): number {
  const latitude = viewport.latitude ?? 0;
  const groundMetersPerPixel = viewport.distanceScales.metersPerUnit[0] * 2 ** -viewport.zoom;
  const z = Math.log2(
    (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) /
      (tileSizePx * groundMetersPerPixel)
  );
  return Math.round(z + zoomOffset);
}

export type WarpedTileMesh = {
  /** Tile top-left vertex in common space (float64) — use as the instance position */
  origin: [number, number, number];
  attributes: {
    /** Vertex positions relative to `origin`, row-major from the image top-left */
    positions: {value: Float32Array; size: 3};
    /** Texture coordinates; v = 0 at the image top */
    texCoords: {value: Float32Array; size: 2};
  };
  indices: {value: Uint32Array; size: 1};
};

/** Build the warped grid mesh for one Mercator tile: an N x N cell grid whose vertices are
 * transformed Mercator world -> lnglat -> target CRS -> common space with the exact injected
 * transform (not the shader linearization). Positions are stored float32 relative to the
 * tile's top-left vertex (`origin`, computed in float64) so precision holds at any zoom. */
export function buildWarpedTileMesh(
  boundsWorld: [number, number, number, number],
  crs: WarpTargetCRS,
  resolution: number
): WarpedTileMesh {
  const n = Math.max(1, Math.round(resolution));
  const rows = n + 1;
  const [minX, minY, maxX, maxY] = boundsWorld;
  const {transform, extent, commonUnitsPerCRSUnit} = crs;

  // Exact vertex positions in common space, float64
  const common = new Float64Array(rows * rows * 2);
  for (let j = 0; j <= n; j++) {
    // Row 0 is the image top = world maxY
    const wy = maxY + ((minY - maxY) * j) / n;
    for (let i = 0; i <= n; i++) {
      const wx = minX + ((maxX - minX) * i) / n;
      const [lng, lat] = worldToLngLat([wx, wy]);
      const xy = transform.forward([lng, lat]);
      const k = (j * rows + i) * 2;
      common[k] = (xy[0] - extent[0]) * commonUnitsPerCRSUnit;
      common[k + 1] = (xy[1] - extent[1]) * commonUnitsPerCRSUnit;
    }
  }

  const origin: [number, number, number] = [common[0], common[1], 0];
  const positions = new Float32Array(rows * rows * 3);
  const texCoords = new Float32Array(rows * rows * 2);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * rows + i;
      positions[v * 3] = common[v * 2] - origin[0];
      positions[v * 3 + 1] = common[v * 2 + 1] - origin[1];
      positions[v * 3 + 2] = 0;
      texCoords[v * 2] = i / n;
      texCoords[v * 2 + 1] = j / n;
    }
  }

  const indices = new Uint32Array(n * n * 6);
  let c = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const topLeft = j * rows + i;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + rows;
      const bottomRight = bottomLeft + 1;
      // CCW in y-up common space (row j is above row j+1)
      indices[c++] = topLeft;
      indices[c++] = bottomLeft;
      indices[c++] = topRight;
      indices[c++] = topRight;
      indices[c++] = bottomLeft;
      indices[c++] = bottomRight;
    }
  }

  return {
    origin,
    attributes: {
      positions: {value: positions, size: 3},
      texCoords: {value: texCoords, size: 2}
    },
    indices: {value: indices, size: 1}
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/warped-tile-layer/warp-mesh.ts test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts
git add modules/geo-layers/src/warped-tile-layer/warp-mesh.ts test/modules/geo-layers/warped-tile-layer/warp-mesh.node.spec.ts
git commit -m "feat(geo-layers): add Mercator warp math and mesh builder"
```

---

### Task 2: `MercatorCRSTileset2D`

Indexes the Mercator pyramid from a CRS view: view corners → lnglat (clamped to the Mercator latitude domain) → world units → Phase 2 grid math. Quadtree parents. Same CRS-swap flush and loop-safety policies as `CRSTileset2D`.

**Files:**
- Create: `modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts`
- Test: `test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts`

**Interfaces:**
- Consumes (Task 1): `makeWebMercatorQuadTms`, `selectMercatorSourceZoom`, `MAX_MERCATOR_LATITUDE`, type `WarpTargetCRS`.
- Consumes (Phase 2): `Tileset2D`, `Tileset2DProps`, `getTileIndicesInBounds`, `getTileBoundsCRS`; `lngLatToWorld`/`worldToLngLat` from `@math.gl/web-mercator`.
- Produces (Task 3):
  - `class MercatorCRSTileset2D extends Tileset2D`; overrides `getTileIndices`, `getTileMetadata`, `getParentIndex`, `setOptions` (inherits `getTileId`, `getTileZoom`).
  - Tile index is plain OSM `{x, y, z}` (so `{z}/{x}/{y}` and `{-y}` URL templates work unchanged — the pyramid is a true quadtree).
  - Tile metadata: `bbox: GeoBoundingBox` (exact, from `osmTile2lngLat`-equivalent corners), `boundsWorld: [minX, minY, maxX, maxY]` (512-unit Mercator world rect — the mesh builder's input).
  - Throws the informative CRS-view error when the viewport has no `crs`.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {lngLatToWorld} from '@math.gl/web-mercator';
import {MercatorCRSTileset2D} from '@deck.gl/geo-layers/warped-tile-layer/mercator-crs-tileset-2d';
import {selectMercatorSourceZoom} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';

const getTileData = () => Promise.resolve(null);

function makeUTMViewport(zoom: number) {
  return new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom
  });
}

test('MercatorCRSTileset2D#selects the ground-resolution-matched OSM level', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = makeUTMViewport(7);
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  const expectedZ = selectMercatorSourceZoom(viewport, 256);
  expect(new Set(tiles.map(t => t.zoom))).toEqual(new Set([expectedZ]));
  // every selected tile's lnglat bbox intersects the viewport's lnglat bounds
  const [west, south, east, north] = viewport.getBounds();
  for (const tile of tiles) {
    const bbox = tile.bbox as {west: number; south: number; east: number; north: number};
    expect(bbox.west).toBeLessThan(east);
    expect(bbox.east).toBeGreaterThan(west);
    expect(bbox.south).toBeLessThan(north);
    expect(bbox.north).toBeGreaterThan(south);
  }
});

test('MercatorCRSTileset2D#metadata: exact OSM bbox and world-unit bounds', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = makeUTMViewport(7);
  tileset.update(viewport);
  const tile = tileset.selectedTiles![0];
  const {x, y, z} = tile.index as {x: number; y: number; z: number};
  const [west, north] = osmTile2lngLat(x, y, z);
  const [east, south] = osmTile2lngLat(x + 1, y + 1, z);
  const bbox = tile.bbox as {west: number; south: number; east: number; north: number};
  expect(bbox.west).toBeCloseTo(west, 6);
  expect(bbox.north).toBeCloseTo(north, 6);
  expect(bbox.east).toBeCloseTo(east, 6);
  expect(bbox.south).toBeCloseTo(south, 6);
  const boundsWorld = (tile as any).boundsWorld as [number, number, number, number];
  const [wx, ny] = lngLatToWorld([west, north]);
  expect(boundsWorld[0]).toBeCloseTo(wx, 6);
  expect(boundsWorld[3]).toBeCloseTo(ny, 6);
});

test('MercatorCRSTileset2D#quadtree parent and root guard', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  tileset.update(makeUTMViewport(7));
  const tile = tileset.selectedTiles![0];
  const {x, y, z} = tile.index as {x: number; y: number; z: number};
  expect(tileset.getParentIndex(tile.index)).toEqual({x: x >> 1, y: y >> 1, z: z - 1});
  expect(tileset.getParentIndex({x: 0, y: 0, z: 0})).toEqual({x: 0, y: 0, z: 0});
});

test('MercatorCRSTileset2D#throws without a CRS viewport', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const fakeViewport = {zoom: 4, width: 100, height: 100, unproject: () => [0, 0]};
  expect(() =>
    tileset.getTileIndices({
      viewport: fakeViewport as any,
      minZoom: undefined,
      maxZoom: undefined,
      zRange: null
    })
  ).toThrow(/CRS view/);
});

test('MercatorCRSTileset2D#maxZoom clamps the source level; negative minZoom clamps to 0', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256, maxZoom: 5, minZoom: -3});
  tileset.update(makeUTMViewport(10)); // would select a deep source level
  expect(new Set(tileset.selectedTiles!.map(t => t.zoom))).toEqual(new Set([5]));
  expect((tileset as any)._minZoom).toBe(0);
});

test('MercatorCRSTileset2D#4326 view: whole-world latitude clamp', () => {
  // A whole-world 4326 view sees latitudes beyond the Mercator domain; corner
  // clamping must produce the full valid grid rather than NaN indices
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: 0.5
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) {
    const {x, y, z} = tile.index as {x: number; y: number; z: number};
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2 ** z);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(2 ** z);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Viewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {Tileset2D, Tileset2DProps} from '../tileset-2d/tileset-2d';
import {getTileBoundsCRS, getTileIndicesInBounds} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {Bounds, TileIndex} from '../tileset-2d/types';
import {
  makeWebMercatorQuadTms,
  selectMercatorSourceZoom,
  MAX_MERCATOR_LATITUDE
} from './warp-mesh';
import type {WarpTargetCRS} from './warp-mesh';

type CRSViewportLike = Viewport & {crs: WarpTargetCRS};

/** OSM's deepest commonly served level */
const MAX_SOURCE_LEVELS = 23;

/** Indexes a Web-Mercator XYZ pyramid (OSM, Esri, ...) from a CRS view
 * (a `MapView` with a non-Mercator `crs`). Used by `_WarpedTileLayer`. */
export class MercatorCRSTileset2D extends Tileset2D {
  private _tms: NormalizedTileMatrixSet | null = null;
  private _tmsTileSize: number | null = null;
  private _crsViewport: CRSViewportLike | null = null;
  private _crsCode: string | null = null;

  setOptions(opts: Tileset2DProps): void {
    // Same loop-safety policy as CRSTileset2D: getParentIndex returns the root
    // index unchanged at z 0, so the ancestor walk must never see a negative floor
    if (typeof opts.minZoom === 'number' && opts.minZoom < 0) {
      opts = {...opts, minZoom: 0};
    }
    super.setOptions(opts);
  }

  getTileIndices({
    viewport,
    maxZoom,
    minZoom
  }: Parameters<Tileset2D['getTileIndices']>[0]): TileIndex[] {
    const crsViewport = viewport as CRSViewportLike;
    if (!crsViewport.crs) {
      throw new Error(
        '_WarpedTileLayer requires a CRS view — set the `crs` prop on MapView (use TileLayer in Web Mercator views)'
      );
    }
    // Flush tiles whose metadata/meshes were computed under a different CRS.
    // Note: finalize() drops tiles without firing onTileUnload (same caveat as CRSTileset2D)
    if (this._crsCode !== null && this._crsCode !== crsViewport.crs.code) {
      this.finalize();
      this._tms = null;
    }
    this._crsViewport = crsViewport;
    this._crsCode = crsViewport.crs.code;

    const {tileSize, zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }
    if (!this._tms || this._tmsTileSize !== tileSize) {
      this._tms = makeWebMercatorQuadTms(tileSize, MAX_SOURCE_LEVELS);
      this._tmsTileSize = tileSize;
    }

    let z = selectMercatorSourceZoom(crsViewport, tileSize, zoomOffset);
    if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
      // Same policy as the OSM path and CRSTileset2D: without an extent to bound
      // the area, fetching far-below-view minZoom tiles could request the world
      if (!extent) {
        return [];
      }
      z = minZoom;
    }
    if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
      z = maxZoom;
    }
    z = Math.max(0, Math.min(z, this._tms.tileMatrices.length - 1));

    const bounds = this._getViewBoundsWorld(crsViewport, (extent as Bounds | null) || null);
    if (!bounds) {
      return [];
    }
    return getTileIndicesInBounds(this._tms.tileMatrices[z], bounds).map(({x, y}) => ({
      x,
      y,
      z
    }));
  }

  getTileMetadata(index: TileIndex): Record<string, any> {
    const tms = this._tms;
    if (!tms) {
      return {};
    }
    const boundsWorld = getTileBoundsCRS(tms.tileMatrices[index.z], index.x, index.y);
    const [west, north] = worldToLngLat([boundsWorld[0], boundsWorld[3]]);
    const [east, south] = worldToLngLat([boundsWorld[2], boundsWorld[1]]);
    return {
      bbox: {west, north, east, south},
      boundsWorld
    };
  }

  getParentIndex(index: TileIndex): TileIndex {
    if (index.z <= 0) {
      return index;
    }
    return {x: index.x >> 1, y: index.y >> 1, z: index.z - 1};
  }

  /** View bounds in 512-unit Mercator world coordinates. Latitudes are clamped to the
   * Mercator domain; non-finite unprojections fall back to the world bounds. */
  private _getViewBoundsWorld(viewport: CRSViewportLike, extentLngLat: Bounds | null): Bounds | null {
    const {width, height} = viewport;
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height]
    ].map(pixel => viewport.unproject(pixel));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hadNonFiniteCorner = false;
    for (const lnglat of corners) {
      if (Number.isFinite(lnglat[0]) && Number.isFinite(lnglat[1])) {
        const [wx, wy] = lngLatToWorld([
          Math.min(Math.max(lnglat[0], -180), 180),
          Math.min(Math.max(lnglat[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
        ]);
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
      } else {
        hadNonFiniteCorner = true;
      }
    }
    if (hadNonFiniteCorner) {
      minX = Math.min(minX, 0);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, 512);
      maxY = Math.max(maxY, 512);
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    if (extentLngLat) {
      const [west, south, east, north] = extentLngLat;
      const [eMinX, eMinY] = lngLatToWorld([
        Math.min(Math.max(west, -180), 180),
        Math.min(Math.max(south, -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
      ]);
      const [eMaxX, eMaxY] = lngLatToWorld([
        Math.min(Math.max(east, -180), 180),
        Math.min(Math.max(north, -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
      ]);
      minX = Math.max(minX, eMinX);
      minY = Math.max(minY, eMinY);
      maxX = Math.min(maxX, eMaxX);
      maxY = Math.min(maxY, eMaxY);
      if (!(minX < maxX) || !(minY < maxY)) {
        return null;
      }
    }
    return [minX, minY, maxX, maxY];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts`
Expected: PASS (6 tests). Also re-run Task 1's spec.

- [ ] **Step 5: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts
git add modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts test/modules/geo-layers/warped-tile-layer/mercator-crs-tileset-2d.node.spec.ts
git commit -m "feat(geo-layers): index Web-Mercator pyramids from CRS views"
```

---

### Task 3: `_WarpedTileLayer`, exports, docs

The layer: locks `TilesetClass` to `MercatorCRSTileset2D`, renders each loaded tile as a
`SimpleMeshLayer` with a memoized warped mesh.

**Files:**
- Create: `modules/geo-layers/src/warped-tile-layer/warped-tile-layer.ts`
- Modify: `modules/geo-layers/src/index.ts` (exports, after the `_CRSTileset2D` line)
- Create: `docs/api-reference/geo-layers/warped-tile-layer.md`
- Modify: `docs/table-of-contents.json` (add `"api-reference/geo-layers/warped-tile-layer"` next to the tile-layer entry)
- Modify: `docs/api-reference/core/crs-viewport.md` (limitations: raster basemaps now possible via `_WarpedTileLayer`)
- Modify: `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md` (Phase 3 bullet: implemented on this branch)
- Test: `test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts` (headless)

**Interfaces:**
- Consumes: Tasks 1–2; `SimpleMeshLayer` from `@deck.gl/mesh-layers`; `COORDINATE_SYSTEM` from `@deck.gl/core`.
- Produces (public API):
  - `_WarpedTileLayer` exported from `@deck.gl/geo-layers`; props = `TileLayerProps` minus meaning-changed ones plus `_meshResolution?: number` (default 16). `minZoom`/`maxZoom` are SOURCE OSM levels; `tileMatrixSet` is not a prop of this layer.
  - Default `renderSubLayers` builds `SimpleMeshLayer` with: `data: [0]` (one instance), `mesh` = warped mesh attributes/indices, `texture` = tile image, `coordinateSystem: COORDINATE_SYSTEM.CARTESIAN`, `getPosition: () => mesh.origin` (instanced positioning keeps fp64 precision — deliberately NOT TerrainLayer's `_instanced: false`, which stores absolute fp32 positions), `textureParameters` with clamp-to-edge.
  - Mesh memoized on `tile.userData.warpedMesh` keyed by `(crs.code, _meshResolution)`.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global ImageData */
import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {MercatorCRSTileset2D} from '@deck.gl/geo-layers/warped-tile-layer/mercator-crs-tileset-2d';
import {Proj4Projection} from '@math.gl/proj4';

const utm18n = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});
const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18n.project(lnglat) as [number, number],
    inverse: xy => utm18n.unproject(xy) as [number, number]
  },
  extent: [166021.44, 0, 833978.56, 9329005.18] as [number, number, number, number],
  units: 'meters' as const
};

test('WarpedTileLayer#renders SimpleMeshLayer sublayers in a UTM view', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 7}
  })!;

  const testCases = [
    {
      title: 'warped tiles',
      props: {
        getTileData: () => Promise.resolve(new ImageData(4, 4))
      },
      onAfterUpdate: ({layer, subLayers}) => {
        expect(layer.state.tileset).toBeInstanceOf(MercatorCRSTileset2D);
        if (layer.isLoaded) {
          const meshLayers = subLayers.filter(l => l instanceof SimpleMeshLayer);
          expect(meshLayers.length).toBeGreaterThan(0);
          for (const meshLayer of meshLayers) {
            const {mesh, getPosition} = meshLayer.props;
            const positions = mesh.attributes.positions.value;
            for (const v of positions) {
              expect(Number.isFinite(v)).toBe(true);
            }
            const origin = getPosition(0);
            expect(Number.isFinite(origin[0])).toBe(true);
            // common-space origin is inside the 512-unit world
            expect(origin[0]).toBeGreaterThanOrEqual(0);
            expect(origin[0]).toBeLessThanOrEqual(512);
          }
          // memoized: the mesh is cached on the tile
          const tile = layer.state.tileset.selectedTiles[0];
          expect(tile.userData?.warpedMesh).toBeDefined();
        }
      }
    }
  ];

  await testLayerAsync({
    Layer: WarpedTileLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
```

(If `isLoaded` timing makes the sublayer assertions flaky under `testLayerAsync`, follow the
existing `tile-layer.spec.ts` pattern of a second `updateProps` case to allow the async load to
settle — the assertions themselves stay as written.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts`
Expected: FAIL — `_WarpedTileLayer` is not exported.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/warped-tile-layer/warped-tile-layer.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {COORDINATE_SYSTEM, DefaultProps, Layer, LayersList} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import type {TileLayerProps} from '../tile-layer/tile-layer';
import TileLayer from '../tile-layer/tile-layer';
import type {Tile2DHeader} from '../tileset-2d/index';
import {MercatorCRSTileset2D} from './mercator-crs-tileset-2d';
import {buildWarpedTileMesh} from './warp-mesh';
import type {WarpTargetCRS, WarpedTileMesh} from './warp-mesh';

const defaultProps: DefaultProps<WarpedTileLayerProps> = {
  ...(TileLayer as any).defaultProps,
  TilesetClass: MercatorCRSTileset2D,
  tileSize: 256,
  maxZoom: 19,
  _meshResolution: 16
};

/** Props added by WarpedTileLayer. `minZoom`/`maxZoom` are SOURCE (OSM) levels. */
export type WarpedTileLayerProps<DataT = unknown> = TileLayerProps<DataT> & {
  /** Warp grid cells per tile edge. Higher is more accurate for strongly curved CRSs.
   * The default is sub-pixel for UTM-class CRSs at any usable zoom. @default 16 */
  _meshResolution?: number;
};

/** Renders a Web-Mercator raster XYZ pyramid (OSM, Esri World Imagery, ...) inside a
 * non-Mercator CRS MapView by warping each tile's image over an exactly reprojected
 * vertex grid (client-side, no reprojecting server). Experimental. */
export default class WarpedTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends TileLayer<
  DataT,
  ExtraPropsT & Required<{_meshResolution?: number}>
> {
  static layerName = 'WarpedTileLayer';
  static defaultProps = defaultProps;

  renderSubLayers(
    props: WarpedTileLayerProps<DataT> & {
      id: string;
      data: DataT;
      _offset: number;
      tile: Tile2DHeader<DataT>;
    }
  ): Layer | null | LayersList {
    const crs = (this.context.viewport as any).crs as WarpTargetCRS | undefined;
    if (!crs) {
      return null;
    }
    const {tile} = props;
    const resolution = this.props._meshResolution;
    const mesh = this._getWarpedMesh(tile, crs, resolution);
    return new SimpleMeshLayer(props as any, {
      id: `${props.id}-warped`,
      data: [0],
      mesh: {attributes: mesh.attributes, indices: mesh.indices},
      texture: props.data as any,
      textureParameters: {addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'},
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      // Instanced positioning: the fp64-split instance position carries the tile's
      // common-space origin; fp32 mesh positions stay origin-relative and tiny.
      // (Deliberately not TerrainLayer's `_instanced: false`, which would store
      // absolute fp32 positions and lose precision at high zoom.)
      getPosition: () => mesh.origin,
      getColor: [255, 255, 255],
      pickable: false
    });
  }

  private _getWarpedMesh(
    tile: Tile2DHeader<DataT>,
    crs: WarpTargetCRS,
    resolution: number
  ): WarpedTileMesh {
    const key = `${crs.code}/${resolution}`;
    tile.userData = tile.userData || {};
    const cached = tile.userData.warpedMesh as {key: string; mesh: WarpedTileMesh} | undefined;
    if (cached && cached.key === key) {
      return cached.mesh;
    }
    const mesh = buildWarpedTileMesh(
      (tile as any).boundsWorld as [number, number, number, number],
      crs,
      resolution
    );
    tile.userData.warpedMesh = {key, mesh};
    return mesh;
  }
}
```

Modify `modules/geo-layers/src/index.ts` — after the `_CRSTileset2D` export lines:

```ts
export {default as _WarpedTileLayer} from './warped-tile-layer/warped-tile-layer';
export type {WarpedTileLayerProps as _WarpedTileLayerProps} from './warped-tile-layer/warped-tile-layer';
```

(Check the imports actually used against eslint; `TileLayer` is a default export —
`import TileLayer from '../tile-layer/tile-layer'` matches the module's `export default`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts`
Expected: PASS.

- [ ] **Step 5: Regression**

Run: `npx vitest run --project node test/modules/geo-layers && npx vitest run --project headless test/modules/geo-layers/tile-layer test/modules/geo-layers/tileset-2d`
Expected: PASS — no existing spec changes.

- [ ] **Step 6: Docs**

Create `docs/api-reference/geo-layers/warped-tile-layer.md`:

````md
# WarpedTileLayer (Experimental)

`_WarpedTileLayer` renders a Web-Mercator raster tile pyramid (OSM, Esri World Imagery — any
plain `{z}/{x}/{y}` XYZ service) inside a `MapView` with a non-Mercator
[`crs`](../core/map-view.md#crs), with no reprojecting server. Each tile is drawn as a small
warped mesh: a grid of vertices is reprojected Mercator → the view CRS exactly on the CPU, and
the tile image is texture-mapped across it on the GPU (triangulated reprojection).

```js
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {MapView} from '@deck.gl/core';

const layer = new WarpedTileLayer({
  data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSize: 256,
  maxZoom: 19
});
// rendered with: new MapView({crs: myUTMDefinition})
```

Inherits all [TileLayer](./tile-layer.md) properties with these differences:

- `minZoom`/`maxZoom` refer to the **source** (OSM) pyramid levels. The source level is chosen
  by matching ground resolution at the view center.
- `tileMatrixSet` does not apply (the source grid is the fixed Web-Mercator pyramid). For tile
  services native to the view CRS, use [TileLayer with
  `tileMatrixSet`](./tile-layer.md#tilematrixset) instead.
- `tileSize` is the source tile's pixel size (256 for OSM; some services are 512).
- `zRange` is ignored (no terrain in CRS views).
- The default `renderSubLayers` produces a textured mesh (`SimpleMeshLayer`), not GeoJSON.

##### `_meshResolution` (number, optional) {#_meshresolution}

- Default: `16`

Warp grid cells per tile edge. Vertices are exact; between them the GPU interpolates linearly.
The default is sub-pixel (≤0.15 px) for UTM-class CRSs even at continental zooms; raise it only
for unusually curved custom CRSs.

## Quality and performance envelope

- Warp is exact at grid vertices at any view scale (full CRS transform on CPU, float64, with
  origin-relative float32 attributes for GPU precision).
- Hairline seams can appear at tile borders (linear texture filtering, no gutters), and
  momentary cracks between zoom levels while children load (`best-available` refinement shows
  the parent underneath). Accepted tradeoffs of client-side warping.
- Source level matches ground resolution at the view center; across very wide views the
  effective source resolution drifts by Mercator's `cos(latitude)` factor.
- Views crossing the antimeridian are not supported.
````

Modify `docs/table-of-contents.json`: add `"api-reference/geo-layers/warped-tile-layer"`
immediately after the `"api-reference/geo-layers/tile-layer"` entry (match the file's exact
string format).

Modify `docs/api-reference/core/crs-viewport.md` — in the "Known not to work yet" section,
replace the remaining raster/basemap gap wording so it reads (keep the `TerrainExtension`
bullet as is):

```md
* Web-Mercator raster basemaps (OSM, Esri) render in CRS views via the experimental
  [`_WarpedTileLayer`](../geo-layers/warped-tile-layer.md) (client-side triangulated
  reprojection). `MVTLayer` and `_WMSLayer` are not yet CRS-aware.
```

Modify `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md` — Phase 3 bullet, prefix with
"(implemented on this branch)" and reference `_WarpedTileLayer`, mirroring the Phase 2 bullet's
style.

- [ ] **Step 7: Prettier, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/warped-tile-layer/warped-tile-layer.ts modules/geo-layers/src/index.ts test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts docs/api-reference/geo-layers/warped-tile-layer.md docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md
git add modules/geo-layers/src/warped-tile-layer modules/geo-layers/src/index.ts test/modules/geo-layers/warped-tile-layer docs/api-reference/geo-layers/warped-tile-layer.md docs/table-of-contents.json docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md
git commit -m "feat(geo-layers): add WarpedTileLayer for Mercator rasters in CRS views"
```

---

### Task 4: Visual verification (extend `test/apps/crs-viewport`)

The Phase 3 acceptance check: OSM and Esri imagery as basemaps in the UTM 18N mode.

**Files:**
- Modify: `test/apps/crs-viewport/app.jsx`

**Interfaces:**
- Consumes: `_WarpedTileLayer` (Task 3), existing app scaffolding (CRS buttons, `showTiles`).
- Produces: human verification + screenshots; nothing downstream.

- [ ] **Step 1: Add a basemap selector for the UTM mode**

In `test/apps/crs-viewport/app.jsx`:

1. Add to imports: `import {TileLayer, _WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';` (extending the existing `@deck.gl/geo-layers` import).
2. Add state: `const [utmBasemap, setUtmBasemap] = useState('osm'); // 'grid' | 'osm' | 'esri'`
3. In the UTM branch of the tile-layer construction, keep the existing debug-grid `TileLayer`
   for `utmBasemap === 'grid'`, and add:

```jsx
    } else if (crsName === 'UTM 18N') {
      if (utmBasemap === 'grid') {
        // ... existing debug-grid TileLayer unchanged ...
      } else {
        tileLayers.push(
          new WarpedTileLayer({
            id: `warped-${utmBasemap}`,
            data:
              utmBasemap === 'esri'
                ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            tileSize: 256,
            maxZoom: 19
          })
        );
      }
    }
```

4. Add a selector to the controls div, shown only in UTM mode:

```jsx
        {crsName === 'UTM 18N' && (
          <select value={utmBasemap} onChange={e => setUtmBasemap(e.target.value)}>
            <option value="grid">tile grid</option>
            <option value="osm">OSM (warped)</option>
            <option value="esri">Esri imagery (warped)</option>
          </select>
        )}
```

- [ ] **Step 2: Run and verify visually**

```bash
cd test/apps/crs-viewport && yarn && npx vite --config ../vite.config.local.mjs --host 0.0.0.0
```

Verify (Playwright headless script per the Phase 2 pattern; screenshots into
`.superpowers/sdd/`):

1. **UTM + OSM (warped)**: streets/coastline render under the vector layers; the graticule and
   state borders sit exactly on the imagery (georeferencing proof); labels readable (warp
   quality); grid-north tilt visible vs the graticule. Screenshot `task-p3-utm-osm.png`.
2. **UTM + Esri imagery**: same checks with satellite imagery. Screenshot
   `task-p3-utm-esri.png`.
3. **Zoom sweep**: from zone-wide to street level — source levels advance (network requests
   show increasing `{z}`), no blank frames beyond normal load-in, no console errors, imagery
   stays registered against vectors at high zoom (precision check for the origin-relative
   mesh).
4. **Pitch/rotate**: pitch to 60°, rotate — no geometry blowups; over-fetch acceptable.
5. **Mercator + EPSG:4326 modes unchanged** (regression): quick re-check of both.

- [ ] **Step 3: Full suite and wrap-up**

```bash
yarn test
```

Expected: PASS except the machine-known failures recorded in `.superpowers/sdd/task-6-report.md`
(loading-widget spinner; geojson-text render goldens; deckgl mount/unmount flake under load).
Anything else: investigate before committing.

```bash
git add test/apps/crs-viewport/app.jsx
git commit -m "test(geo-layers): verify warped OSM/Esri basemaps in the UTM app mode"
```

Append a Phase 3 section to `.superpowers/sdd/progress.md` (tasks, findings, screenshot paths,
suite results).

---

## Follow-ups (out of scope for this plan)

- Texture gutters / edge-padding to eliminate hairline tile seams.
- Antimeridian-crossing views (split meshes at the ±180 cut).
- Generalize the warp source beyond Web Mercator (any TMS → any CRS).
- Cross-zoom fade-in and retina (`@2x`) source support.
- `_WMSLayer`/`MVTLayer` CRS support (Phase 2 follow-up, unchanged).
