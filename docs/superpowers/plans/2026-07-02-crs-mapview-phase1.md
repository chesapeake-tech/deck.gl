# CRS MapView (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add non-Web-Mercator CRS support to deck.gl's `MapView` via an injected coordinate transform, a new `CRSViewport`, and a new `PROJECTION_MODE.CRS` shader mode.

**Architecture:** A `crs` prop on `MapView` selects a new `CRSViewport` whose common space is the target CRS plane normalized to deck's 512-unit world. Per-vertex lng/lat → CRS projection in the shader uses a local affine approximation (view-center origin + full 2×2 Jacobian uniform), the same offset-mode trick deck.gl already uses for `METER_OFFSETS`. CPU paths (picking, `fitBounds`, controller) use the exact injected transform. Spec: `docs/superpowers/specs/2026-07-02-crs-mapview-design.md`.

**Tech Stack:** TypeScript, GLSL + WGSL shader modules (luma.gl v9), Vitest, `@math.gl/web-mercator` (camera math only), `@math.gl/proj4` (tests only).

## Global Constraints

- Repo: `/Users/adamthomann/dev/deck.gl`, branch `feat/crs-mapview`. All paths below are relative to the repo root.
- Node >= 22. One-time setup: `yarn bootstrap` (installs and builds the monorepo). If already bootstrapped, skip.
- **No new runtime dependencies in `@deck.gl/core`.** The CRS transform is injected by the app. `@math.gl/proj4` (already a root devDependency, `package.json:54`) may be used in tests only.
- `crs` unset or `'EPSG:3857'` must produce today's behavior exactly — the full existing test suite must keep passing (`yarn test-fast` minimum per task; full `yarn test` at the end).
- Zero behavior change for Mercator/Globe/Orthographic viewports. Do not edit their code paths except where a task explicitly says so.
- License header on every new file (copy from any existing file):
  ```ts
  // deck.gl
  // SPDX-License-Identifier: MIT
  // Copyright (c) vis.gl contributors
  ```
- Run a single test file with: `npx vitest run --project node <path>` from the repo root.
- Commit after every green test cycle. Message style follows repo convention: `feat(core): <summary>`.
- New spec files under `test/modules/` are auto-discovered by Vitest glob — do NOT add imports to the legacy sibling `index.ts` files (risk of double-running).

---

### Task 1: CRS utilities (`crs-utils.ts`)

Pure functions and types: CRS normalization, lng/lat ↔ common-space transforms, finite-difference Jacobian, distance scales. No viewport code yet.

**Files:**
- Create: `modules/core/src/viewports/crs-utils.ts`
- Test: `test/modules/core/viewports/crs-utils.spec.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces (used by Tasks 2–4):
  - `type CRSTransform = {forward(lnglat: [number, number]): [number, number]; inverse(xy: [number, number]): [number, number]}`
  - `type CRSDefinition = {code: string; transform: CRSTransform; extent: [number, number, number, number]; units?: 'meters' | 'degrees'}`
  - `type NormalizedCRS = CRSDefinition & {units: 'meters' | 'degrees'; commonUnitsPerCRSUnit: number}`
  - `normalizeCRS(crs: CRSDefinition | string): NormalizedCRS`
  - `lngLatToCommon(crs: NormalizedCRS, lnglat: number[]): [number, number]`
  - `commonToLngLat(crs: NormalizedCRS, xy: number[]): [number, number]`
  - `getCRSJacobian(crs: NormalizedCRS, lnglat: number[]): [number, number, number, number]` — column-major `[dX/dlng, dY/dlng, dX/dlat, dY/dlat]` in common units per degree
  - `getCRSDistanceScales(crs: NormalizedCRS, lnglat: number[])` — returns `{unitsPerMeter, metersPerUnit, unitsPerMeter2, unitsPerDegree, degreesPerUnit, unitsPerDegree2}` (same shape `viewport-uniforms.ts:327-334` expects)
  - `clampLngLatToCRSExtent(crs: NormalizedCRS, lnglat: [number, number]): [number, number]` — clamps a lnglat so its projection lies inside `extent` (used by CRSViewport to keep the view center in-domain)
  - `CRS_WORLD_SIZE = 512`

- [ ] **Step 1: Write the failing test**

Create `test/modules/core/viewports/crs-utils.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {Proj4Projection} from '@math.gl/proj4';
import {
  normalizeCRS,
  lngLatToCommon,
  commonToLngLat,
  getCRSJacobian,
  getCRSDistanceScales,
  clampLngLatToCRSExtent,
  CRS_WORLD_SIZE
} from '@deck.gl/core/viewports/crs-utils';
import type {CRSDefinition} from '@deck.gl/core/viewports/crs-utils';

// UTM zone 18N. Anchor is definitional: central meridian -75deg at the equator
// maps to easting 500000, northing 0.
const utm18nProjection = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});
export const UTM18N: CRSDefinition = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18nProjection.project(lnglat) as [number, number],
    inverse: xy => utm18nProjection.unproject(xy) as [number, number]
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

function makeCRS(code: string, projString: string, extent: [number, number, number, number]): CRSDefinition {
  const projection = new Proj4Projection({from: 'WGS84', to: projString});
  return {
    code,
    transform: {
      forward: lnglat => projection.project(lnglat) as [number, number],
      inverse: xy => projection.unproject(xy) as [number, number]
    },
    extent,
    units: 'meters'
  };
}

// NZTM. Anchor is definitional: lon 173 / lat 0 maps to the false origin (1600000, 10000000).
const NZTM = makeCRS(
  'EPSG:2193',
  '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  [827933, 3729820, 3195373, 10000000]
);

// OSGB (British National Grid) with datum shift — round-trip only, no exact anchor
// (the false origin is exact in the OSGB36 datum, not in WGS84 degrees).
const OSGB = makeCRS(
  'EPSG:27700',
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs',
  [0, 0, 700000, 1300000]
);

test('normalizeCRS#builtin EPSG:4326', () => {
  const crs = normalizeCRS('EPSG:4326');
  expect(crs.code).toBe('EPSG:4326');
  expect(crs.units).toBe('degrees');
  expect(crs.commonUnitsPerCRSUnit).toBeCloseTo(CRS_WORLD_SIZE / 360, 10);
  expect(crs.transform.forward([12.5, -33])).toEqual([12.5, -33]);
});

test('normalizeCRS#unknown string throws', () => {
  expect(() => normalizeCRS('EPSG:27700')).toThrow(/EPSG:27700/);
});

test('normalizeCRS#invalid extent throws', () => {
  expect(() =>
    normalizeCRS({...UTM18N, extent: [10, 0, 10, 100] as [number, number, number, number]})
  ).toThrow(/extent/);
});

test('lngLatToCommon#EPSG:4326', () => {
  const crs = normalizeCRS('EPSG:4326');
  expect(lngLatToCommon(crs, [0, 0])).toEqual([256, 128]);
  expect(lngLatToCommon(crs, [-180, -90])).toEqual([0, 0]);
  expect(commonToLngLat(crs, [256, 128])).toEqual([0, 0]);
});

test('lngLatToCommon#UTM anchor and round trip', () => {
  const crs = normalizeCRS(UTM18N);
  // central meridian is the exact center of the symmetric UTM extent
  const [x, y] = lngLatToCommon(crs, [-75, 0]);
  expect(x).toBeCloseTo(CRS_WORLD_SIZE / 2, 3);
  expect(y).toBeCloseTo(0, 3);

  for (const lnglat of [
    [-75, 0],
    [-72.3, 40.7],
    [-77.9, 8.1]
  ]) {
    const roundTrip = commonToLngLat(crs, lngLatToCommon(crs, lnglat));
    expect(roundTrip[0]).toBeCloseTo(lnglat[0], 6);
    expect(roundTrip[1]).toBeCloseTo(lnglat[1], 6);
  }
});

