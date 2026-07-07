// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {Proj4Projection} from '@math.gl/proj4';
import {log} from '@deck.gl/core';
import {
  normalizeCRS,
  lngLatToCommon,
  commonToLngLat,
  getCRSJacobian,
  getCRSMetersJacobian,
  getCRSHessian,
  getCRSDistanceScales,
  getCRSConvergence,
  clampLngLatToCRSExtent,
  CRS_WORLD_SIZE
} from '@deck.gl/core/viewports/crs-utils';
import type {CRSDefinition} from '@deck.gl/core/viewports/crs-utils';
import {UTM18N} from './crs-fixtures';

function makeCRS(
  code: string,
  projString: string,
  extent: [number, number, number, number]
): CRSDefinition {
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

test('normalizeCRS#extentGeographic derives the UTM 18N projected extent', () => {
  // -78/-72 is the WGS84 lon extent of UTM zone 18; 0/84 is the equator-to-UTM's-northern-limit
  // lat extent. Densifying the boundary and forward-projecting should land close to (but not
  // necessarily exactly on, since edges are densified straight lines vs a truly curved
  // boundary) the known projected bounds for this zone.
  const {extent: _extent, ...definitionWithoutExtent} = UTM18N;
  const crs = normalizeCRS({
    ...definitionWithoutExtent,
    extentGeographic: [-78, 0, -72, 84]
  });
  const known = [166021.44, 0, 833978.56, 9329005.18];
  const widthX = known[2] - known[0];
  const widthY = known[3] - known[1];
  expect(Math.abs(crs.extent[0] - known[0])).toBeLessThan(widthX * 0.01);
  expect(Math.abs(crs.extent[1] - known[1])).toBeLessThan(widthY * 0.01);
  expect(Math.abs(crs.extent[2] - known[2])).toBeLessThan(widthX * 0.01);
  expect(Math.abs(crs.extent[3] - known[3])).toBeLessThan(widthY * 0.01);
});

test('normalizeCRS#extentGeographic tolerates a forward that NaNs on part of the boundary', () => {
  // A synthetic CRS whose forward is undefined above lat 60 (simulating a projection that's
  // singular past some parallel, e.g. near a pole). The entire north edge (lat 70) and the
  // last sample of the east/west edges are non-finite; the remaining >= 4 finite samples
  // must still be enough to succeed, and the derived extent must reflect only those.
  const partialCRS: CRSDefinition = {
    code: 'TEST:PARTIAL',
    transform: {
      forward: ([lng, lat]) => (lat > 60 ? [NaN, NaN] : [lng * 1000, lat * 1000]),
      inverse: ([x, y]) => [x / 1000, y / 1000]
    },
    extentGeographic: [-10, 0, 10, 70],
    units: 'meters'
  };
  const crs = normalizeCRS(partialCRS);
  expect(crs.extent).toEqual([-10000, 0, 10000, 60000]);
});

// Hardening (review item 6c): `densifyGeographicBoundary` interpolated `lng = west + t * (east
// - west)` unconditionally -- for an antimeridian-crossing bbox (`west > east`, e.g. `[170, ...,
// -170, ...]`, meaning "the 20-degree-wide strip around +/-180", NOT the ~340-degree strip the
// other way around) this interpolates the LONG way through longitude 0 instead of the short way
// through +/-180. Using a `forward` that is finite EVERYWHERE (`[lng * 1000, lat * 1000]`, no
// domain restriction, so `normalizeCRS`'s own round-trip validation is unaffected regardless of
// where the derived extent's center lands) still makes this observable via the derived extent's
// span: a west/east-edge-only bbox tops out at +/-170000 (`west`/`east` themselves); reaching
// all the way to +/-180000 requires a top/bottom-edge sample that actually swept through the
// antimeridian (up to +180, wrapping to -180 and on to -170) -- the wrong-direction (through-0)
// interpolation never produces a sample outside [-170, 170] and so never exceeds +/-170000.
test('normalizeCRS#extentGeographic handles an antimeridian-crossing bbox (west > east) by interpolating through +/-180, not through 0', () => {
  const antimeridianCRS: CRSDefinition = {
    code: 'TEST:ANTIMERIDIAN',
    transform: {
      forward: ([lng, lat]) => [lng * 1000, lat * 1000],
      inverse: ([x, y]) => [x / 1000, y / 1000]
    },
    // west (170) > east (-170): the 20-degree-wide strip straddling the antimeridian.
    extentGeographic: [170, -1, -170, 1],
    units: 'meters'
  };
  const crs = normalizeCRS(antimeridianCRS);
  expect(crs.extent[0]).toBeLessThan(-175000);
  expect(crs.extent[2]).toBeGreaterThan(175000);
});

test('normalizeCRS#extentGeographic throws on a degenerate derived extent', () => {
  const degenerateCRS: CRSDefinition = {
    code: 'TEST:DEGENERATE',
    transform: {
      forward: ([lng, lat]) => [lng * 1000, lat * 1000],
      inverse: ([x, y]) => [x / 1000, y / 1000]
    },
    // west === east: every boundary sample has the same x, so the derived extent is
    // degenerate in X regardless of the y span
    extentGeographic: [5, 10, 5, 50],
    units: 'meters'
  };
  expect(() => normalizeCRS(degenerateCRS)).toThrow(/degenerate/);
});

test('normalizeCRS#extent takes precedence when both extent and extentGeographic are given', () => {
  const crs = normalizeCRS({
    ...UTM18N,
    extentGeographic: [999, 999, 999.1, 999.1] // would throw if it were used
  });
  expect(crs.extent).toEqual(UTM18N.extent);
});

test('normalizeCRS#neither extent nor extentGeographic throws', () => {
  const {extent: _extent, ...definitionWithoutExtent} = UTM18N;
  expect(() => normalizeCRS(definitionWithoutExtent)).toThrow(/extent/);
});

// --- normalizeCRS identity memoization --------------------------------------------------
//
// CRSViewport's constructor calls normalizeCRS(opts.crs) on every construction, and
// ViewManager rebuilds viewports on every viewState change - so an app that memoizes its
// own CRSDefinition object (per docs guidance) still got a BRAND NEW NormalizedCRS every
// frame, resetting the WeakMap-keyed Jacobian/Hessian/background-feature caches downstream.
// normalizeCRS is now memoized at the source: same input object/code -> same output
// reference, so those downstream caches persist across viewport reconstructions.

test('normalizeCRS#same crs object passed twice returns the same NormalizedCRS reference', () => {
  const first = normalizeCRS(UTM18N);
  const second = normalizeCRS(UTM18N);
  expect(second).toBe(first);
});

test('normalizeCRS#two distinct object literals with identical contents (even identical code) return different NormalizedCRS references', () => {
  const a: CRSDefinition = {...UTM18N};
  const b: CRSDefinition = {...UTM18N};
  const normA = normalizeCRS(a);
  const normB = normalizeCRS(b);
  expect(normB).not.toBe(normA);
  // Still numerically/structurally equal - a cache miss, not a behavior change.
  expect(normB).toEqual(normA);
});

test('normalizeCRS#EPSG:4326 string code returns the same NormalizedCRS reference across calls', () => {
  const first = normalizeCRS('EPSG:4326');
  const second = normalizeCRS('EPSG:4326');
  expect(second).toBe(first);
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
  const convergence = Math.abs((Math.atan2(jacobian[1], jacobian[0]) * 180) / Math.PI);
  expect(convergence).toBeGreaterThan(1.8);
  expect(convergence).toBeLessThan(2.1);
  // On the central meridian there is no convergence
  const jacobianCM = getCRSJacobian(crs, [-75, 40]);
  expect(Math.abs(jacobianCM[1] / jacobianCM[0])).toBeLessThan(1e-4);
});

test('getCRSMetersJacobian#UTM grid convergence at (-72, 40)', () => {
  // Same known-answer point as 'getCRSJacobian#UTM grid convergence': 3 degrees east
  // of the central meridian (-75) at latitude 40. gamma = atan(tan(dLng) * sin(lat))
  // ~ 1.93 degrees. Converting the Jacobian to a per-meter basis (chain rule) must not
  // change the convergence angle (a ratio of the two column components) or the general
  // magnitude of the scale factor (~0.9996, the UTM central scale factor, modulo the
  // secant-projection scale variation away from the central meridian).
  const crs = normalizeCRS(UTM18N);
  const jacobian = getCRSMetersJacobian(crs, [-72, 40]);
  const convergence = Math.abs((Math.atan2(jacobian[1], jacobian[0]) * 180) / Math.PI);
  expect(convergence).toBeGreaterThan(1.8);
  expect(convergence).toBeLessThan(2.1);

  // Scale: common units per meter east/north should each be close to the CRS's
  // commonUnitsPerCRSUnit (1 CRS unit === 1 meter for UTM), modulo the ~0.9996 UTM
  // central scale factor (which grows slightly away from the central meridian) and a
  // systematic ~0.25% bias from getCRSMetersJacobian's spherical-Earth degrees-per-meter
  // conversion (METERS_PER_DEGREE, a mean-circumference constant) versus proj4's
  // WGS84-ellipsoid longitude scale at this latitude - both expected, not a bug.
  const commonUnitsPerMeterEast = Math.hypot(jacobian[0], jacobian[1]);
  const commonUnitsPerMeterNorth = Math.hypot(jacobian[2], jacobian[3]);
  expect(commonUnitsPerMeterEast / crs.commonUnitsPerCRSUnit).toBeGreaterThan(0.995);
  expect(commonUnitsPerMeterEast / crs.commonUnitsPerCRSUnit).toBeLessThan(1.01);
  expect(commonUnitsPerMeterNorth / crs.commonUnitsPerCRSUnit).toBeGreaterThan(0.995);
  expect(commonUnitsPerMeterNorth / crs.commonUnitsPerCRSUnit).toBeLessThan(1.01);

  // On the central meridian there is no convergence
  const jacobianCM = getCRSMetersJacobian(crs, [-75, 40]);
  expect(Math.abs(jacobianCM[1] / jacobianCM[0])).toBeLessThan(1e-4);
});

test('getCRSMetersJacobian#EPSG:4326 is diagonal-only (rotation-free)', () => {
  // EPSG:4326 (plate carrée) has no grid convergence anywhere: 1 meter east/north maps
  // straight along the common-space x/y axes, with no off-diagonal (rotation) term.
  const crs = normalizeCRS('EPSG:4326');
  for (const lnglat of [
    [0, 0],
    [30, 45],
    [-120, -33.5]
  ]) {
    const jacobian = getCRSMetersJacobian(crs, lnglat);
    expect(jacobian[1]).toBeCloseTo(0, 9);
    expect(jacobian[2]).toBeCloseTo(0, 9);
    expect(jacobian[0]).toBeGreaterThan(0);
    expect(jacobian[3]).toBeGreaterThan(0);
  }
});

test('getCRSHessian#EPSG:4326 is exactly zero', () => {
  const crs = normalizeCRS('EPSG:4326');
  for (const lnglat of [
    [0, 0],
    [30, 45],
    [-120, -33.5]
  ]) {
    // EPSG:4326's transform is exactly linear (identity), so the true second
    // derivative is zero; central finite differences leave only floating-point
    // rounding noise (~1e-9), many orders of magnitude below any real curvature.
    const hessian = getCRSHessian(crs, lnglat);
    for (const coefficient of [...hessian.x, ...hessian.y]) {
      expect(coefficient).toBeCloseTo(0, 8);
    }
  }
});

test('getCRSHessian#UTM second-order correction reduces error by >20x within 5 degrees', () => {
  // Validates both the FD step-size choice (HESSIAN_STEP = 5e-3 degrees) and the
  // shader's `commonXY + dot(crsUnitsPerDegree2{X,Y}, quadratic)` formula: reproduces
  // it here in plain JS from getCRSJacobian/getCRSHessian, independent of the shader
  // source (see crs-project.node.spec.ts for the shader-uniform-level version).
  const crs = normalizeCRS(UTM18N);
  const center: [number, number] = [-72.5, 41];
  const centerCommon = lngLatToCommon(crs, center);
  const jacobian = getCRSJacobian(crs, center);
  const hessian = getCRSHessian(crs, center);

  // Deltas up to ~5 degrees from center, in varied directions, including axis-aligned.
  // At the center (2.5° east of the central meridian), axis-aligned deltas like [0, 5]
  // have first-order error ~808 m and pass both relative and absolute bounds.
  const deltas: Array<[number, number]> = [
    [1, 1],
    [2, -1.5],
    [-3, 2],
    [4, 3],
    [-5, -4],
    [5, 4.5],
    [-4.5, 4.8],
    [0, 5],
    [5, 0]
  ];

  for (const [dLng, dLat] of deltas) {
    const target: [number, number] = [center[0] + dLng, center[1] + dLat];
    const exact = lngLatToCommon(crs, target);

    const firstOrder = [
      centerCommon[0] + jacobian[0] * dLng + jacobian[2] * dLat,
      centerCommon[1] + jacobian[1] * dLng + jacobian[3] * dLat
    ];
    const quad = [0.5 * dLng * dLng, dLng * dLat, 0.5 * dLat * dLat];
    const secondOrder = [
      firstOrder[0] + hessian.x[0] * quad[0] + hessian.x[1] * quad[1] + hessian.x[2] * quad[2],
      firstOrder[1] + hessian.y[0] * quad[0] + hessian.y[1] * quad[1] + hessian.y[2] * quad[2]
    ];

    const errFirst = Math.hypot(firstOrder[0] - exact[0], firstOrder[1] - exact[1]);
    const errSecond = Math.hypot(secondOrder[0] - exact[0], secondOrder[1] - exact[1]);

    expect(errSecond).toBeLessThan(0.05 * errFirst);
    // Absolute bound: ~1.5 common units (~2km, since 1 common unit ~= 1304m for this
    // CRS's extent) covers the largest observed residual (~1.07) with margin.
    expect(errSecond).toBeLessThan(1.5);
  }
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

test('getCRSHessian#NaN fallback returns zero coefficients', () => {
  // Mock CRS with domain restrictions: transform returns [NaN, NaN] outside
  // a small box around the origin, testing the graceful degradation.
  const restrictedCRS: CRSDefinition = {
    code: 'TEST_RESTRICTED',
    transform: {
      forward: ([lng, lat]) => {
        // Valid only in a small box around [0, 0]
        if (Math.abs(lng) < 0.01 && Math.abs(lat) < 0.01) {
          return [lng * 111000, lat * 111000]; // rough meters
        }
        return [NaN, NaN];
      },
      inverse: ([x, y]) => [x / 111000, y / 111000]
    },
    extent: [-1000000, -1000000, 1000000, 1000000],
    units: 'meters'
  };

  const crs = normalizeCRS(restrictedCRS);
  // Call getCRSHessian at a point near the domain boundary: most FD samples will be NaN.
  const hessian = getCRSHessian(crs, [0.02, 0]);
  // Verify it returned zero coefficients (graceful fallback)
  expect(hessian.x).toEqual([0, 0, 0]);
  expect(hessian.y).toEqual([0, 0, 0]);
});

test('getCRSConvergence#UTM 18N known answer at (-72, 40)', () => {
  // 3 degrees east of the central meridian (-75) at latitude 40 in the Northern
  // Hemisphere: gamma ~ Delta-lng * sin(lat) ~ 3 * sin(40deg) ~ 1.93deg. Per this
  // module's documented sign convention (True Azimuth = Grid Azimuth + gamma; positive
  // means grid north is clockwise/east of true north), gamma is positive here - the
  // surveying-standard sign for a point east of the central meridian in the Northern
  // Hemisphere (NGS: "convergence is positive East of the Central Meridian").
  const crs = normalizeCRS(UTM18N);
  const convergence = getCRSConvergence(crs, [-72, 40]);
  expect(convergence).toBeGreaterThan(1.8);
  expect(convergence).toBeLessThan(2.1);
});

test('getCRSConvergence#UTM 18N central meridian is ~0', () => {
  const crs = normalizeCRS(UTM18N);
  const convergence = getCRSConvergence(crs, [-75, 40]);
  expect(convergence).toBeCloseTo(0, 3);
});

test('getCRSConvergence#EPSG:4326 is exactly zero everywhere', () => {
  const crs = normalizeCRS('EPSG:4326');
  for (const lnglat of [
    [0, 0],
    [30, 45],
    [-120, -33.5],
    [175, -60]
  ]) {
    expect(getCRSConvergence(crs, lnglat)).toBeCloseTo(0, 9);
  }
});

test('getCRSConvergence#southern hemisphere flips the sign relative to the same point mirrored north', () => {
  // Same 3deg-east-of-CM offset, but south of the equator: the sign of
  // Delta-lng * sin(lat) flips because sin(lat) is negative, so gamma becomes negative -
  // grid north is now counterclockwise (west) of true north instead of clockwise (east).
  const crs = normalizeCRS(UTM18N);
  const north = getCRSConvergence(crs, [-72, 40]);
  const south = getCRSConvergence(crs, [-72, -40]);
  expect(north).toBeGreaterThan(0);
  expect(south).toBeLessThan(0);
  expect(south).toBeCloseTo(-north, 6);
});

test('getCRSConvergence#west of the central meridian is negative', () => {
  const crs = normalizeCRS(UTM18N);
  const convergence = getCRSConvergence(crs, [-78, 40]);
  expect(convergence).toBeLessThan(0);
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

// --- Per-(crs, origin) memoization -----------------------------------------------------
//
// getCRSJacobian/getCRSHessian/getCRSMetersJacobian are pure functions of (crs, origin) -
// independent of zoom/pan/viewMatrix - but are invoked once per sublayer origin, every
// frame (viewport-uniforms.ts's getUniformsFromViewport). A controlled GPU measurement
// found these finite-difference implementations (each calling crs.transform.forward
// several times, backed by real proj-wasm) dominating per-frame CPU cost during a native-
// CRS zoom sweep. They are now memoized per (crs identity, origin); these tests assert a
// cache hit is bit-identical to a fresh call, that distinct (crs, origin) keys don't
// collide, and that transform.forward is actually invoked only once per distinct origin.

/** Wraps a CRSDefinition's transform so every call to forward/inverse is counted,
 * without changing its numerical behavior. */
function countingCRS(base: CRSDefinition): {crs: CRSDefinition; counts: {forward: number}} {
  const counts = {forward: 0};
  const crs: CRSDefinition = {
    ...base,
    transform: {
      forward: (lnglat: [number, number]) => {
        counts.forward++;
        return base.transform.forward(lnglat);
      },
      inverse: base.transform.inverse
    }
  };
  return {crs, counts};
}

test('getCRSJacobian#memoization: cache hit is bit-identical to a fresh call', () => {
  const crs = normalizeCRS(UTM18N);
  const origin = [-72.4321, 40.1234];
  const first = getCRSJacobian(crs, origin);
  const second = getCRSJacobian(crs, origin);
  expect(second).toEqual(first);
  // normalizeCRS is itself memoized on the input object's identity (see the
  // "normalizeCRS identity memoization" tests above), so calling it again with the exact
  // same UTM18N object reference returns the SAME NormalizedCRS object, not a fresh one -
  // this is the same crs's Jacobian cache entry, so the result is === (not just ==) equal.
  const crsAgain = normalizeCRS(UTM18N);
  expect(crsAgain).toBe(crs);
  const third = getCRSJacobian(crsAgain, origin);
  expect(third).toBe(first);
});

test('getCRSHessian#memoization: cache hit is bit-identical to a fresh call', () => {
  const crs = normalizeCRS(UTM18N);
  const origin = [-72.4321, 40.1234];
  const first = getCRSHessian(crs, origin);
  const second = getCRSHessian(crs, origin);
  expect(second).toEqual(first);
});

test('getCRSMetersJacobian#memoization: cache hit is bit-identical to a fresh call', () => {
  const crs = normalizeCRS(UTM18N);
  const origin = [-72.4321, 40.1234];
  const first = getCRSMetersJacobian(crs, origin);
  const second = getCRSMetersJacobian(crs, origin);
  expect(second).toEqual(first);
});

test('getCRSJacobian#memoization: a different origin misses the cache and yields a different result', () => {
  const crs = normalizeCRS(UTM18N);
  const a = getCRSJacobian(crs, [-72, 40]);
  const b = getCRSJacobian(crs, [-72, 41]);
  expect(b).not.toEqual(a);
});

test('getCRSJacobian#memoization: a different crs object (same code) does not share cached values', () => {
  // Two independently-constructed CRSDefinitions that happen to share a `code`: caching
  // keyed on crs.code alone would incorrectly conflate them. Keying on the NormalizedCRS
  // object identity (WeakMap) must keep them distinct.
  const {crs: crsA, counts: countsA} = countingCRS({...UTM18N, code: 'SAME:CODE'});
  const {crs: crsB, counts: countsB} = countingCRS({...UTM18N, code: 'SAME:CODE'});
  const normA = normalizeCRS(crsA);
  const normB = normalizeCRS(crsB);
  // normalizeCRS itself calls transform.forward/inverse once to validate round-tripping;
  // reset the counters so this test only measures the Jacobian's own calls.
  countsA.forward = 0;
  countsB.forward = 0;

  const origin = [-72, 40];
  getCRSJacobian(normA, origin);
  expect(countsA.forward).toBeGreaterThan(0);
  const callsAfterFirstCRS = countsA.forward;

  // A different crs object, same origin, same code: must still invoke the transform -
  // it must NOT be treated as a cache hit against normA's entry.
  getCRSJacobian(normB, origin);
  expect(countsB.forward).toBeGreaterThan(0);
  // And normA's own cache for this origin must remain untouched by normB's computation.
  getCRSJacobian(normA, origin);
  expect(countsA.forward).toBe(callsAfterFirstCRS);
});

test('getCRSJacobian#memoization: repeated calls with the same (crs, origin) invoke transform.forward only once', () => {
  const {crs: baseCRS, counts} = countingCRS(UTM18N);
  const crs = normalizeCRS(baseCRS);
  counts.forward = 0; // exclude normalizeCRS's own round-trip validation call

  const origin = [-72.1, 40.2];
  getCRSJacobian(crs, origin);
  const callsAfterFirst = counts.forward;
  expect(callsAfterFirst).toBeGreaterThan(0);

  // Simulate many frames * many sublayers re-requesting the uniform at the same origin:
  // this must not invoke the proj transform again.
  for (let i = 0; i < 500; i++) {
    getCRSJacobian(crs, origin);
  }
  expect(counts.forward).toBe(callsAfterFirst);
});

test('getCRSHessian#memoization: repeated calls with the same (crs, origin) invoke transform.forward only once', () => {
  const {crs: baseCRS, counts} = countingCRS(UTM18N);
  const crs = normalizeCRS(baseCRS);
  counts.forward = 0;

  const origin = [-72.1, 40.2];
  getCRSHessian(crs, origin);
  const callsAfterFirst = counts.forward;
  expect(callsAfterFirst).toBeGreaterThan(0);

  for (let i = 0; i < 500; i++) {
    getCRSHessian(crs, origin);
  }
  expect(counts.forward).toBe(callsAfterFirst);
});

test('getCRSJacobian/getCRSHessian/getCRSMetersJacobian#memoization: many distinct origins stay bounded (LRU eviction)', () => {
  // Exercise the cache with more distinct origins than MAX_ORIGIN_CACHE_ENTRIES_PER_CRS
  // (1024) would hold, simulating a long pan/zoom session. This must not throw, hang, or
  // grow without bound (no direct way to assert cache size from outside the module - this
  // is a smoke test that eviction doesn't break correctness for the most-recently-used
  // entries, which is all that matters for the hot path).
  const crs = normalizeCRS(UTM18N);
  for (let i = 0; i < 2000; i++) {
    const origin = [-75 + (i % 200) * 0.01, (i % 50) * 0.1];
    getCRSJacobian(crs, origin);
    getCRSHessian(crs, origin);
    getCRSMetersJacobian(crs, origin);
  }
  // The most recently used origin must still be a correct, finite result.
  const lastOrigin = [-75 + (1999 % 200) * 0.01, (1999 % 50) * 0.1];
  const jacobian = getCRSJacobian(crs, lastOrigin);
  expect(jacobian.every(Number.isFinite)).toBe(true);
});

// Hardening (review item 6a): `clampLngLatToCRSExtent` clamps the FORWARD-projected xy into
// `crs.extent`, then calls `transform.inverse` once on the clamped xy and returns it directly --
// with no check that the inverse itself succeeded. A CRS whose `inverse` is only well-defined
// near the extent center (plausible for a projection singular/undefined at its own edges) could
// return a non-finite lnglat for an out-of-domain input, silently propagating NaN into the
// caller (e.g. `CRSViewport`'s own view-center clamp, which relies on this never returning
// non-finite). Falls back to `transform.inverse` of the extent center, which `normalizeCRS`
// already validates is always finite.
test('clampLngLatToCRSExtent#a non-finite inverse() at the clamped position falls back to the inverse of the extent center', () => {
  const restrictedInverseCRS: CRSDefinition = {
    code: 'TEST:INVERSE_RESTRICTED',
    transform: {
      forward: ([lng, lat]) => [lng * 1000, lat * 1000],
      inverse: ([x, y]) =>
        Math.abs(x) > 5000 || Math.abs(y) > 5000 ? [NaN, NaN] : [x / 1000, y / 1000]
    },
    extent: [-10000, -10000, 10000, 10000],
    units: 'meters'
  };
  const crs = normalizeCRS(restrictedInverseCRS);

  // forward([50, 50]) = [50000, 50000], clamped into the extent to [10000, 10000] -- outside
  // the inverse's [-5000, 5000] domain, so `transform.inverse([10000, 10000])` is [NaN, NaN].
  const result = clampLngLatToCRSExtent(crs, [50, 50]);
  expect(Number.isFinite(result[0])).toBe(true);
  expect(Number.isFinite(result[1])).toBe(true);
  // The extent center is [0, 0] in xy -> inverse([0, 0]) = [0, 0] in lnglat.
  expect(result[0]).toBeCloseTo(0, 6);
  expect(result[1]).toBeCloseTo(0, 6);
});

// Hardening (review item 6b): `getCRSMetersJacobian` divides by `cos(lat)` to convert a
// degrees-based Jacobian to a meters-based one -- uncapped, `cos(lat)` approaches 0 (and the
// division blows up) as `|lat|` approaches 90, mirroring the exact failure mode
// `map-controller.ts`'s own `lngLatToWorld` already guards against for a different computation
// (see its `Math.abs(lat) > 90` clamp). Clamping `|lat|` to <= 89.9 before `cos()` keeps the
// result bounded near the poles instead of diverging.
test('getCRSMetersJacobian#clamps |lat| to <=89.9 before cos(), stays bounded near the poles', () => {
  const identityCRS: CRSDefinition = {
    code: 'TEST:IDENTITY',
    transform: {
      forward: ([lng, lat]) => [lng, lat],
      inverse: ([x, y]) => [x, y]
    },
    extent: [-180, -90, 180, 90],
    units: 'degrees'
  };
  const crs = normalizeCRS(identityCRS);
  const jacobian = getCRSMetersJacobian(crs, [-75, 90]);
  expect(jacobian.every(Number.isFinite)).toBe(true);
  // Without the clamp, `cos(90deg)` (~6e-17 in double precision, not exactly 0) drives the
  // "east" column past 1e10; with the clamp (cos(89.9deg) ~ 0.001745), it stays of order
  // 1e-2 to 1e0 -- well under this bound either way for this identity CRS.
  expect(Math.max(...jacobian.map(Math.abs))).toBeLessThan(1);
});

// Hardening (review item 6d): `deriveExtentFromGeographic` already throws when fewer than 4 of
// the densified boundary samples are finite (the CRS's domain clearly doesn't cover the
// requested bbox at all), but silently proceeds with NO diagnostic whenever MOST (but not all)
// samples are non-finite -- e.g. a bbox that only marginally overlaps the CRS's actual domain,
// producing an extent extrapolated from a small, possibly unrepresentative minority of the
// requested boundary. Keeps the existing permissive behavior (still succeeds), but warns,
// naming the CRS and the finite fraction, when finiteCount is below half the samples.
test('normalizeCRS#extentGeographic warns (but still succeeds) when fewer than half the boundary samples are finite', () => {
  const mostlyRestrictedCRS: CRSDefinition = {
    code: 'TEST:MOSTLY_RESTRICTED',
    transform: {
      forward: ([lng, lat]) => (lat <= 5 ? [lng * 1000, lat * 1000] : [NaN, NaN]),
      inverse: ([x, y]) => [x / 1000, y / 1000]
    },
    // south=-10 (finite, below the lat<=5 threshold), north=90 (always non-finite); the
    // left/right edges sweep lat from -10 to 90, finite only for their first ~15% (see the
    // finiteCount arithmetic in this test's comment below).
    extentGeographic: [-10, -10, 10, 90],
    units: 'meters'
  };
  const warnSpy = vi.spyOn(log, 'warn');
  try {
    // 32 total boundary samples (EXTENT_GEOGRAPHIC_SAMPLES=8 per edge x 4 edges): the north
    // (lat=90) edge is entirely non-finite (8), the south (lat=-10) edge is entirely finite
    // (8), and each of the east/west edges (lat sweeping -10..90) is finite only for its first
    // 2 samples (lat <= 5) -- 12 finite of 32 total, well under half.
    const crs = normalizeCRS(mostlyRestrictedCRS);
    expect(Number.isFinite(crs.extent[0] + crs.extent[1] + crs.extent[2] + crs.extent[3])).toBe(
      true
    );
    expect(warnSpy).toHaveBeenCalled();
    const warnedMessage = warnSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(warnedMessage).toContain('TEST:MOSTLY_RESTRICTED');
  } finally {
    warnSpy.mockRestore();
  }
});

// A CRS whose domain genuinely covers most of the requested bbox must NOT warn -- only the
// below-half-finite case should.
test('normalizeCRS#extentGeographic does not warn when most boundary samples are finite', () => {
  const warnSpy = vi.spyOn(log, 'warn');
  try {
    normalizeCRS({
      code: 'TEST:MOSTLY_FINITE',
      transform: {
        forward: ([lng, lat]) => [lng * 1000, lat * 1000],
        inverse: ([x, y]) => [x / 1000, y / 1000]
      },
      extentGeographic: [-10, -10, 10, 10],
      units: 'meters'
    });
    expect(warnSpy).not.toHaveBeenCalled();
  } finally {
    warnSpy.mockRestore();
  }
});
