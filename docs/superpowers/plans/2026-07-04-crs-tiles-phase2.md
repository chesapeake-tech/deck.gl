# CRS Tiles (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `TileLayer` work in non-Mercator CRS `MapView`s by adding OGC TileMatrixSet-driven tile indexing to `@deck.gl/geo-layers`.

**Architecture:** A pure-math TileMatrixSet module (`tile-matrix-set.ts`) + a `CRSTileset2D` subclass of `Tileset2D` that selects tile-matrix levels from the viewport's CRS-units-per-pixel and indexes tiles in CRS coordinates, exposed through a new `TileLayer.tileMatrixSet` prop. Spec: `docs/superpowers/specs/2026-07-04-crs-tiles-design.md`.

**Tech Stack:** TypeScript, Vitest (`node` project for pure math/tileset, `headless` for layer lifecycle), Phase 1 CRS core (`_CRSViewport`, `MapView.crs`), `@math.gl/proj4` (tests only).

## Global Constraints

- Repo: `/Users/adamthomann/dev/deck.gl`, branch `feat/crs-mapview`. All paths relative to repo root.
- **No new runtime dependencies.** TMS definitions are plain JSON-shaped objects supplied by the app.
- **Zero behavior change without the new prop**: `TileLayer` without `tileMatrixSet` must be bit-identical to today (OSM path untouched). Existing tile tests must keep passing.
- License header on every new file:
  ```ts
  // deck.gl
  // SPDX-License-Identifier: MIT
  // Copyright (c) vis.gl contributors
  ```
- Run a single test file: `npx vitest run --project node <path>` (or `--project headless` for `.spec.ts`). Node project only auto-discovers `test/modules/**/*.node.spec.ts`.
- Commit after every green test cycle. Message style: `feat(geo-layers): <summary>`.
- Prettier must pass (`npx prettier --config .prettierrc --write <files>` before committing; the pre-commit hook enforces it).
- Out of scope (documented follow-ups, do NOT implement): WMSLayer TMS support, MVTLayer CRS support, cross-CRS TMS reprojection, `variableMatrixWidths`.

---

### Task 1: TileMatrixSet types and math (`tile-matrix-set.ts`)

Pure functions: TMS normalization, level selection, tile↔CRS-bounds math. No viewport or tileset dependency.

**Files:**
- Create: `modules/geo-layers/src/tileset-2d/tile-matrix-set.ts`
- Create: `test/modules/geo-layers/tileset-2d/tms-fixtures.ts` (shared fixture module — NOT a spec file)
- Test: `test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2–4):
  - `type TileMatrix = {id: string; cellSize?: number; scaleDenominator?: number; pointOfOrigin: [number, number]; cornerOfOrigin?: 'topLeft' | 'bottomLeft'; tileWidth: number; tileHeight: number; matrixWidth: number; matrixHeight: number}`
  - `type TileMatrixSet = {id?: string; crs?: string; tileMatrices: TileMatrix[]}`
  - `type NormalizedTileMatrix` — `TileMatrix` with `cellSize`/`cornerOfOrigin` required plus `tileSpanX: number; tileSpanY: number`
  - `type NormalizedTileMatrixSet = {id?: string; crs?: string; tileMatrices: NormalizedTileMatrix[]}`
  - `normalizeTileMatrixSet(tms: TileMatrixSet, options?: {metersPerUnit?: number}): NormalizedTileMatrixSet` — throws on empty matrices, missing cellSize+scaleDenominator, or non-decreasing cellSize order
  - `selectTileMatrix(tms: NormalizedTileMatrixSet, crsUnitsPerPixel: number): number` — array index minimizing `|log2(cellSize/target)|`, ties to the finer level
  - `getTileBoundsCRS(tm: NormalizedTileMatrix, x: number, y: number): [number, number, number, number]`
  - `getTileIndicesInBounds(tm: NormalizedTileMatrix, bounds: [number, number, number, number]): {x: number; y: number}[]` — clamped to matrix dims; `[]` when disjoint
  - `getTileIndexAtPoint(tm: NormalizedTileMatrix, point: [number, number]): {x: number; y: number} | null`
  - Fixtures: `makeWorldCRS84Quad512(numLevels): TileMatrixSet`, `makeUTM18NTms(numLevels): TileMatrixSet`, `UTM_EXTENT`

- [ ] **Step 1: Write the fixture module**

Create `test/modules/geo-layers/tileset-2d/tms-fixtures.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileMatrixSet} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';

/** Synthetic WorldCRS84Quad-style quadtree with 512px tiles: level z covers the world in
 * 2^(z+1) x 2^z tiles. cellSize at level 0 is 180 / 512 = 0.3515625 deg/px.
 * (Not a real service's grid — the real GIBS '500m' TMS has non-power-of-two matrices.) */
export function makeWorldCRS84Quad512(numLevels: number): TileMatrixSet {
  return {
    id: 'WorldCRS84Quad-512',
    crs: 'EPSG:4326',
    tileMatrices: Array.from({length: numLevels}, (_, z) => ({
      id: String(z),
      cellSize: 0.3515625 / 2 ** z,
      pointOfOrigin: [-180, 90] as [number, number],
      tileWidth: 512,
      tileHeight: 512,
      matrixWidth: 2 ** (z + 1),
      matrixHeight: 2 ** z
    }))
  };
}

export const UTM_EXTENT: [number, number, number, number] = [166021.44, 0, 833978.56, 9329005.18];

/** Non-quadtree UTM 18N demo TMS derived from the zone extent: level z has 2^z columns and
 * ceil(zoneHeight / tileSpan) rows (14 rows at level 0 — deliberately not a square quadtree). */
export function makeUTM18NTms(numLevels: number): TileMatrixSet {
  const width = UTM_EXTENT[2] - UTM_EXTENT[0];
  return {
    id: 'UTM18N-demo',
    crs: 'EPSG:32618',
    tileMatrices: Array.from({length: numLevels}, (_, z) => {
      const cellSize = width / 512 / 2 ** z;
      return {
        id: String(z),
        cellSize,
        pointOfOrigin: [UTM_EXTENT[0], UTM_EXTENT[3]] as [number, number],
        tileWidth: 512,
        tileHeight: 512,
        matrixWidth: 2 ** z,
        matrixHeight: Math.ceil((UTM_EXTENT[3] - UTM_EXTENT[1]) / (cellSize * 512))
      };
    })
  };
}
```

(The `@deck.gl/geo-layers/tileset-2d/tile-matrix-set` deep import resolves through the repo's source aliases, same pattern as `@deck.gl/core/viewports/crs-utils` in `test/modules/core/viewports/crs-fixtures.ts`.)

- [ ] **Step 2: Write the failing test**

Create `test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {
  normalizeTileMatrixSet,
  selectTileMatrix,
  getTileBoundsCRS,
  getTileIndicesInBounds,
  getTileIndexAtPoint
} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {makeWorldCRS84Quad512, makeUTM18NTms, UTM_EXTENT} from './tms-fixtures';