test('getCRSJacobian#EPSG:4326 is exactly linear', () => {
  const crs = normalizeCRS('EPSG:4326');
  const k = CRS_WORLD_SIZE / 360;
  const jacobian = getCRSJacobian(crs, [30, 45]);
  expect(jacobian[0]).toBeCloseTo(k, 6);
  expect(jacobian[1]).toBeCloseTo(0, 6);
  expect(jacobian[2]).toBeCloseTo(0, 6);
  expect(jacobian[3]).toBeCloseTo(k, 6);
});

test('getCRSJacobian#UTM grid convergence', () => {
  const crs = normalizeCRS(UTM18N);
  // 3 degrees east of the central meridian at lat 40:
  // gamma = atan(tan(dLng) * sin(lat)) ~ 1.93 degrees
  const jacobian = getCRSJacobian(crs, [-72, 40]);
  const convergence = Math.abs(
    (Math.atan2(jacobian[1], jacobian[0]) * 180) / Math.PI
  );
  expect(convergence).toBeGreaterThan(1.8);
  expect(convergence).toBeLessThan(2.1);
  // On the central meridian there is no convergence
  const jacobianCM = getCRSJacobian(crs, [-75, 40]);
  expect(Math.abs(jacobianCM[1] / jacobianCM[0])).toBeLessThan(1e-4);
});

test('lngLatToCommon#NZTM anchor and multi-CRS round trips', () => {
  const nztm = normalizeCRS(NZTM);
  const [x, y] = lngLatToCommon(nztm, [173, 0]);
  // false origin (1600000, 10000000) in common space
  expect(x).toBeCloseTo((1600000 - NZTM.extent[0]) * nztm.commonUnitsPerCRSUnit, 3);
  expect(y).toBeCloseTo((10000000 - NZTM.extent[1]) * nztm.commonUnitsPerCRSUnit, 3);

  for (const [crsDef, lnglat] of [
    [NZTM, [174.76, -36.85]], // Auckland
    [NZTM, [170.5, -45.87]], // Dunedin
    [OSGB, [-0.128, 51.507]], // London
    [OSGB, [-4.25, 55.86]] // Glasgow
  ] as const) {
    const crs = normalizeCRS(crsDef);
    const roundTrip = commonToLngLat(crs, lngLatToCommon(crs, lnglat as number[]));
    expect(roundTrip[0]).toBeCloseTo(lnglat[0], 6);
    expect(roundTrip[1]).toBeCloseTo(lnglat[1], 6);
  }
});

test('clampLngLatToCRSExtent', () => {
  const crs = normalizeCRS(UTM18N);
  // In-domain position is unchanged
  const inside = clampLngLatToCRSExtent(crs, [-72, 40]);
  expect(inside[0]).toBeCloseTo(-72, 6);
  expect(inside[1]).toBeCloseTo(40, 6);
  // Southern-hemisphere latitude projects below the zone's minY=0; clamped back in-domain
  const clamped = clampLngLatToCRSExtent(crs, [-72, -20]);
  const projected = crs.transform.forward(clamped);
  expect(projected[1]).toBeGreaterThanOrEqual(crs.extent[1]);
  expect(Number.isFinite(projected[0])).toBe(true);
});

test('getCRSDistanceScales#UTM', () => {
  const crs = normalizeCRS(UTM18N);
  const scales = getCRSDistanceScales(crs, [-75, 0]);
  const k = CRS_WORLD_SIZE / (UTM18N.extent[2] - UTM18N.extent[0]);
  // 1 CRS unit = 1 meter, modulo the UTM scale factor 0.9996
  expect(scales.unitsPerMeter[2]).toBeCloseTo(k, 3);
  expect(scales.unitsPerMeter[2] / k).toBeGreaterThan(0.99);
  expect(scales.metersPerUnit[2] * scales.unitsPerMeter[2]).toBeCloseTo(1, 6);
  expect(scales.unitsPerDegree2).toEqual([0, 0, 0]);
});
```

Note the `@deck.gl/core/viewports/crs-utils` deep import: check how other specs import internals — if the Vitest alias only maps the package root, change the import to a relative path (`../../../../modules/core/src/viewports/crs-utils`) in both this file and later specs. `web-mercator-viewport.spec.ts` imports from `deck.gl`/`@deck.gl/core`; deep-import only what isn't exported yet (Task 4 adds public exports).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/core/viewports/crs-utils.spec.ts`
Expected: FAIL — cannot resolve `crs-utils` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `modules/core/src/viewports/crs-utils.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Width of the common-space world at zoom 0. Matches Web Mercator's world size. */
export const CRS_WORLD_SIZE = 512;

/** Meters per degree of latitude (Earth circumference / 360). Matches @math.gl/web-mercator. */
const METERS_PER_DEGREE = 4.003e7 / 360;

/** Finite-difference step for Jacobian estimation, in degrees (~1 meter) */
const JACOBIAN_STEP = 1e-5;

export type CRSTransform = {
  /** Project [longitude, latitude] in WGS84 degrees to [x, y] in CRS units */
  forward: (lnglat: [number, number]) => [number, number];
  /** Unproject [x, y] in CRS units to [longitude, latitude] in WGS84 degrees */
  inverse: (xy: [number, number]) => [number, number];
};

export type CRSDefinition = {
  /** Identifier, e.g. 'EPSG:32618'. Used for viewport equality checks and debugging. */
  code: string;
  transform: CRSTransform;
  /** [minX, minY, maxX, maxY] valid bounds in CRS units. Defines the common-space world scale. */
  extent: [number, number, number, number];
  /** CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default 'meters'. */
  units?: 'meters' | 'degrees';
};

export type NormalizedCRS = {
  code: string;
  transform: CRSTransform;
  extent: [number, number, number, number];
  units: 'meters' | 'degrees';
  /** Common units per CRS unit: CRS_WORLD_SIZE / extent width */
  commonUnitsPerCRSUnit: number;
};

const EPSG_4326: CRSDefinition = {
  code: 'EPSG:4326',
  transform: {
    forward: lnglat => [lnglat[0], lnglat[1]],
    inverse: xy => [xy[0], xy[1]]
  },
  extent: [-180, -90, 180, 90],
  units: 'degrees'
};

export function normalizeCRS(crs: CRSDefinition | string): NormalizedCRS {
  let definition: CRSDefinition;
  if (typeof crs === 'string') {
    if (crs === 'EPSG:4326') {
      definition = EPSG_4326;
    } else {
      throw new Error(
        `Unknown CRS: ${crs}. Only 'EPSG:4326' is built in; pass a CRSDefinition with a transform for other CRSs.`
      );
    }
  } else {
    definition = crs;
  }

  const {code, transform, extent, units = 'meters'} = definition;
  if (!extent || !(extent[2] > extent[0]) || !(extent[3] > extent[1])) {
    throw new Error(`CRS ${code}: extent must be [minX, minY, maxX, maxY] with positive size`);
  }

  const commonUnitsPerCRSUnit = CRS_WORLD_SIZE / (extent[2] - extent[0]);
  const normalized: NormalizedCRS = {code, transform, extent, units, commonUnitsPerCRSUnit};

  // Validate that the transform round-trips at the extent center
  const centerLngLat = transform.inverse([(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2]);
  const centerXY = transform.forward(centerLngLat);
  if (!Number.isFinite(centerLngLat[0] + centerLngLat[1] + centerXY[0] + centerXY[1])) {
    throw new Error(`CRS ${code}: transform failed to round-trip the extent center`);
  }

  return normalized;
}

/** Project [lng, lat] to common space: CRS units offset by extent min, scaled to the 512 world */
export function lngLatToCommon(crs: NormalizedCRS, lnglat: number[]): [number, number] {
  const [x, y] = crs.transform.forward([lnglat[0], lnglat[1]]);
  return [
    (x - crs.extent[0]) * crs.commonUnitsPerCRSUnit,
    (y - crs.extent[1]) * crs.commonUnitsPerCRSUnit
  ];
}

export function commonToLngLat(crs: NormalizedCRS, xy: number[]): [number, number] {
  return crs.transform.inverse([
    xy[0] / crs.commonUnitsPerCRSUnit + crs.extent[0],
    xy[1] / crs.commonUnitsPerCRSUnit + crs.extent[1]
  ]);
}

function isFinite2(xy: number[]): boolean {
  return Number.isFinite(xy[0]) && Number.isFinite(xy[1]);
}

/** d(common) / d(degrees) along one lnglat axis, by finite differences.
 * Falls back to one-sided differences at the edge of the CRS domain. */
function partialDerivative(
  crs: NormalizedCRS,
  lnglat: number[],
  axis: 0 | 1
): [number, number] {
  const hi: number[] = [lnglat[0], lnglat[1]];
  const lo: number[] = [lnglat[0], lnglat[1]];
  hi[axis] += JACOBIAN_STEP;
  lo[axis] -= JACOBIAN_STEP;

  let p1 = lngLatToCommon(crs, hi);
  let p0 = lngLatToCommon(crs, lo);
  let h = 2 * JACOBIAN_STEP;
  if (!isFinite2(p1)) {
    p1 = lngLatToCommon(crs, lnglat);
    h = JACOBIAN_STEP;
  } else if (!isFinite2(p0)) {
    p0 = lngLatToCommon(crs, lnglat);
    h = JACOBIAN_STEP;
  }
  if (!isFinite2(p0) || !isFinite2(p1)) {
    throw new Error(`CRS ${crs.code}: transform is not differentiable at [${lnglat}]`);
  }
  return [(p1[0] - p0[0]) / h, (p1[1] - p0[1]) / h];
}

/** Column-major 2x2 Jacobian of the lnglat->common transform at the given position:
 * [dX/dlng, dY/dlng, dX/dlat, dY/dlat] in common units per degree */
export function getCRSJacobian(
  crs: NormalizedCRS,
  lnglat: number[]
): [number, number, number, number] {
  const dLng = partialDerivative(crs, lnglat, 0);
  const dLat = partialDerivative(crs, lnglat, 1);
  return [dLng[0], dLng[1], dLat[0], dLat[1]];
}

/** Common units per meter of elevation, derived from the meridional scale at the position.
 * For a meters-based CRS this is ~commonUnitsPerCRSUnit; for a degrees CRS it accounts
 * for the degree/meter ratio. */
function getUnitsPerMeter(jacobian: [number, number, number, number]): number {
  return Math.hypot(jacobian[2], jacobian[3]) / METERS_PER_DEGREE;
}

/** Clamp a lnglat position so that its projection lies inside the CRS extent.
 * Works in CRS space: project, clamp XY to the extent, unproject. If the forward
 * transform is not finite at the input, falls back to the extent center. */
export function clampLngLatToCRSExtent(
  crs: NormalizedCRS,
  lnglat: [number, number]
): [number, number] {
  const [minX, minY, maxX, maxY] = crs.extent;
  let xy = crs.transform.forward(lnglat);
  if (!isFinite2(xy)) {
    xy = [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  const clampedX = Math.min(Math.max(xy[0], minX), maxX);
  const clampedY = Math.min(Math.max(xy[1], minY), maxY);
  if (clampedX === xy[0] && clampedY === xy[1]) {
    return lnglat;
  }
  return crs.transform.inverse([clampedX, clampedY]);
}

/** DistanceScales in the shape viewport-uniforms.ts expects from getDistanceScales(origin) */
export function getCRSDistanceScales(crs: NormalizedCRS, lnglat: number[]) {
  const jacobian = getCRSJacobian(crs, lnglat);
  const unitsPerMeter = getUnitsPerMeter(jacobian);
  const unitsPerDegreeX = Math.hypot(jacobian[0], jacobian[1]);
  const unitsPerDegreeY = Math.hypot(jacobian[2], jacobian[3]);
  return {
    unitsPerMeter: [unitsPerMeter, unitsPerMeter, unitsPerMeter],
    metersPerUnit: [1 / unitsPerMeter, 1 / unitsPerMeter, 1 / unitsPerMeter],
    unitsPerMeter2: [0, 0, 0],
    unitsPerDegree: [unitsPerDegreeX, unitsPerDegreeY, unitsPerMeter],
    degreesPerUnit: [1 / unitsPerDegreeX, 1 / unitsPerDegreeY, 1 / unitsPerMeter],
    unitsPerDegree2: [0, 0, 0]
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project node test/modules/core/viewports/crs-utils.spec.ts`
Expected: PASS (8 tests). If the deep import fails to resolve, switch to relative imports as noted in Step 1.

- [ ] **Step 5: Commit**

```bash
git add modules/core/src/viewports/crs-utils.ts test/modules/core/viewports/crs-utils.spec.ts
git commit -m "feat(core): add CRS transform utilities for non-mercator projections"
```

---

### Task 2: `PROJECTION_MODE.CRS` and `CRSViewport`

**Files:**
- Modify: `modules/core/src/lib/constants.ts:68-87` (add `CRS` projection mode)
- Modify: `modules/core/src/viewports/viewport.ts:421,456` (make `_initProps` / `_initMatrices` `protected`)
- Create: `modules/core/src/viewports/crs-viewport.ts`
- Test: `test/modules/core/viewports/crs-viewport.spec.ts`

**Interfaces:**
- Consumes: everything from Task 1 (`normalizeCRS`, `lngLatToCommon`, `commonToLngLat`, `getCRSJacobian`, `getCRSDistanceScales`, types).
- Produces (used by Tasks 3–4):
  - `PROJECTION_MODE.CRS = 5` in `constants.ts`
  - `class CRSViewport extends Viewport` with `crs: NormalizedCRS`, `longitude/latitude/zoom/pitch/bearing` fields, `projectionMode` returning `PROJECTION_MODE.CRS`, and `getCRSJacobianAtOrigin(origin: number[]): [number, number, number, number]`
  - `type CRSViewportOptions` (constructor options, includes `crs: CRSDefinition | string`)

- [ ] **Step 1: Write the failing test**

Create `test/modules/core/viewports/crs-viewport.spec.ts`. Re-use the UTM fixture by exporting `UTM18N` from the Task 1 spec (already exported there):

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import {PROJECTION_MODE} from '@deck.gl/core/lib/constants';
import {UTM18N} from './crs-utils.spec';

const BASE_PROPS = {width: 800, height: 600, crs: UTM18N};

test('CRSViewport#construction and projectionMode', () => {
  const viewport = new CRSViewport({...BASE_PROPS, longitude: -72, latitude: 40, zoom: 10});
  expect(viewport.projectionMode).toBe(PROJECTION_MODE.CRS);
  expect(viewport.isGeospatial).toBe(true);
  expect(viewport.crs.code).toBe('EPSG:32618');
});

test('CRSViewport#center unprojects to view state lnglat', () => {
  const viewport = new CRSViewport({...BASE_PROPS, longitude: -72, latitude: 40, zoom: 10});
  const [lng, lat] = viewport.unproject([400, 300]);
  expect(lng).toBeCloseTo(-72, 6);
  expect(lat).toBeCloseTo(40, 6);
});

test('CRSViewport#project/unproject round trip (with bearing and pitch)', () => {
  const viewport = new CRSViewport({
    ...BASE_PROPS,
    longitude: -72,
    latitude: 40,
    zoom: 11,
    bearing: 30,
    pitch: 40
  });
  for (const lnglat of [
    [-72, 40],
    [-72.05, 40.02],
    [-71.9, 39.95]
  ]) {
    const pixel = viewport.project(lnglat);
    const result = viewport.unproject(pixel);
    expect(result[0]).toBeCloseTo(lnglat[0], 5);
    expect(result[1]).toBeCloseTo(lnglat[1], 5);
  }
});

test('CRSViewport#EPSG:4326 linear pixel mapping', () => {
  const viewport = new CRSViewport({
    width: 800,
    height: 600,
    crs: 'EPSG:4326',
    longitude: 0,
    latitude: 0,
    zoom: 1
  });
  // common dx = 90 * (512/360) = 128; pixels per common unit = 2^zoom = 2
  const [x, y] = viewport.project([90, 0]);
  expect(x).toBeCloseTo(400 + 256, 3);
  expect(y).toBeCloseTo(300, 3);
});