test('normalizeTileMatrixSet#cellSize passthrough and spans', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(3));
  expect(tms.tileMatrices).toHaveLength(3);
  expect(tms.tileMatrices[0].cellSize).toBe(0.3515625);
  expect(tms.tileMatrices[0].cornerOfOrigin).toBe('topLeft');
  expect(tms.tileMatrices[0].tileSpanX).toBe(180); // 0.3515625 * 512
  expect(tms.tileMatrices[1].tileSpanX).toBe(90);
});

test('normalizeTileMatrixSet#scaleDenominator fallback', () => {
  // Official WorldCRS84Quad level 0 (256px): sd 279541132.0143589 -> 0.703125 deg/px
  const tms = normalizeTileMatrixSet(
    {
      tileMatrices: [
        {
          id: '0',
          scaleDenominator: 279541132.0143589,
          pointOfOrigin: [-180, 90],
          tileWidth: 256,
          tileHeight: 256,
          matrixWidth: 2,
          matrixHeight: 1
        }
      ]
    },
    {metersPerUnit: 111319.49079327358}
  );
  expect(tms.tileMatrices[0].cellSize).toBeCloseTo(0.703125, 9);
});

test('normalizeTileMatrixSet#validation', () => {
  expect(() => normalizeTileMatrixSet({tileMatrices: []})).toThrow();
  // missing cellSize and scaleDenominator
  expect(() =>
    normalizeTileMatrixSet({
      tileMatrices: [
        {id: '0', pointOfOrigin: [0, 0], tileWidth: 256, tileHeight: 256, matrixWidth: 1, matrixHeight: 1}
      ]
    })
  ).toThrow();
  // wrong order (fine before coarse)
  const wrongOrder = makeWorldCRS84Quad512(2);
  wrongOrder.tileMatrices.reverse();
  expect(() => normalizeTileMatrixSet(wrongOrder)).toThrow();
});

test('selectTileMatrix#matching and clamping', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(4));
  const c0 = tms.tileMatrices[0].cellSize;
  // exact matches
  expect(selectTileMatrix(tms, c0)).toBe(0);
  expect(selectTileMatrix(tms, c0 / 4)).toBe(2);
  // slightly finer than halfway (in log space) rounds to the finer level
  expect(selectTileMatrix(tms, c0 / 2 ** 1.6)).toBe(2);
  // slightly coarser than halfway rounds to the coarser level
  expect(selectTileMatrix(tms, c0 / 2 ** 1.4)).toBe(1);
  // out of range clamps
  expect(selectTileMatrix(tms, c0 * 100)).toBe(0);
  expect(selectTileMatrix(tms, c0 / 1e6)).toBe(3);
});

test('getTileBoundsCRS#topLeft origin', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(2));
  expect(getTileBoundsCRS(tms.tileMatrices[0], 0, 0)).toEqual([-180, -90, 0, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[0], 1, 0)).toEqual([0, -90, 180, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[1], 0, 0)).toEqual([-180, 0, -90, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[1], 3, 1)).toEqual([90, -90, 180, 0]);
});

test('getTileBoundsCRS#bottomLeft origin', () => {
  const tms = normalizeTileMatrixSet({
    tileMatrices: [
      {
        id: '0',
        cellSize: 0.3515625,
        pointOfOrigin: [-180, -90],
        cornerOfOrigin: 'bottomLeft',
        tileWidth: 512,
        tileHeight: 512,
        matrixWidth: 2,
        matrixHeight: 1
      }
    ]
  });
  expect(getTileBoundsCRS(tms.tileMatrices[0], 0, 0)).toEqual([-180, -90, 0, 90]);
});

test('getTileIndicesInBounds#intersection and clamping', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(2));
  const tm1 = tms.tileMatrices[1]; // 4x2 tiles of 90 deg
  const indices = getTileIndicesInBounds(tm1, [-10, -10, 10, 10]);
  expect(indices).toHaveLength(4);
  expect(indices).toEqual(
    expect.arrayContaining([
      {x: 1, y: 0},
      {x: 2, y: 0},
      {x: 1, y: 1},
      {x: 2, y: 1}
    ])
  );
  // bounds larger than the matrix clamp to the full grid
  expect(getTileIndicesInBounds(tm1, [-1e4, -1e4, 1e4, 1e4])).toHaveLength(8);
  // disjoint bounds produce nothing
  expect(getTileIndicesInBounds(tm1, [200, -10, 300, 10])).toEqual([]);
});

test('getTileIndicesInBounds#non-square UTM matrix', () => {
  const tms = normalizeTileMatrixSet(makeUTM18NTms(1));
  const tm0 = tms.tileMatrices[0]; // 1 column x 14 rows
  expect(tm0.matrixHeight).toBe(14);
  // Whole zone
  expect(getTileIndicesInBounds(tm0, UTM_EXTENT)).toHaveLength(14);
});