test('CRSViewport#panByPosition keeps anchor under cursor', () => {
  const viewport = new CRSViewport({...BASE_PROPS, longitude: -72, latitude: 40, zoom: 10});
  const anchor = viewport.unproject([500, 200]);
  const newProps = viewport.panByPosition(anchor, [450, 250]);
  const newViewport = new CRSViewport({...BASE_PROPS, zoom: 10, ...newProps});
  const pixel = newViewport.project(anchor);
  expect(pixel[0]).toBeCloseTo(450, 3);
  expect(pixel[1]).toBeCloseTo(250, 3);
});

test('CRSViewport#fitBounds contains bounds', () => {
  const viewport = new CRSViewport({...BASE_PROPS, longitude: -75, latitude: 0, zoom: 4});
  const fitted = viewport.fitBounds(
    [
      [-72.4, 40.5],
      [-72.0, 40.8]
    ],
    {padding: 20}
  );
  expect(fitted.longitude).toBeCloseTo(-72.2, 1);
  expect(fitted.latitude).toBeCloseTo(40.65, 1);
  const [minX, minY, maxX, maxY] = fitted.getBounds();
  expect(minX).toBeLessThanOrEqual(-72.4);
  expect(maxX).toBeGreaterThanOrEqual(-72.0);
  expect(minY).toBeLessThanOrEqual(40.5);
  expect(maxY).toBeGreaterThanOrEqual(40.8);
});

test('CRSViewport#out-of-domain center is clamped, not NaN', () => {
  // Latitude -20 projects below the UTM 18N extent's minY
  const viewport = new CRSViewport({...BASE_PROPS, longitude: -72, latitude: -20, zoom: 8});
  expect(Number.isFinite(viewport.center[0])).toBe(true);
  expect(Number.isFinite(viewport.center[1])).toBe(true);
  const [lng, lat] = viewport.unproject([400, 300]);
  expect(Number.isFinite(lng)).toBe(true);
  // clamped to the equator edge of the zone
  expect(lat).toBeGreaterThanOrEqual(-0.01);
});