test('getTileIndexAtPoint', () => {
  const tms = normalizeTileMatrixSet(makeUTM18NTms(1));
  const tm0 = tms.tileMatrices[0];
  // northing 4430000 (lat ~40): y = floor((9329005.18 - 4430000) / 667957.12) = 7
  expect(getTileIndexAtPoint(tm0, [500000, 4430000])).toEqual({x: 0, y: 7});
  // outside the matrix
  expect(getTileIndexAtPoint(tm0, [0, 4430000])).toBeNull();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts`
Expected: FAIL — cannot resolve `@deck.gl/geo-layers/tileset-2d/tile-matrix-set` (module does not exist).

- [ ] **Step 4: Write the implementation**

Create `modules/geo-layers/src/tileset-2d/tile-matrix-set.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** One level of an OGC two-dimensional TileMatrixSet (subset of TMS 2.0) */
export type TileMatrix = {
  /** Tile matrix identifier, e.g. '0'. Substituted for `{tm}` in URL templates. */
  id: string;
  /** Resolution in CRS units per pixel. If omitted, derived from `scaleDenominator`. */
  cellSize?: number;
  /** OGC scale denominator (0.28 mm/pixel convention). Used when `cellSize` is omitted. */
  scaleDenominator?: number;
  /** Grid origin in CRS coordinates */
  pointOfOrigin: [number, number];
  /** Which corner of the grid `pointOfOrigin` refers to. Default 'topLeft' */
  cornerOfOrigin?: 'topLeft' | 'bottomLeft';
  /** Tile width in pixels */
  tileWidth: number;
  /** Tile height in pixels */
  tileHeight: number;
  /** Number of tile columns */
  matrixWidth: number;
  /** Number of tile rows */
  matrixHeight: number;
};

/** An OGC two-dimensional TileMatrixSet (subset of TMS 2.0) */
export type TileMatrixSet = {
  id?: string;
  /** CRS identifier, e.g. 'EPSG:32618' or an OGC CRS URI. Checked against the view CRS. */
  crs?: string;
  /** Tile matrices ordered coarse to fine (strictly decreasing cellSize) */
  tileMatrices: TileMatrix[];
};

export type NormalizedTileMatrix = {
  id: string;
  cellSize: number;
  pointOfOrigin: [number, number];
  cornerOfOrigin: 'topLeft' | 'bottomLeft';
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
  /** cellSize * tileWidth, in CRS units */
  tileSpanX: number;
  /** cellSize * tileHeight, in CRS units */
  tileSpanY: number;
};

export type NormalizedTileMatrixSet = {
  id?: string;
  crs?: string;
  tileMatrices: NormalizedTileMatrix[];
};

/** OGC standardized rendering pixel size: 0.28 mm */
const OGC_PIXEL_SIZE_M = 0.28e-3;

/** Resolve cellSize/cornerOfOrigin, precompute tile spans, and validate level ordering.
 * `metersPerUnit` converts scaleDenominator to CRS units: 1 for meters CRSs,
 * 111319.49079327358 (OGC convention) for degrees. */
export function normalizeTileMatrixSet(
  tms: TileMatrixSet,
  options: {metersPerUnit?: number} = {}
): NormalizedTileMatrixSet {
  const {metersPerUnit = 1} = options;
  const {tileMatrices} = tms;
  if (!tileMatrices || tileMatrices.length === 0) {
    throw new Error('TileMatrixSet: tileMatrices must not be empty');
  }
  const normalized = tileMatrices.map(tm => {
    const cellSize =
      tm.cellSize ??
      (tm.scaleDenominator !== undefined
        ? (tm.scaleDenominator * OGC_PIXEL_SIZE_M) / metersPerUnit
        : undefined);
    if (cellSize === undefined || !Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error(
        `TileMatrixSet: tileMatrix ${tm.id} needs a positive cellSize or scaleDenominator`
      );
    }
    return {
      id: tm.id,
      cellSize,
      pointOfOrigin: tm.pointOfOrigin,
      cornerOfOrigin: tm.cornerOfOrigin ?? ('topLeft' as const),
      tileWidth: tm.tileWidth,
      tileHeight: tm.tileHeight,
      matrixWidth: tm.matrixWidth,
      matrixHeight: tm.matrixHeight,
      tileSpanX: cellSize * tm.tileWidth,
      tileSpanY: cellSize * tm.tileHeight
    };
  });
  for (let i = 1; i < normalized.length; i++) {
    if (!(normalized[i].cellSize < normalized[i - 1].cellSize)) {
      throw new Error('TileMatrixSet: tileMatrices must be ordered coarse to fine');
    }
  }
  return {id: tms.id, crs: tms.crs, tileMatrices: normalized};
}

/** Index of the tile matrix whose cellSize best matches the target resolution.
 * Distance is measured in log2 space; ties go to the finer level (mirrors the OSM
 * `Math.round(zoom)` behavior). */
export function selectTileMatrix(tms: NormalizedTileMatrixSet, crsUnitsPerPixel: number): number {
  const {tileMatrices} = tms;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < tileMatrices.length; i++) {
    const dist = Math.abs(Math.log2(tileMatrices[i].cellSize / crsUnitsPerPixel));
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/** The [minX, minY, maxX, maxY] rect of a tile in CRS units */
export function getTileBoundsCRS(
  tm: NormalizedTileMatrix,
  x: number,
  y: number
): [number, number, number, number] {
  const [originX, originY] = tm.pointOfOrigin;
  const minX = originX + x * tm.tileSpanX;
  const maxX = minX + tm.tileSpanX;
  if (tm.cornerOfOrigin === 'bottomLeft') {
    const minY = originY + y * tm.tileSpanY;
    return [minX, minY, maxX, minY + tm.tileSpanY];
  }
  const maxY = originY - y * tm.tileSpanY;
  return [minX, maxY - tm.tileSpanY, maxX, maxY];
}

/** All tile {x, y} in the matrix intersecting the CRS-unit bounds (clamped to the grid) */
export function getTileIndicesInBounds(
  tm: NormalizedTileMatrix,
  bounds: [number, number, number, number]
): {x: number; y: number}[] {
  const [minX, minY, maxX, maxY] = bounds;
  const [originX, originY] = tm.pointOfOrigin;
  const x0 = Math.max(Math.floor((minX - originX) / tm.tileSpanX), 0);
  const x1 = Math.min(Math.ceil((maxX - originX) / tm.tileSpanX), tm.matrixWidth);
  let y0: number;
  let y1: number;
  if (tm.cornerOfOrigin === 'bottomLeft') {
    y0 = Math.max(Math.floor((minY - originY) / tm.tileSpanY), 0);
    y1 = Math.min(Math.ceil((maxY - originY) / tm.tileSpanY), tm.matrixHeight);
  } else {
    y0 = Math.max(Math.floor((originY - maxY) / tm.tileSpanY), 0);
    y1 = Math.min(Math.ceil((originY - minY) / tm.tileSpanY), tm.matrixHeight);
  }
  const indices: {x: number; y: number}[] = [];
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      indices.push({x, y});
    }
  }
  return indices;
}

/** The tile containing a CRS point, or null if the point is outside the matrix */
export function getTileIndexAtPoint(
  tm: NormalizedTileMatrix,
  point: [number, number]
): {x: number; y: number} | null {
  const [originX, originY] = tm.pointOfOrigin;
  const x = Math.floor((point[0] - originX) / tm.tileSpanX);
  const y =
    tm.cornerOfOrigin === 'bottomLeft'
      ? Math.floor((point[1] - originY) / tm.tileSpanY)
      : Math.floor((originY - point[1]) / tm.tileSpanY);
  if (x < 0 || x >= tm.matrixWidth || y < 0 || y >= tm.matrixHeight) {
    return null;
  }
  return {x, y};
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Prettier, typecheck, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/tileset-2d/tile-matrix-set.ts test/modules/geo-layers/tileset-2d/tms-fixtures.ts test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts
npx tsc --noEmit -p modules/geo-layers/tsconfig.json
git add modules/geo-layers/src/tileset-2d/tile-matrix-set.ts test/modules/geo-layers/tileset-2d/tms-fixtures.ts test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts
git commit -m "feat(geo-layers): add OGC TileMatrixSet types and tile math"
```

---

### Task 2: `CRSTileset2D` (`crs-tileset-2d.ts`)

A `Tileset2D` subclass that indexes tiles from a TileMatrixSet against a `_CRSViewport`.

**Files:**
- Create: `modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts`
- Modify: `modules/geo-layers/src/tileset-2d/index.ts` (add exports)
- Test: `test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts`

**Interfaces:**
- Consumes (Task 1): `normalizeTileMatrixSet`, `selectTileMatrix`, `getTileBoundsCRS`, `getTileIndicesInBounds`, `getTileIndexAtPoint`, types `TileMatrixSet`, `NormalizedTileMatrixSet`.
- Consumes (Phase 1 core): `_CRSViewport` duck-typed via its `crs: NormalizedCRS` property (`code`, `units`, `extent`, `commonUnitsPerCRSUnit`, `transform.forward/inverse`); core `log`.
- Consumes (base class): `Tileset2D` public subclassing interface; `this.opts` (`zoomOffset`, `visibleMinZoom`, `visibleMaxZoom`, `extent`).
- Produces (Tasks 3–4):
  - `class CRSTileset2D extends Tileset2D` with `constructor(opts: CRSTileset2DProps)`; overrides `getTileIndices`, `getTileMetadata`, `getParentIndex` (inherits `getTileId`, `getTileZoom`).
  - `type CRSTileset2DProps = Tileset2DProps & {tileMatrixSet: TileMatrixSet}`
  - `type CRSTileIndex = TileIndex & {tm: string}` — `z` is the array position in `tileMatrices`, `tm` the TMS level id (so both `{z}` and `{tm}` work in URL templates).
  - Tile metadata fields: `bbox: GeoBoundingBox`, `boundsCRS: [minX, minY, maxX, maxY]` (CRS units), `boundsCommon: [minX, minY, maxX, maxY]` (common-space units, for exact CARTESIAN raster positioning).

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {
  _CRSTileset2D as CRSTileset2D,
  _getURLFromTemplate as getURLFromTemplate
} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {makeWorldCRS84Quad512, makeUTM18NTms} from './tms-fixtures';

const getTileData = () => Promise.resolve(null);

test('CRSTileset2D#4326 whole-world level 0', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(6)});
  // zoom 1: the 512-unit world spans 1024 px; crsUnitsPerPixel = 2^-1 / (512/360) = 0.3515625
  // = level 0 cellSize exactly
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: 1
  });
  tileset.update(viewport);
  const indices = tileset.selectedTiles!.map(t => t.index);
  expect(indices).toHaveLength(2);
  expect(indices).toEqual(
    expect.arrayContaining([expect.objectContaining({x: 0, y: 0, z: 0, tm: '0'})])
  );
  expect(indices).toEqual(
    expect.arrayContaining([expect.objectContaining({x: 1, y: 0, z: 0, tm: '0'})])
  );
  // metadata: bbox is exact lnglat for 4326
  const tile = tileset.selectedTiles!.find(t => (t.index as any).x === 0)!;
  expect(tile.bbox).toEqual({west: -180, south: -90, east: 0, north: 90});
  expect((tile as any).boundsCRS).toEqual([-180, -90, 0, 90]);
  // common space: extent [-180,-90,180,90] scaled by 512/360
  const k = 512 / 360;
  expect((tile as any).boundsCommon).toEqual([0, 0, 180 * k, 180 * k]);
});

test('CRSTileset2D#4326 deeper zoom selects deeper level', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(6)});
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 512,
    height: 512,
    longitude: -72,
    latitude: 40,
    zoom: 4
  });
  tileset.update(viewport);
  const zs = new Set(tileset.selectedTiles!.map(t => t.zoom));
  expect(zs).toEqual(new Set([3])); // level = deck zoom - 1 for 512px WorldCRS84Quad tiles
});

test('CRSTileset2D#UTM indices, metadata and parent chain', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeUTM18NTms(6)});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  // level 3 is an exact cellSize match for this TMS at zoom 3
  expect(new Set(tiles.map(t => t.zoom))).toEqual(new Set([3]));
  const tm3 = 8; // matrixWidth at level 3 = 2^3
  for (const tile of tiles) {
    const {x, y, z} = tile.index as {x: number; y: number; z: number};
    expect(z).toBe(3);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(tm3);
    expect(y).toBeGreaterThanOrEqual(0);
    // bbox contains the tile's own CRS rect center
    const [minX, minY, maxX, maxY] = (tile as any).boundsCRS;
    const center = UTM18N.transform.inverse([(minX + maxX) / 2, (minY + maxY) / 2]);
    expect(center[0]).toBeGreaterThanOrEqual((tile.bbox as any).west - 1e-6);
    expect(center[0]).toBeLessThanOrEqual((tile.bbox as any).east + 1e-6);
  }
  // parent chain: the parent tile's CRS rect contains the child rect center
  const child = tiles[0];
  const parentIndex = tileset.getParentIndex(child.index);
  expect(parentIndex.z).toBe(2);
  expect((parentIndex as any).tm).toBe('2');
});

test('CRSTileset2D#throws without a CRS viewport', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(2)});
  const fakeViewport = {zoom: 1, width: 100, height: 100, unproject: () => [0, 0]};
  expect(() =>
    tileset.getTileIndices({viewport: fakeViewport as any, minZoom: undefined, maxZoom: undefined, zRange: null})
  ).toThrow(/CRS view/);
});

test('CRSTileset2D#minZoom/maxZoom clamp the level', () => {
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: makeWorldCRS84Quad512(6),
    maxZoom: 1,
    minZoom: 0
  });
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 512,
    height: 512,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  tileset.update(viewport);
  expect(new Set(tileset.selectedTiles!.map(t => t.zoom))).toEqual(new Set([1]));
});

test('CRSTileset2D#url template with {tm}', () => {
  const url = getURLFromTemplate('https://example.com/{tm}/{x}/{y}.png', {
    index: {x: 3, y: 1, z: 2, tm: '2'} as any,
    id: '3-1-2'
  });
  expect(url).toBe('https://example.com/2/3/1.png');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts`
Expected: FAIL — `_CRSTileset2D` is not exported from `@deck.gl/geo-layers`.

- [ ] **Step 3: Write the implementation**

Create `modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log, Viewport} from '@deck.gl/core';
import {Tileset2D, Tileset2DProps} from './tileset-2d';
import {
  normalizeTileMatrixSet,
  selectTileMatrix,
  getTileBoundsCRS,
  getTileIndicesInBounds,
  getTileIndexAtPoint
} from './tile-matrix-set';
import type {TileMatrixSet, NormalizedTileMatrixSet} from './tile-matrix-set';
import type {Bounds, TileIndex} from './types';

/** A viewport with Phase 1 CRS information (duck-typed to avoid a hard dependency on _CRSViewport) */
type CRSViewportLike = Viewport & {
  crs: {
    code: string;
    units: 'meters' | 'degrees';
    extent: [number, number, number, number];
    commonUnitsPerCRSUnit: number;
    transform: {
      forward: (lnglat: [number, number]) => [number, number];
      inverse: (xy: [number, number]) => [number, number];
    };
  };
};

export type CRSTileset2DProps = Tileset2DProps & {
  /** OGC TileMatrixSet describing the tile grid, in the view's CRS */
  tileMatrixSet: TileMatrixSet;
};

/** `z` is the array position in `tileMatrices`; `tm` is the TMS level id (for URL templates) */
export type CRSTileIndex = TileIndex & {tm: string};

/** Matches the OGC scaleDenominator convention for degree-based CRSs */
const METERS_PER_DEGREE = 111319.49079327358;

/** Tileset that indexes tiles from an OGC TileMatrixSet against a CRS view
 * (a `MapView` with a non-Mercator `crs`). */
export class CRSTileset2D extends Tileset2D {
  private _tms: NormalizedTileMatrixSet | null = null;
  private _rawTms: TileMatrixSet | null = null;
  private _crsViewport: CRSViewportLike | null = null;
  private _crsWarned = false;

  constructor(opts: CRSTileset2DProps) {
    super(opts);
    if (!opts.tileMatrixSet) {
      throw new Error('CRSTileset2D: tileMatrixSet is required');
    }
  }

  getTileIndices({
    viewport,
    maxZoom,
    minZoom
  }: Parameters<Tileset2D['getTileIndices']>[0]): CRSTileIndex[] {
    const crsViewport = viewport as CRSViewportLike;
    if (!crsViewport.crs) {
      throw new Error(
        'CRSTileset2D requires a CRS view — set the `crs` prop on MapView, or remove `tileMatrixSet`'
      );
    }
    this._crsViewport = crsViewport;
    const {zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }

    const tms = this._getTms(crsViewport);
    const crsUnitsPerPixel =
      Math.pow(2, -(viewport.zoom + zoomOffset)) / crsViewport.crs.commonUnitsPerCRSUnit;
    let z = selectTileMatrix(tms, crsUnitsPerPixel);
    if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
      z = minZoom;
    }
    if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
      z = maxZoom;
    }
    z = Math.max(0, Math.min(z, tms.tileMatrices.length - 1));

    const bounds = this._getViewBoundsCRS(crsViewport, (extent as Bounds | null) || null);
    if (!bounds) {
      return [];
    }
    const tm = tms.tileMatrices[z];
    return getTileIndicesInBounds(tm, bounds).map(({x, y}) => ({x, y, z, tm: tm.id}));
  }

  getTileMetadata(index: TileIndex): Record<string, any> {
    const viewport = this._crsViewport;
    const tms = this._tms;
    if (!viewport || !tms) {
      return {};
    }
    const tm = tms.tileMatrices[index.z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tm, index.x, index.y);
    const {transform, extent, commonUnitsPerCRSUnit} = viewport.crs;
    const corners = [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY]
    ].map(xy => transform.inverse(xy as [number, number]));
    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    return {
      bbox: {
        west: Math.min(...lngs),
        south: Math.min(...lats),
        east: Math.max(...lngs),
        north: Math.max(...lats)
      },
      boundsCRS: [minX, minY, maxX, maxY],
      boundsCommon: [
        (minX - extent[0]) * commonUnitsPerCRSUnit,
        (minY - extent[1]) * commonUnitsPerCRSUnit,
        (maxX - extent[0]) * commonUnitsPerCRSUnit,
        (maxY - extent[1]) * commonUnitsPerCRSUnit
      ]
    };
  }

  getParentIndex(index: TileIndex): CRSTileIndex {
    const tms = this._tms!;
    const z = index.z - 1;
    const parentTm = tms.tileMatrices[z];
    const tm = tms.tileMatrices[index.z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tm, index.x, index.y);
    const parent = getTileIndexAtPoint(parentTm, [(minX + maxX) / 2, (minY + maxY) / 2]);
    if (!parent) {
      return {x: 0, y: 0, z, tm: parentTm.id};
    }
    return {x: parent.x, y: parent.y, z, tm: parentTm.id};
  }

  private _getTms(viewport: CRSViewportLike): NormalizedTileMatrixSet {
    const raw = (this.opts as CRSTileset2DProps).tileMatrixSet;
    if (!this._tms || raw !== this._rawTms) {
      const metersPerUnit = viewport.crs.units === 'degrees' ? METERS_PER_DEGREE : 1;
      this._tms = normalizeTileMatrixSet(raw, {metersPerUnit});
      this._rawTms = raw;
      if (raw.crs && !this._crsWarned) {
        // Accept both 'EPSG:32618' and OGC URIs like 'http://www.opengis.net/def/crs/EPSG/0/32618'
        const code = raw.crs.includes('/') ? `EPSG:${raw.crs.split('/').pop()}` : raw.crs;
        if (code !== viewport.crs.code) {
          log.warn(
            `tileMatrixSet CRS (${raw.crs}) does not match the view CRS (${viewport.crs.code})`
          )();
          this._crsWarned = true;
        }
      }
    }
    return this._tms;
  }

  /** View bounds in CRS units: forward-project the unprojected screen corners.
   * Returns null when no corner projects to a finite position. */
  private _getViewBoundsCRS(viewport: CRSViewportLike, extentLngLat: Bounds | null): Bounds | null {
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
    for (const lnglat of corners) {
      const xy = viewport.crs.transform.forward([lnglat[0], lnglat[1]]);
      if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
        minX = Math.min(minX, xy[0]);
        minY = Math.min(minY, xy[1]);
        maxX = Math.max(maxX, xy[0]);
        maxY = Math.max(maxY, xy[1]);
      }
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    if (extentLngLat) {
      // extent option is [west, south, east, north] in lnglat, matching the base class
      const [west, south, east, north] = extentLngLat;
      const projected = [
        [west, south],
        [east, south],
        [west, north],
        [east, north]
      ].map(c => viewport.crs.transform.forward(c as [number, number]));
      minX = Math.max(minX, Math.min(...projected.map(p => p[0])));
      minY = Math.max(minY, Math.min(...projected.map(p => p[1])));
      maxX = Math.min(maxX, Math.max(...projected.map(p => p[0])));
      maxY = Math.min(maxY, Math.max(...projected.map(p => p[1])));
      if (!(minX < maxX) || !(minY < maxY)) {
        return null;
      }
    }
    return [minX, minY, maxX, maxY];
  }
}
```

Modify `modules/geo-layers/src/tileset-2d/index.ts` — append after the existing `export {Tile2DHeader} ...` line:

```ts
export {CRSTileset2D} from './crs-tileset-2d';
export type {CRSTileset2DProps, CRSTileIndex} from './crs-tileset-2d';
export {normalizeTileMatrixSet} from './tile-matrix-set';
export type {
  TileMatrixSet,
  TileMatrix,
  NormalizedTileMatrixSet,
  NormalizedTileMatrix
} from './tile-matrix-set';
```

Modify `modules/geo-layers/src/index.ts` — in the `// Tileset2D` export block (after the `export {Tileset2D as _Tileset2D}` line, `modules/geo-layers/src/index.ts:46`):

```ts
export {CRSTileset2D as _CRSTileset2D} from './tileset-2d/index';
export type {TileMatrixSet, TileMatrix} from './tileset-2d/index';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts`
Expected: PASS (6 tests). Also re-run Task 1's spec (unchanged behavior): `npx vitest run --project node test/modules/geo-layers/tileset-2d/tile-matrix-set.node.spec.ts`.

- [ ] **Step 5: Regression: existing tileset tests**

Run: `npx vitest run --project headless test/modules/geo-layers/tileset-2d`
Expected: PASS (no changes to existing behavior).

- [ ] **Step 6: Prettier, typecheck, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts modules/geo-layers/src/tileset-2d/index.ts modules/geo-layers/src/index.ts test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts
npx tsc --noEmit -p modules/geo-layers/tsconfig.json
git add modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts modules/geo-layers/src/tileset-2d/index.ts modules/geo-layers/src/index.ts test/modules/geo-layers/tileset-2d/crs-tileset-2d.node.spec.ts
git commit -m "feat(geo-layers): add CRSTileset2D for TileMatrixSet indexing in CRS views"
```

---

### Task 3: `TileLayer.tileMatrixSet` prop, docs

Wire the new tileset into `TileLayer` and document it.

**Files:**
- Modify: `modules/geo-layers/src/tile-layer/tile-layer.ts`
- Modify: `docs/api-reference/geo-layers/tile-layer.md`
- Modify: `docs/api-reference/core/crs-viewport.md` (the "Known not to work yet" TileLayer bullet)
- Modify: `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md` (Phase 2 bullet: note implemented)
- Test: `test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts` (headless)

**Interfaces:**
- Consumes (Task 2): `CRSTileset2D`, `CRSTileset2DProps`, type `TileMatrixSet` from `../tileset-2d/index`.
- Produces: `TileLayerProps.tileMatrixSet?: TileMatrixSet | null` (default `null`). When set and `TilesetClass` is the default, the layer instantiates `CRSTileset2D`. Changing the `tileMatrixSet` object identity recreates the tileset.

- [ ] **Step 1: Write the failing test**

Create `test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {
  TileLayer,
  _CRSTileset2D as CRSTileset2D,
  _Tileset2D as Tileset2D
} from '@deck.gl/geo-layers';
import {makeWorldCRS84Quad512} from '../tileset-2d/tms-fixtures';

test('TileLayer#default TilesetClass without tileMatrixSet (Mercator regression)', async () => {
  // Plain Mercator viewport (the harness default): no tileMatrixSet -> base Tileset2D
  const testCases = [
    {
      title: 'default tileset',
      props: {
        getTileData: () => Promise.resolve([])
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(Tileset2D);
        expect(layer.state.tileset).not.toBeInstanceOf(CRSTileset2D);
      }
    }
  ];
  await testLayerAsync({Layer: TileLayer, testCases, onError: err => expect(err).toBeFalsy()});
});

test('TileLayer#tileMatrixSet selects CRSTileset2D and recreates on change', async () => {
  const view = new MapView({crs: 'EPSG:4326'});
  const viewport = view.makeViewport({
    width: 1024,
    height: 512,
    viewState: {longitude: 0, latitude: 0, zoom: 1}
  })!;
  const tileMatrixSet = makeWorldCRS84Quad512(6);
  const otherTileMatrixSet = makeWorldCRS84Quad512(4); // different identity
  let firstTileset = null;

  const testCases = [
    {
      title: 'with tileMatrixSet: CRS tileset selects level-0 tiles',
      props: {
        tileMatrixSet,
        getTileData: () => Promise.resolve([])
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(CRSTileset2D);
        firstTileset = layer.state.tileset;
        const indices = layer.state.tileset.selectedTiles.map(t => t.index);
        expect(indices).toHaveLength(2);
        expect(indices).toEqual(
          expect.arrayContaining([expect.objectContaining({x: 0, y: 0, z: 0, tm: '0'})])
        );
      }
    },
    {
      title: 'changing tileMatrixSet identity recreates the tileset',
      updateProps: {
        tileMatrixSet: otherTileMatrixSet
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(CRSTileset2D);
        expect(layer.state.tileset).not.toBe(firstTileset);
      }
    }
  ];

  await testLayerAsync({
    Layer: TileLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project headless test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts`
Expected: the Mercator regression test PASSES; the tileMatrixSet test FAILS — `layer.state.tileset` is a plain `Tileset2D` (prop not implemented), and the OSM indexing path runs against the CRS viewport.

- [ ] **Step 3: Implement the prop**

In `modules/geo-layers/src/tile-layer/tile-layer.ts`:

1. Extend the tileset import (`modules/geo-layers/src/tile-layer/tile-layer.ts:14-28` import block):

```ts
import {CRSTileset2D} from '../tileset-2d/index';
import type {TileMatrixSet} from '../tileset-2d/index';
```

2. Add to `defaultProps` (after `zRange: null,`):

```ts
  tileMatrixSet: {type: 'object', optional: true, value: null, compare: 2},
```

3. Add to `_TileLayerProps` (after the `TilesetClass` member):

```ts
  /**
   * OGC TileMatrixSet describing the tile grid when rendering into a `MapView` with a
   * non-Mercator `crs`. When set (and `TilesetClass` is not customized), tiles are indexed
   * with `_CRSTileset2D`. Define the object once outside the render loop — a new object
   * identity recreates the tileset.
   * @default null
   */
  tileMatrixSet?: TileMatrixSet | null;
```

4. In `updateState` (`modules/geo-layers/src/tile-layer/tile-layer.ts:228`), change the signature to destructure `props` and `oldProps`, recreate the tileset when the TMS identity changes, and use the class selector:

```ts
  updateState({props, oldProps, changeFlags}: UpdateParameters<this>) {
    let {tileset} = this.state;
    const propsChanged = changeFlags.propsOrDataChanged || changeFlags.updateTriggersChanged;
    const dataChanged =
      changeFlags.dataChanged ||
      (changeFlags.updateTriggersChanged &&
        (changeFlags.updateTriggersChanged.all || changeFlags.updateTriggersChanged.getTileData));

    if (tileset && props.tileMatrixSet !== oldProps.tileMatrixSet) {
      tileset.finalize();
      tileset = null;
    }
    if (!tileset) {
      tileset = new (this._getTilesetClass())(this._getTilesetOptions());
      this.setState({tileset});
    } else if (propsChanged) {
      tileset.setOptions(this._getTilesetOptions());

      if (dataChanged) {
        // reload all tiles
        // use cached layers until new content is loaded
        tileset.reloadAll();
      } else {
        // some render options changed, regenerate sub layers now
        tileset.tiles.forEach(tile => {
          tile.layers = null;
        });
      }
    }

    this._updateTileset();
  }

  _getTilesetClass(): typeof Tileset2D {
    const {TilesetClass, tileMatrixSet} = this.props;
    if (tileMatrixSet && TilesetClass === Tileset2D) {
      return CRSTileset2D;
    }
    return TilesetClass;
  }
```

5. In `_getTilesetOptions` (`modules/geo-layers/src/tile-layer/tile-layer.ts:258`), add `tileMatrixSet` to the destructured props and to the returned object, and widen the return type. The full replacement body:

```ts
  _getTilesetOptions(): Tileset2DProps & {tileMatrixSet?: TileMatrixSet | null} {
    const {
      tileSize,
      maxCacheSize,
      maxCacheByteSize,
      refinementStrategy,
      extent,
      maxZoom,
      minZoom,
      maxRequests,
      debounceTime,
      zoomOffset,
      visibleMinZoom,
      visibleMaxZoom,
      tileMatrixSet
    } = this.props;

    return {
      maxCacheSize,
      maxCacheByteSize,
      maxZoom,
      minZoom,
      tileSize,
      refinementStrategy,
      extent,
      maxRequests,
      debounceTime,
      zoomOffset,
      visibleMinZoom,
      visibleMaxZoom,
      tileMatrixSet,

      getTileData: this.getTileData.bind(this),
      onTileLoad: this._onTileLoad.bind(this),
      onTileError: this._onTileError.bind(this),
      onTileUnload: this._onTileUnload.bind(this)
    };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project headless test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts`
Expected: PASS.

- [ ] **Step 5: Regression: existing tile-layer + tileset tests**

Run: `npx vitest run --project headless test/modules/geo-layers/tile-layer test/modules/geo-layers/tileset-2d && npx vitest run --project node test/modules/geo-layers`
Expected: PASS.

- [ ] **Step 6: Docs**

In `docs/api-reference/geo-layers/tile-layer.md`, add a prop section (alphabetical placement with the other props; match surrounding heading style):

```md
##### `tileMatrixSet` (TileMatrixSet, optional) {#tilematrixset}

- Default: `null`

An OGC TileMatrixSet definition describing the tile grid, for use when rendering into a
`MapView` with a non-Mercator [`crs`](../core/map-view.md#crs). When set, tiles are indexed by
the experimental `_CRSTileset2D` instead of the Web Mercator (OSM) tile pyramid: the tile
matrix level is chosen by matching each level's `cellSize` (CRS units per pixel) against the
viewport resolution, and tile indices are computed in CRS coordinates.

```js
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer} from '@deck.gl/layers';
import {MapView} from '@deck.gl/core';

// NASA GIBS EPSG:4326 '500m' TileMatrixSet, verbatim from the WMTS capabilities
// (levels 0-7; non-power-of-two matrices: 2x1, 3x2, 5x3, 10x5, ...)
const GIBS_500M = {
  id: '500m',
  crs: 'EPSG:4326',
  tileMatrices: [
    [223632905.6114871, 2, 1],
    [111816452.8057436, 3, 2],
    [55908226.40287178, 5, 3],
    [27954113.20143589, 10, 5],
    [13977056.60071795, 20, 10],
    [6988528.300358973, 40, 20],
    [3494264.150179486, 80, 40],
    [1747132.075089743, 160, 80]
  ].map(([scaleDenominator, matrixWidth, matrixHeight], z) => ({
    id: String(z),
    scaleDenominator,
    pointOfOrigin: [-180, 90],
    tileWidth: 512,
    tileHeight: 512,
    matrixWidth,
    matrixHeight
  }))
};

const layer = new TileLayer({
  data: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m/{tm}/{y}/{x}.jpeg',
  tileMatrixSet: GIBS_500M,
  maxZoom: 7,
  renderSubLayers: props => {
    const {west, south, east, north} = props.tile.bbox;
    return new BitmapLayer(props, {
      data: null,
      image: props.data,
      bounds: [west, south, east, north]
    });
  }
});

// rendered with: new MapView({crs: 'EPSG:4326'})
```

Each tile matrix is `{id, cellSize (or scaleDenominator), pointOfOrigin, cornerOfOrigin?,
tileWidth, tileHeight, matrixWidth, matrixHeight}` — a subset of OGC TileMatrixSet 2.0. Levels
must be ordered coarse to fine. In URL templates, `{z}` substitutes the level's array position
and `{tm}` the tile matrix `id` string. Tiles additionally expose `boundsCRS` (the exact tile
rect in CRS units) and `boundsCommon` (the same rect in deck's common space, for exact
positioning of raster sublayers with `COORDINATE_SYSTEM.CARTESIAN`). The TMS must be defined in
the same CRS as the view. Define the object once outside the render loop.
```

In `docs/api-reference/core/crs-viewport.md`, update the "Known not to work yet (Phase 2/3 scope)" section: replace the `TileLayer` bullet with:

```md
* `TileLayer` supports CRS views via the [`tileMatrixSet` prop](../geo-layers/tile-layer.md#tilematrixset) (OGC TileMatrixSet indexing). Without it, `TileLayer` still assumes the Web Mercator tile pyramid. `MVTLayer` and `_WMSLayer` are not yet CRS-aware.
```

In `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`, update the Phase 2 bullet to note the implementation:

```md
* **Phase 2 — CRS-aware tiles in `@deck.gl/geo-layers`** (implemented on this branch): `_CRSTileset2D` indexes tiles from OGC TileMatrixSet definitions; `TileLayer` gains a `tileMatrixSet` prop. Enables TiTiler-style basemaps in UTM and `WorldCRS84Quad` tile services — the remaining half of the #6216 ask not covered by Phase 1's rendering support alone. `_WMSLayer`/`MVTLayer` support is future work.
```

- [ ] **Step 7: Prettier, typecheck, commit**

```bash
npx prettier --config .prettierrc --write modules/geo-layers/src/tile-layer/tile-layer.ts test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts docs/api-reference/geo-layers/tile-layer.md docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md
npx tsc --noEmit -p modules/geo-layers/tsconfig.json
git add modules/geo-layers/src/tile-layer/tile-layer.ts test/modules/geo-layers/tile-layer/tile-layer-crs.spec.ts docs/api-reference/geo-layers/tile-layer.md docs/api-reference/core/crs-viewport.md dev-docs/RFCs/proposals/crs-projection-mode-rfc.md
git commit -m "feat(geo-layers): add TileLayer tileMatrixSet prop for CRS views"
```

---

### Task 4: Visual verification (extend `test/apps/crs-viewport`)

Prove the acceptance scenarios on a live GPU: GIBS 4326 basemap in the EPSG:4326 view, debug tile grid in the UTM view, OSM regression in Mercator.

**Files:**
- Modify: `test/apps/crs-viewport/app.jsx`

**Interfaces:**
- Consumes: `TileLayer` + `tileMatrixSet` (Task 3), `BitmapLayer`, `TextLayer`, existing app scaffolding.
- Produces: human verification + screenshots; nothing downstream.

- [ ] **Step 1: Add tile layers to the app**

In `test/apps/crs-viewport/app.jsx`:

1. Extend imports:

```jsx
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer} from '@deck.gl/layers'; // add to the existing @deck.gl/layers import
import {TextLayer} from '@deck.gl/layers'; // idem
```

2. Add TMS definitions after `CRS_OPTIONS` (module scope — stable identities):

```jsx
// NASA GIBS EPSG:4326 '500m' TileMatrixSet, verbatim from the WMTS capabilities
// (see test/apps/crs-viewport/app.jsx for the as-committed version)
const GIBS_4326_TMS = {
  id: '500m',
  crs: 'EPSG:4326',
  tileMatrices: [
    [223632905.6114871, 2, 1],
    [111816452.8057436, 3, 2],
    [55908226.40287178, 5, 3],
    [27954113.20143589, 10, 5],
    [13977056.60071795, 20, 10],
    [6988528.300358973, 40, 20],
    [3494264.150179486, 80, 40],
    [1747132.075089743, 160, 80]
  ].map(([scaleDenominator, matrixWidth, matrixHeight], z) => ({
    id: String(z),
    scaleDenominator,
    pointOfOrigin: [-180, 90],
    tileWidth: 512,
    tileHeight: 512,
    matrixWidth,
    matrixHeight
  }))
};

// Demo UTM 18N TMS derived from the zone extent (non-square: 14 rows at level 0)
const UTM_TMS = {
  crs: 'EPSG:32618',
  tileMatrices: Array.from({length: 10}, (_, z) => {
    const cellSize = (UTM18N.extent[2] - UTM18N.extent[0]) / 512 / 2 ** z;
    return {
      id: String(z),
      cellSize,
      pointOfOrigin: [UTM18N.extent[0], UTM18N.extent[3]],
      tileWidth: 512,
      tileHeight: 512,
      matrixWidth: 2 ** z,
      matrixHeight: Math.ceil((UTM18N.extent[3] - UTM18N.extent[1]) / (cellSize * 512))
    };
  })
};
```

3. Add tile layers per mode. Inside `App()`, add state `const [showTiles, setShowTiles] = useState(true);` and build:

```jsx
  const tileLayers = [];
  if (showTiles) {
    if (crsName === 'EPSG:4326') {
      tileLayers.push(
        new TileLayer({
          id: 'gibs',
          data: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m/{tm}/{y}/{x}.jpeg',
          tileMatrixSet: GIBS_4326_TMS,
          maxZoom: 7,
          renderSubLayers: props => {
            const {west, south, east, north} = props.tile.bbox;
            return new BitmapLayer(props, {
              data: null,
              image: props.data,
              bounds: [west, south, east, north]
            });
          }
        })
      );
    } else if (crsName === 'UTM 18N') {
      // No public UTM tile server: render the tile grid itself to verify indexing
      tileLayers.push(
        new TileLayer({
          id: 'utm-grid',
          tileMatrixSet: UTM_TMS,
          getTileData: ({index}) => index,
          renderSubLayers: props => {
            const {west, south, east, north} = props.tile.bbox;
            const {x, y, z} = props.tile.index;
            return [
              new PathLayer(props, {
                id: `${props.id}-outline`,
                data: [{path: [[west, south], [east, south], [east, north], [west, north], [west, south]]}],
                getPath: d => d.path,
                getColor: [255, 140, 0, 200],
                widthMinPixels: 2
              }),
              new TextLayer(props, {
                id: `${props.id}-label`,
                data: [{position: [(west + east) / 2, (south + north) / 2], text: `${z}/${x}/${y}`}],
                getPosition: d => d.position,
                getText: d => d.text,
                getSize: 14,
                getColor: [200, 100, 0, 255]
              })
            ];
          }
        })
      );
    } else {
      // Web Mercator regression: default OSM indexing, no tileMatrixSet
      tileLayers.push(
        new TileLayer({
          id: 'osm',
          data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          maxZoom: 19,
          renderSubLayers: props => {
            const {west, south, east, north} = props.tile.bbox;
            return new BitmapLayer(props, {
              data: null,
              image: props.data,
              bounds: [west, south, east, north]
            });
          }
        })
      );
    }
  }
```

Prepend `...tileLayers` to the `layers` array passed to `DeckGL` (before the states/graticule layers so vectors draw on top), and add the checkbox to the controls div:

```jsx
        <label style={{marginLeft: 8}}>
          <input type="checkbox" checked={showTiles} onChange={e => setShowTiles(e.target.checked)} />
          tiles
        </label>
```

(`UTM18N` is already defined in the app. Note `PathLayer` is already imported.)

- [ ] **Step 2: Run and verify visually**

```bash
cd test/apps/crs-viewport && yarn && npx vite --config ../vite.config.local.mjs --host 0.0.0.0
```

Verify (Playwright browser or headless script; save screenshots to `.superpowers/sdd/`):
1. **EPSG:4326 + tiles:** BlueMarble imagery renders seamlessly under the graticule; zooming in fetches deeper GIBS levels; no seams/gaps at tile boundaries; no console errors. Screenshot `task-p2-4326-tiles.png`.
2. **UTM 18N + tiles:** orange tile outlines form a continuous grid aligned with the view (labels `z/x/y`); zooming changes `z` and the grid subdivides; panning near the zone edge clamps at the matrix boundary (no tiles outside the zone). Screenshot `task-p2-utm-tiles.png`.
3. **Web Mercator + tiles:** OSM basemap renders exactly as a stock TileLayer (regression). Screenshot `task-p2-mercator-tiles.png`.
4. Toggling CRSs with tiles on does not error; the tileset is recreated cleanly.

- [ ] **Step 3: Full suite**

```bash
yarn test
```

Expected: PASS, modulo the environment-known failures recorded in `.superpowers/sdd/task-6-report.md` (loading-widget spinner; geojson-text render goldens on this machine). Anything else: investigate before committing.

- [ ] **Step 4: Commit and update progress**

```bash
git add test/apps/crs-viewport/app.jsx
git commit -m "test(geo-layers): exercise tileMatrixSet tiles in crs-viewport app"
```

Append a Phase 2 section to `.superpowers/sdd/progress.md` recording task completion and any findings.

---

## Follow-ups (out of scope for this plan)

- `_WMSLayer` TMS/CRS support (same tileset, WMS `BBOX` in CRS units).
- `MVTLayer` in CRS views (content transform assumes Mercator tiles).
- **Phase 3:** GPU warping of Web-Mercator raster sources (own spec/plan).
- OGC TMS JSON fetch helper (`fromUrl`) and registry of well-known TMSs (`WorldCRS84Quad`, `WebMercatorQuad`).
- `variableMatrixWidths` (polar/coalesced profiles).