test('CRSViewport#equals', () => {
  const opts = {...BASE_PROPS, longitude: -72, latitude: 40, zoom: 10};
  expect(new CRSViewport(opts).equals(new CRSViewport(opts))).toBe(true);
  expect(
    new CRSViewport(opts).equals(new CRSViewport({...opts, crs: 'EPSG:4326'}))
  ).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/core/viewports/crs-viewport.spec.ts`
Expected: FAIL — `crs-viewport` module not found.

- [ ] **Step 3: Add the projection mode constant**

In `modules/core/src/lib/constants.ts`, inside the `PROJECTION_MODE` object (after the `WEB_MERCATOR_AUTO_OFFSET: 4,` entry at line 81, before `IDENTITY`):

```ts
  /**
   * Render geospatial data in a non-Web-Mercator CRS supplied via a CRSViewport.
   * Positions are projected with a local affine approximation around the view center.
   */
  CRS: 5,
```

(The GLSL/WGSL constant `PROJECTION_MODE_CRS` is generated automatically from this object — see `project.glsl.ts:20-22`.)

- [ ] **Step 4: Make base Viewport init hooks protected**

In `modules/core/src/viewports/viewport.ts`, change line 421 `private _initProps(opts: ViewportOptions) {` to `protected _initProps(opts: ViewportOptions) {` and line 456 `private _initMatrices(opts: ViewportOptions) {` to `protected _initMatrices(opts: ViewportOptions) {`.

Reason (add as a comment above `_initProps`): the base constructor computes `center` via `this.projectPosition(...)` before subclass fields exist; a subclass whose projection depends on constructor arguments (CRSViewport) must re-run these after assigning its fields.

- [ ] **Step 5: Write CRSViewport**

Create `modules/core/src/viewports/crs-viewport.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Viewport from './viewport';
import type {ViewportOptions, Padding, DistanceScales} from './viewport';
import {PROJECTION_MODE} from '../lib/constants';
import {
  pixelsToWorld,
  getViewMatrix,
  getProjectionParameters,
  altitudeToFovy,
  fovyToAltitude
} from '@math.gl/web-mercator';
import {vec2} from '@math.gl/core';
import {
  normalizeCRS,
  lngLatToCommon,
  commonToLngLat,
  getCRSJacobian,
  getCRSDistanceScales,
  clampLngLatToCRSExtent
} from './crs-utils';
import type {CRSDefinition, NormalizedCRS} from './crs-utils';

export type CRSViewportOptions = {
  /** Coordinate reference system to render in */
  crs: CRSDefinition | string;
  /** Name of the viewport */
  id?: string;
  /** Left offset from the canvas edge, in pixels */
  x?: number;
  /** Top offset from the canvas edge, in pixels */
  y?: number;
  /** Viewport width in pixels */
  width?: number;
  /** Viewport height in pixels */
  height?: number;
  /** Longitude of the view center, in degrees */
  longitude?: number;
  /** Latitude of the view center, in degrees */
  latitude?: number;
  /** Tilt of the camera in degrees */
  pitch?: number;
  /** Heading of the camera in degrees. `0` is CRS grid-north up */
  bearing?: number;
  /** Camera altitude relative to the viewport height, used to control the FOV. Default `1.5` */
  altitude?: number;
  /** Camera fovy in degrees. If provided, overrides `altitude` */
  fovy?: number;
  /** Viewport center offsets from lng, lat, in meters */
  position?: number[];
  /** Zoom level */
  zoom?: number;
  /** Padding around the viewport, in pixels */
  padding?: Padding | null;
  /** Whether to create an orthographic or perspective projection matrix. Default `false` */
  orthographic?: boolean;
  /** Scaler for the near plane, 1 unit equals to the height of the viewport. Default `0.1` */
  nearZMultiplier?: number;
  /** Scaler for the far plane, 1 unit equals to the distance from the camera to the edge of the screen. Default `1.01` */
  farZMultiplier?: number;
  /** Optionally override the near plane position */
  nearZ?: number;
  /** Optionally override the far plane position */
  farZ?: number;
};

/**
 * Renders a geospatial view in an arbitrary projected CRS.
 * Common space is the CRS plane, offset by the extent min and normalized so that
 * the extent width maps to the 512-unit world (Mercator-compatible zoom semantics).
 */
export default class CRSViewport extends Viewport {
  static displayName = 'CRSViewport';

  longitude: number;
  latitude: number;
  pitch: number;
  bearing: number;
  altitude: number;
  fovy: number;
  orthographic: boolean;
  crs!: NormalizedCRS;

  constructor(opts: CRSViewportOptions) {
    const {
      zoom = 0,
      pitch = 0,
      bearing = 0,
      nearZMultiplier = 0.1,
      farZMultiplier = 1.01,
      orthographic = false
    } = opts;

    let {width, height, altitude = 1.5} = opts;
    const scale = Math.pow(2, zoom);
    width = width || 1;
    height = height || 1;

    let fovy = opts.fovy;
    if (fovy) {
      altitude = fovyToAltitude(fovy);
    } else {
      fovy = altitudeToFovy(altitude);
    }

    const crs = normalizeCRS(opts.crs);
    // Keep the view center inside the CRS domain — an out-of-domain center can
    // produce non-finite transforms (e.g. panning a UTM zone past its extent)
    const [longitude, latitude] = clampLngLatToCRSExtent(crs, [
      opts.longitude ?? 0,
      opts.latitude ?? 0
    ]);
    const distanceScales = getCRSDistanceScales(crs, [longitude, latitude]) as DistanceScales;

    // Same camera math as WebMercatorViewport: these utilities operate in
    // common-space units and are not Mercator-specific.
    const viewMatrixUncentered = getViewMatrix({height, pitch, bearing, scale, altitude});

    const projectionParameters = getProjectionParameters({
      width,
      height,
      scale,
      pitch,
      fovy,
      nearZMultiplier,
      farZMultiplier
    });
    if (Number.isFinite(opts.nearZ)) {
      projectionParameters.near = opts.nearZ as number;
    }
    if (Number.isFinite(opts.farZ)) {
      projectionParameters.far = opts.farZ as number;
    }

    const viewportOpts: ViewportOptions = {
      ...opts,
      width,
      height,
      viewMatrix: viewMatrixUncentered,
      longitude,
      latitude,
      zoom,
      distanceScales,
      ...projectionParameters,
      fovy,
      focalDistance: altitude
    };

    super(viewportOpts);

    this.crs = crs;
    this.latitude = latitude;
    this.longitude = longitude;
    this.zoom = zoom;
    this.pitch = pitch;
    this.bearing = bearing;
    this.altitude = altitude;
    this.fovy = fovy;
    this.orthographic = orthographic;

    // The base constructor computed `center` (and the matrices derived from it)
    // before `this.crs` was assigned, using the projectFlat fallback below.
    // Re-run initialization with the real transform.
    this._initProps(viewportOpts);
    this._initMatrices(viewportOpts);

    Object.freeze(this);
  }

  get projectionMode(): number {
    return PROJECTION_MODE.CRS;
  }

  projectFlat(xyz: number[]): [number, number] {
    if (!this.crs) {
      // Called from the base constructor before `this.crs` is assigned; the
      // constructor re-runs _initProps/_initMatrices with the real transform.
      return [0, 0];
    }
    return lngLatToCommon(this.crs, xyz);
  }

  unprojectFlat(xyz: number[]): [number, number] {
    return commonToLngLat(this.crs, xyz);
  }

  getDistanceScales(coordinateOrigin?: number[]): DistanceScales {
    if (coordinateOrigin) {
      return getCRSDistanceScales(this.crs, coordinateOrigin) as DistanceScales;
    }
    return this.distanceScales;
  }

  /** Column-major 2x2 Jacobian of the lnglat->common transform at the given origin,
   * in common units per degree. Uploaded as a shader uniform for the local affine
   * approximation of this CRS. */
  getCRSJacobianAtOrigin(origin: number[]): [number, number, number, number] {
    return getCRSJacobian(this.crs, origin);
  }

  panByPosition(coords: number[], pixel: number[]): Partial<CRSViewportOptions> {
    const fromLocation = pixelsToWorld(pixel, this.pixelUnprojectionMatrix);
    const toLocation = this.projectFlat(coords);

    const translate = vec2.add([], toLocation, vec2.negate([], fromLocation));
    const newCenter = vec2.add([], this.center, translate);

    const [longitude, latitude] = this.unprojectFlat(newCenter);
    return {longitude, latitude};
  }

  /** Returns a new viewport that fits around the given lnglat bounds.
   * Only supports non-perspective mode. */
  fitBounds(
    /** [[west, south], [east, north]] in degrees */
    bounds: [[number, number], [number, number]],
    options: {padding?: number} = {}
  ): CRSViewport {
    const [[west, south], [east, north]] = bounds;
    const corner0 = lngLatToCommon(this.crs, [west, south]);
    const corner1 = lngLatToCommon(this.crs, [east, north]);
    const padding = options.padding || 0;

    const sizeX = Math.max(Math.abs(corner1[0] - corner0[0]), Number.EPSILON);
    const sizeY = Math.max(Math.abs(corner1[1] - corner0[1]), Number.EPSILON);
    // pixels per common unit = 2^zoom
    const scaleX = (this.width - padding * 2) / sizeX;
    const scaleY = (this.height - padding * 2) / sizeY;
    const zoom = Math.log2(Math.max(Math.min(scaleX, scaleY), Number.EPSILON));

    const [longitude, latitude] = commonToLngLat(this.crs, [
      (corner0[0] + corner1[0]) / 2,
      (corner0[1] + corner1[1]) / 2
    ]);

    return new CRSViewport({
      crs: this.crs,
      width: this.width,
      height: this.height,
      longitude,
      latitude,
      zoom
    });
  }

  equals(viewport: Viewport): boolean {
    if (!(viewport instanceof CRSViewport) || viewport.crs.code !== this.crs.code) {
      return false;
    }
    return super.equals(viewport);
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project node test/modules/core/viewports/crs-viewport.spec.ts test/modules/core/viewports/crs-utils.spec.ts`
Expected: PASS. Common failure modes if not:
- Center test off → the `_initProps`/`_initMatrices` re-run isn't using `viewportOpts` (it must, so `distanceScales` and `viewMatrix` are the computed ones, not raw `opts`).
- `Object.freeze` error → re-init must happen before freeze.

- [ ] **Step 7: Verify no regression**

Run: `npx vitest run --project node test/modules/core/viewports`
Expected: PASS — all existing viewport specs (conformance, web-mercator, globe, orbit) still green.

- [ ] **Step 8: Commit**

```bash
git add modules/core/src/lib/constants.ts modules/core/src/viewports/viewport.ts modules/core/src/viewports/crs-viewport.ts test/modules/core/viewports/crs-viewport.spec.ts
git commit -m "feat(core): add CRSViewport and PROJECTION_MODE.CRS"
```

---

### Task 3: Shader mode — uniforms, GLSL, WGSL

**Files:**
- Modify: `modules/core/src/shaderlib/project/viewport-uniforms.ts` (getOffsetOrigin case ~line 100; ProjectUniforms type ~line 185; calculateViewportUniforms ~line 293)
- Modify: `modules/core/src/shaderlib/project/project.ts:28-46` (uniformTypes)
- Modify: `modules/core/src/shaderlib/project/project.glsl.ts` (UBO ~line 32; project_position ~line 188)
- Modify: `modules/core/src/shaderlib/project/project.wgsl.ts` (struct ~line 42; project_position_vec4_f64 ~line 209)
- Test: `test/modules/core/shaderlib/project/crs-project.spec.ts`

**Interfaces:**
- Consumes: `PROJECTION_MODE.CRS`, `CRSViewport` with `getCRSJacobianAtOrigin(origin)` (Task 2).
- Produces: `ProjectUniforms.crsUnitsPerDegree: [number, number, number, number]` uniform (column-major 2×2 Jacobian, default `[1, 0, 0, 1]`); shader branch handling `PROJECTION_MODE_CRS` for `LNGLAT` and `CARTESIAN` coordinate systems.

- [ ] **Step 1: Write the failing test**

Create `test/modules/core/shaderlib/project/crs-project.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {PROJECTION_MODE} from '@deck.gl/core/lib/constants';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import {getUniformsFromViewport} from '@deck.gl/core/shaderlib/project/viewport-uniforms';
import {UTM18N} from '../../viewports/crs-utils.spec';

function makeViewport(props = {}) {
  return new CRSViewport({
    width: 800,
    height: 600,
    crs: UTM18N,
    longitude: -72,
    latitude: 40,
    zoom: 10,
    ...props
  });
}

test('CRS uniforms#projectionMode and jacobian', () => {
  const viewport = makeViewport();
  const uniforms = getUniformsFromViewport({viewport});

  expect(uniforms.projectionMode).toBe(PROJECTION_MODE.CRS);
  expect(uniforms.coordinateSystem).toBe(1); // lnglat
  // coordinateOrigin is the view center in lnglat (fp32 rounded)
  expect(uniforms.coordinateOrigin[0]).toBeCloseTo(-72, 5);
  expect(uniforms.coordinateOrigin[1]).toBeCloseTo(40, 5);
  // commonOrigin is the view center projected to common space
  const centerCommon = viewport.projectPosition([-72, 40, 0]);
  expect(uniforms.commonOrigin[0]).toBeCloseTo(centerCommon[0], 4);
  expect(uniforms.commonOrigin[1]).toBeCloseTo(centerCommon[1], 4);
  // Full 2x2 jacobian is uploaded
  const jacobian = viewport.getCRSJacobianAtOrigin([-72, 40]);
  for (let i = 0; i < 4; i++) {
    expect(uniforms.crsUnitsPerDegree[i]).toBeCloseTo(jacobian[i], 6);
  }
  // Convergence: off-diagonal terms are non-zero away from the central meridian
  expect(Math.abs(uniforms.crsUnitsPerDegree[1])).toBeGreaterThan(0);
});

test('CRS uniforms#mercator viewports are untouched', () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10
  });
  const uniforms = getUniformsFromViewport({viewport});
  expect(uniforms.projectionMode).toBe(PROJECTION_MODE.WEB_MERCATOR);
  expect(uniforms.crsUnitsPerDegree).toEqual([1, 0, 0, 1]);
});

/** JS re-implementation of the CRS shader branch in project_position() */
function shaderProjectLngLat(uniforms, lnglat: number[]): [number, number] {
  const dx = lnglat[0] - uniforms.coordinateOrigin[0];
  const dy = lnglat[1] - uniforms.coordinateOrigin[1];
  const jacobian = uniforms.crsUnitsPerDegree;
  // offset mode: the projected center is re-added in clip space via uniforms.center,
  // equivalent to adding commonOrigin here for comparison in common space
  return [
    uniforms.commonOrigin[0] + jacobian[0] * dx + jacobian[2] * dy,
    uniforms.commonOrigin[1] + jacobian[1] * dx + jacobian[3] * dy
  ];
}

test('CRS shader linearization#sub-pixel error across the viewport', () => {
  for (const zoom of [5, 10, 14]) {
    const viewport = makeViewport({zoom, pitch: 0, bearing: 0});
    const uniforms = getUniformsFromViewport({viewport});
    const [west, south, east, north] = viewport.getBounds();
    const samples = [
      [west, south],
      [west, north],
      [east, south],
      [east, north],
      [(west + east) / 2, (south + north) / 2]
    ];
    for (const lnglat of samples) {
      const approx = shaderProjectLngLat(uniforms, lnglat);
      const exact = viewport.projectPosition([lnglat[0], lnglat[1], 0]);
      const errorPixels = Math.hypot(approx[0] - exact[0], approx[1] - exact[1]) * viewport.scale;
      expect(errorPixels).toBeLessThan(1);
    }
  }
});

test('CRS shader linearization#EPSG:4326 is exact', () => {
  const viewport = new CRSViewport({
    width: 800,
    height: 600,
    crs: 'EPSG:4326',
    longitude: 20,
    latitude: -30,
    zoom: 3
  });
  const uniforms = getUniformsFromViewport({viewport});
  const approx = shaderProjectLngLat(uniforms, [55, 10]);
  const exact = viewport.projectPosition([55, 10, 0]);
  expect(approx[0]).toBeCloseTo(exact[0], 6);
  expect(approx[1]).toBeCloseTo(exact[1], 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/core/shaderlib/project/crs-project.spec.ts`
Expected: FAIL — `projectionMode` handled as "unknown" (`offsetMode = false` default in `getOffsetOrigin`), `crsUnitsPerDegree` undefined.

- [ ] **Step 3: Add the getOffsetOrigin case and the jacobian uniform**

In `modules/core/src/shaderlib/project/viewport-uniforms.ts`:

3a. In `getOffsetOrigin()`, after the `case PROJECTION_MODE.WEB_MERCATOR_AUTO_OFFSET:` block (ends line 98), add a mirror case:

```ts
    case PROJECTION_MODE.CRS:
      if (coordinateSystem === 'lnglat') {
        // viewport center in world space
        // @ts-expect-error when using LNGLAT coordinates, we expect the viewport to be geospatial, in which case geospatialOrigin is defined
        shaderCoordinateOrigin = geospatialOrigin;
      } else if (coordinateSystem === 'cartesian') {
        // viewport center in common space
        shaderCoordinateOrigin = [
          Math.fround(viewport.center[0]),
          Math.fround(viewport.center[1]),
          0
        ];
        // Geospatial origin (wgs84) must match shaderCoordinateOrigin (common)
        geospatialOrigin = viewport.unprojectPosition(shaderCoordinateOrigin);
        shaderCoordinateOrigin[0] -= coordinateOrigin[0];
        shaderCoordinateOrigin[1] -= coordinateOrigin[1];
        shaderCoordinateOrigin[2] -= coordinateOrigin[2];
      }
      break;
```

3b. In the `ProjectUniforms` type (after `commonUnitsPerWorldUnit2: Vec3;` at line 202), add:

```ts
  /** PROJECTION_MODE.CRS only: column-major 2x2 Jacobian of the lnglat->common
   * transform at the view center, in common units per degree */
  crsUnitsPerDegree: Vec4;
```

3c. In `calculateViewportUniforms()`, add `crsUnitsPerDegree: [1, 0, 0, 1],` to the `uniforms` object literal (after the `commonUnitsPerWorldUnit2: DEFAULT_PIXELS_PER_UNIT2,` line at 313).

3d. After the `if (geospatialOrigin) { ... switch ... }` block (closes line 360), add:

```ts
  if (viewport.projectionMode === PROJECTION_MODE.CRS && geospatialOrigin) {
    // The diagonal commonUnitsPerWorldUnit cannot represent grid convergence
    // (the local rotation of the CRS grid vs true north); upload the full 2x2 Jacobian.
    uniforms.crsUnitsPerDegree = (
      viewport as Viewport & {
        getCRSJacobianAtOrigin: (origin: number[]) => Vec4;
      }
    ).getCRSJacobianAtOrigin(geospatialOrigin);
  }
```

- [ ] **Step 4: Register the uniform type**

In `modules/core/src/shaderlib/project/project.ts`, add to `uniformTypes` after `pseudoMeters: 'f32'` (line 45):

```ts
    pseudoMeters: 'f32',
    crsUnitsPerDegree: 'vec4<f32>'
```

- [ ] **Step 5: GLSL changes**

In `modules/core/src/shaderlib/project/project.glsl.ts`:

5a. In the `projectUniforms` block, after `bool pseudoMeters;` (line 49), add:

```glsl
  vec4 crsUnitsPerDegree;
```

(Uniform block field order must match `uniformTypes` order — both append at the end.)

5b. In `project_position()`, after the `PROJECTION_MODE_GLOBE` block (closes line 217) and before the `PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET` block, add:

```glsl
  if (project.projectionMode == PROJECTION_MODE_CRS) {
    if (project.coordinateSystem == COORDINATE_SYSTEM_LNGLAT) {
      // Local affine approximation of the CRS projection around the view center.
      // coordinateOrigin is the view center in lnglat; the projected center is
      // re-added in clip space via project.center (offset mode).
      mat2 crsJacobian = mat2(project.crsUnitsPerDegree.xy, project.crsUnitsPerDegree.zw);
      vec2 degreesFromOrigin = position_world.xy - project.coordinateOrigin.xy + position64Low.xy;
      return vec4(
        crsJacobian * degreesFromOrigin,
        project_size(position_world.z),
        position_world.w
      );
    }
    // CARTESIAN falls through to the origin subtraction below
  }
```

5c. Extend the final origin-subtraction condition (lines 231-234) to include CRS mode:

```glsl
  if (project.projectionMode == PROJECTION_MODE_IDENTITY ||
    ((project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET ||
      project.projectionMode == PROJECTION_MODE_CRS) &&
    (project.coordinateSystem == COORDINATE_SYSTEM_LNGLAT ||
     project.coordinateSystem == COORDINATE_SYSTEM_CARTESIAN))) {
```

- [ ] **Step 6: WGSL parity**

In `modules/core/src/shaderlib/project/project.wgsl.ts`:

6a. In `struct ProjectUniforms`, after `pseudoMeters: i32,` (line 59), add:

```wgsl
  crsUnitsPerDegree: vec4<f32>,
```

6b. In `project_position_vec4_f64()`, after the `PROJECTION_MODE_GLOBE` block (closes line 238), add:

```wgsl
  if (project.projectionMode == PROJECTION_MODE_CRS) {
    if (project.coordinateSystem == COORDINATE_SYSTEM_LNGLAT) {
      // Local affine approximation of the CRS projection around the view center.
      let crsJacobian = mat2x2<f32>(project.crsUnitsPerDegree.xy, project.crsUnitsPerDegree.zw);
      let degreesFromOrigin = position_world.xy - project.coordinateOrigin.xy + position64Low.xy;
      return vec4<f32>(
        crsJacobian * degreesFromOrigin,
        project_size_float(position_world.z),
        position_world.w
      );
    }
    // CARTESIAN falls through to the origin subtraction below
  }
```

6c. Extend the final origin-subtraction condition (lines 250-253) the same way as GLSL:

```wgsl
  if (project.projectionMode == PROJECTION_MODE_IDENTITY ||
      ((project.projectionMode == PROJECTION_MODE_WEB_MERCATOR_AUTO_OFFSET ||
        project.projectionMode == PROJECTION_MODE_CRS) &&
       (project.coordinateSystem == COORDINATE_SYSTEM_LNGLAT ||
        project.coordinateSystem == COORDINATE_SYSTEM_CARTESIAN))) {
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run --project node test/modules/core/shaderlib/project/crs-project.spec.ts test/modules/core/shaderlib`
Expected: PASS, including the pre-existing `viewport-uniforms.spec.ts` and `project-glsl.spec.ts` (regression: the new UBO field must not break the GLSL-compiled tests; if `project-glsl.spec` fails on uniform block mismatch, re-check that GLSL field order exactly matches `uniformTypes` order).

- [ ] **Step 8: Headless GPU regression**

Run: `yarn test-headless`
Expected: PASS — the shader edits compile and existing projection modes render identically. (This runs in headless Chromium; takes a few minutes.)

- [ ] **Step 9: Commit**

```bash
git add modules/core/src/shaderlib/project test/modules/core/shaderlib/project/crs-project.spec.ts
git commit -m "feat(core): add PROJECTION_MODE.CRS shader branch with 2x2 jacobian uniform"
```

---

### Task 4: `MapView.crs` prop and public exports

**Files:**
- Modify: `modules/core/src/views/map-view.ts`
- Modify: `modules/core/src/index.ts:41-42,101`
- Test: `test/modules/core/views/map-view-crs.spec.ts`

**Interfaces:**
- Consumes: `CRSViewport`, `CRSViewportOptions` (Task 2), `CRSDefinition` (Task 1).
- Produces:
  - `MapViewProps.crs?: CRSDefinition | 'EPSG:3857' | 'EPSG:4326'`
  - Exports from `@deck.gl/core`: `_CRSViewport` (experimental prefix, matching `_GlobeViewport` convention), types `CRSDefinition`, `CRSTransform`.

- [ ] **Step 1: Write the failing test**

Create `test/modules/core/views/map-view-crs.spec.ts`:

```ts
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport, _CRSViewport as CRSViewport} from '@deck.gl/core';
import {UTM18N} from '../viewports/crs-utils.spec';

const VIEW_STATE = {longitude: -72, latitude: 40, zoom: 10};

test('MapView#without crs makes WebMercatorViewport', () => {
  const view = new MapView({});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(WebMercatorViewport);
});

test('MapView#crs EPSG:3857 makes WebMercatorViewport', () => {
  const view = new MapView({crs: 'EPSG:3857'});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(WebMercatorViewport);
});

test('MapView#crs definition makes CRSViewport', () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(CRSViewport);
  expect((viewport as InstanceType<typeof CRSViewport>).crs.code).toBe('EPSG:32618');
  const [lng, lat] = viewport!.unproject([400, 300]);
  expect(lng).toBeCloseTo(-72, 6);
  expect(lat).toBeCloseTo(40, 6);
});

test('MapView#crs EPSG:4326 makes CRSViewport', () => {
  const view = new MapView({crs: 'EPSG:4326'});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(CRSViewport);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project node test/modules/core/views/map-view-crs.spec.ts`
Expected: FAIL — `_CRSViewport` not exported; `crs` prop not typed/handled.

- [ ] **Step 3: Implement the MapView prop**

In `modules/core/src/views/map-view.ts`:

3a. Add imports after line 7:

```ts
import CRSViewport from '../viewports/crs-viewport';
import type {CRSDefinition} from '../viewports/crs-utils';
```

3b. Add to `MapViewProps` (after the `orthographic` prop, line 52):

```ts
  /** Render the map in a coordinate reference system other than Web Mercator.
   * Accepts a CRSDefinition with an injected transform, or 'EPSG:4326' (built in).
   * Default 'EPSG:3857' (Web Mercator). */
  crs?: CRSDefinition | 'EPSG:3857' | 'EPSG:4326';
```

3c. Replace `getViewportType()` (lines 62-64):

```ts
  getViewportType() {
    const {crs} = this.props;
    if (crs && crs !== 'EPSG:3857') {
      return CRSViewport;
    }
    return WebMercatorViewport;
  }
```

(The `crs` prop reaches the viewport constructor automatically: `View.makeViewport` spreads `this.props` into the viewport options — `view.ts:140`.)

- [ ] **Step 4: Export from @deck.gl/core**

In `modules/core/src/index.ts`:

4a. After `export {default as _GlobeViewport} from './viewports/globe-viewport';` (line 42):

```ts
export {default as _CRSViewport} from './viewports/crs-viewport';
```

4b. Near the type exports (after line 101's MapView types):

```ts
export type {CRSDefinition, CRSTransform} from './viewports/crs-utils';
export type {CRSViewportOptions} from './viewports/crs-viewport';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project node test/modules/core/views/map-view-crs.spec.ts test/modules/core/views`
Expected: PASS, including pre-existing view specs.

- [ ] **Step 6: Full fast suite**

Run: `yarn test-fast`
Expected: PASS (lint + node tests). Fix any lint complaints (unused imports, etc.).

- [ ] **Step 7: Commit**

```bash
git add modules/core/src/views/map-view.ts modules/core/src/index.ts test/modules/core/views/map-view-crs.spec.ts
git commit -m "feat(core): add crs prop to MapView"
```

---

### Task 5: Documentation and upstream RFC

**Files:**
- Modify: `docs/api-reference/core/map-view.md`
- Create: `docs/api-reference/core/crs-viewport.md`
- Create: `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`

**Interfaces:**
- Consumes: final API from Tasks 1–4.
- Produces: user-facing docs; the RFC that accompanies the upstream PR (references visgl/deck.gl#6216).

- [ ] **Step 1: Document the crs prop in map-view.md**

Open `docs/api-reference/core/map-view.md`, find the props section (alongside `repeat`, `orthographic`), and add:

```md
##### `crs` (CRSDefinition | string, optional) {#crs}

Render the map in a coordinate reference system other than Web Mercator. Accepts:

- `'EPSG:3857'` (default): Web Mercator, the standard behavior.
- `'EPSG:4326'`: equirectangular (plate carrée) projection, built in.
- A `CRSDefinition` object for any other projected CRS. deck.gl does not bundle a
  projection library; supply the transform from proj4js or similar:

```js
import proj4 from 'proj4';
import {MapView} from '@deck.gl/core';

const converter = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');

const view = new MapView({
  crs: {
    code: 'EPSG:32618',
    transform: {
      forward: lnglat => converter.forward(lnglat),
      inverse: xy => converter.inverse(xy)
    },
    extent: [166021.44, 0, 833978.56, 9329005.18],
    units: 'meters'
  }
});
```

The view state remains `{longitude, latitude, zoom, bearing, pitch}` regardless of CRS,
so switching CRS is a one-prop change. Layer data in `COORDINATE_SYSTEM.LNGLAT` renders
via a local affine approximation around the view center: exact for EPSG:4326, sub-pixel
at city/survey scales for projected CRSs, degrading only for continental extents in
strongly curved projections. Longitude wrapping (`repeat`) is not supported with a
non-Mercator `crs`.
```

- [ ] **Step 2: Create crs-viewport.md**

Create `docs/api-reference/core/crs-viewport.md` modeled on `web-mercator-viewport.md`'s structure: title `# CRSViewport (Experimental)`, a paragraph on common-space definition (CRS plane offset by extent min, extent width = 512 world units, Mercator-compatible zoom), constructor options table (all `CRSViewportOptions` fields with the JSDoc descriptions from Task 2's code), methods (`project`, `unproject`, `projectFlat`/`unprojectFlat` exactness note, `panByPosition`, `fitBounds`, `getCRSJacobianAtOrigin`), and a "Limitations" section: no repeated worlds; `COORDINATE_SYSTEM.CARTESIAN` positions must be pre-normalized to common space; `METER_OFFSETS` uses diagonal scales (no convergence rotation); out-of-domain data renders at linearized positions.

Then register the page: `grep -rn "web-mercator-viewport" docs/table-of-contents.json website/` and add a `crs-viewport` entry next to `web-mercator-viewport` in the file that lists it (expected: `docs/table-of-contents.json`).

- [ ] **Step 3: Write the RFC**

Create `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`: condense the spec (`docs/superpowers/specs/2026-07-02-crs-mapview-design.md`) into RFC form — Motivation (cite discussion #6216, issue #6217, prior attempts #5607/#6090, draft PR #5504), Proposal (the `crs` prop, `CRSViewport`, `PROJECTION_MODE.CRS`, injected-transform/no-dependency policy, Jacobian linearization with error characteristics), Alternatives considered (shader-side fixed 4326 mode; CPU attribute reprojection), Future work (Phase 2 OGC TileMatrixSet tile indexing, Phase 3 GPU raster reprojection, opt-in exact CPU reprojection). Follow the header format of an existing file in `dev-docs/RFCs/proposals/`.

- [ ] **Step 4: Commit**

```bash
git add docs/api-reference/core docs/table-of-contents.json dev-docs/RFCs/proposals/crs-projection-mode-rfc.md
git commit -m "docs(core): document MapView crs prop, CRSViewport, and CRS RFC"
```

---

### Task 6: Visual verification app

A manual test app proving the two acceptance scenarios end to end on a live GPU: (1) data in a UTM view with pan/zoom/rotate/pitch, (2) an EPSG:4326 view. This is the Phase 1 acceptance check; golden-image render tests are added during upstream PR prep (follow-up, noted in the RFC).

**Files:**
- Create: `test/apps/crs-viewport/package.json`
- Create: `test/apps/crs-viewport/index.html`
- Create: `test/apps/crs-viewport/app.jsx`

**Interfaces:**
- Consumes: `MapView` with `crs` prop, `CRSDefinition` (public API from Task 4).
- Produces: nothing downstream — human verification tool.

- [ ] **Step 1: Create the app**

`test/apps/crs-viewport/package.json`:

```json
{
  "scripts": {
    "start": "vite --open",
    "start-local": "vite --config ../vite.config.local.mjs"
  },
  "dependencies": {
    "deck.gl": "^9.3.0",
    "proj4": "^2.11.0",
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "vite": "^7.3.1"
  }
}
```

`test/apps/crs-viewport/index.html`:

```html
<!doctype html>
<html>
  <head>
    <title>CRSViewport test</title>
    <style>
      body {margin: 0; font-family: sans-serif;}
      #controls {position: absolute; top: 10px; left: 10px; z-index: 1; background: white; padding: 8px;}
    </style>
  </head>
  <body>
    <div id="controls"></div>
    <div id="app"></div>
    <script type="module" src="app.jsx"></script>
  </body>
</html>
```

`test/apps/crs-viewport/app.jsx`:

```jsx
// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global document */
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import DeckGL from '@deck.gl/react';
import {MapView} from '@deck.gl/core';
import {GeoJsonLayer, PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import proj4 from 'proj4';

const utm18n = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');

const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18n.forward(lnglat),
    inverse: xy => utm18n.inverse(xy)
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

const CRS_OPTIONS = {
  'Web Mercator': 'EPSG:3857',
  'EPSG:4326': 'EPSG:4326',
  'UTM 18N': UTM18N
};

// Graticule: a lnglat grid to make projection distortion visible
function makeGraticule() {
  const paths = [];
  for (let lng = -80; lng <= -66; lng += 1) {
    paths.push({path: Array.from({length: 41}, (_, i) => [lng, 35 + i * 0.25])});
  }
  for (let lat = 35; lat <= 45; lat += 1) {
    paths.push({path: Array.from({length: 57}, (_, i) => [-80 + i * 0.25, lat])});
  }
  return paths;
}

const INITIAL_VIEW_STATE = {longitude: -72, latitude: 40, zoom: 7, pitch: 0, bearing: 0};

const CONTROLS_STYLE = {
  position: 'absolute',
  top: 10,
  left: 10,
  zIndex: 1,
  background: 'white',
  padding: 8
};

function App() {
  const [crsName, setCrsName] = useState('UTM 18N');

  const layers = [
    new GeoJsonLayer({
      id: 'states',
      data: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/us-states.json',
      stroked: true,
      filled: true,
      getFillColor: [60, 120, 180, 60],
      getLineColor: [60, 120, 180, 255],
      lineWidthMinPixels: 1
    }),
    new PathLayer({
      id: 'graticule',
      data: makeGraticule(),
      getPath: d => d.path,
      getColor: [140, 140, 140, 160],
      widthMinPixels: 1
    }),
    new ScatterplotLayer({
      id: 'anchors',
      data: [
        {position: [-72, 40]},
        {position: [-75, 40]}
      ],
      getPosition: d => d.position,
      getFillColor: [220, 60, 60],
      radiusMinPixels: 6
    })
  ];

  return (
    <>
      <div style={CONTROLS_STYLE}>
        {Object.keys(CRS_OPTIONS).map(name => (
          <button
            key={name}
            onClick={() => setCrsName(name)}
            style={{fontWeight: name === crsName ? 'bold' : 'normal'}}
          >
            {name}
          </button>
        ))}
      </div>
      <DeckGL
        views={new MapView({crs: CRS_OPTIONS[crsName]})}
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        getTooltip={({coordinate}) =>
          coordinate && `${coordinate[0].toFixed(5)}, ${coordinate[1].toFixed(5)}`
        }
      />
    </>
  );
}

createRoot(document.getElementById('app')).render(<App />);
```

And drop the `#controls` div from `index.html` (the toolbar is rendered by React inside `#app`); keep only `<div id="app"></div>` and the `<style>` block.

- [ ] **Step 2: Run and verify**

```bash
cd test/apps/crs-viewport && yarn && yarn start-local
```

(`start-local` aliases `deck.gl` imports to the local `modules/*/src`.) Verify in the browser:
1. **UTM 18N**: state borders and graticule render; graticule meridians converge (not parallel-vertical as in Mercator); pan/zoom-to-cursor/rotate/pitch all feel like normal MapView; tooltip lnglat under the cursor matches the anchor points exactly (CPU picking path is exact).
2. **EPSG:4326**: lat/lng grid is perfectly square-linear; no distortion of the graticule spacing in y (unlike Mercator).
3. **Web Mercator**: unchanged behavior (regression check).
4. Toggle between CRSs: view stays centered on the same lng/lat.

- [ ] **Step 3: Full suite and final commit**

```bash
yarn test
```

Expected: PASS (node + headless + render projects — render goldens unchanged because default behavior is untouched).

```bash
git add test/apps/crs-viewport
git commit -m "test(core): add CRS viewport manual test app"
```

---

## Follow-ups (out of scope for this plan)

- **Phase 2:** OGC TileMatrixSet tile indexing in `@deck.gl/geo-layers` (own spec/plan).
- **Phase 3:** GPU warping of Web-Mercator raster sources (own spec/plan).
- Golden-image render tests for CRS scenes — add during upstream PR preparation.
- Fathom integration: consume the fork build, wire `projection-utils.ts` into a `CRSDefinition`, replace the `useReprojectedView` path.
- Upstream PR to visgl/deck.gl referencing discussion #6216 with the RFC from Task 5.
