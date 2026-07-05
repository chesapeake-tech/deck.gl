// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {PROJECTION_MODE} from '@deck.gl/core/lib/constants';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import {getUniformsFromViewport} from '@deck.gl/core/shaderlib/project/viewport-uniforms';
import {UTM18N} from '../../viewports/crs-fixtures';

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
  // Quadratic (Hessian) uniforms are populated from the same origin
  const hessian = viewport.getCRSHessianAtOrigin([-72, 40]);
  expect(uniforms.crsUnitsPerDegree2X).toEqual([hessian.x[0], hessian.x[1], hessian.x[2], 0]);
  expect(uniforms.crsUnitsPerDegree2Y).toEqual([hessian.y[0], hessian.y[1], hessian.y[2], 0]);
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
  // Quadratic uniforms default to zero for every non-CRS projection mode - a
  // structural no-op, since `dot(zero, quadratic) == 0` in the shader.
  expect(uniforms.crsUnitsPerDegree2X).toEqual([0, 0, 0, 0]);
  expect(uniforms.crsUnitsPerDegree2Y).toEqual([0, 0, 0, 0]);
});

/** JS re-implementation of the CRS shader branch in project_position(), first-order
 * (Jacobian-only) term. Kept separate from the second-order version below so tests can
 * report the before/after error reduction from adding the quadratic correction. */
function shaderProjectLngLatFirstOrder(uniforms, lnglat: number[]): [number, number] {
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

/** JS re-implementation of the CRS shader branch in project_position(), including the
 * `+ 0.5 * H(delta)` second-order correction added in project.glsl.ts/project.wgsl.ts. */
function shaderProjectLngLat(uniforms, lnglat: number[]): [number, number] {
  const dx = lnglat[0] - uniforms.coordinateOrigin[0];
  const dy = lnglat[1] - uniforms.coordinateOrigin[1];
  const [common0, common1] = shaderProjectLngLatFirstOrder(uniforms, lnglat);
  const quad = [0.5 * dx * dx, dx * dy, 0.5 * dy * dy];
  const hx = uniforms.crsUnitsPerDegree2X;
  const hy = uniforms.crsUnitsPerDegree2Y;
  return [
    common0 + (hx[0] * quad[0] + hx[1] * quad[1] + hx[2] * quad[2]),
    common1 + (hy[0] * quad[0] + hy[1] * quad[1] + hy[2] * quad[2])
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
      // With the second-order correction this is now several orders of magnitude
      // under a pixel at these zoom levels (an 800x600 viewport is a small fraction
      // of a UTM zone's extent); tightened from the pre-Hessian bound of 1px.
      expect(errorPixels).toBeLessThan(0.01);
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

test('CRS shader linearization#continental extent (1,200km): second-order correction fixes misregistration', () => {
  // Reproduces the user-reported failure: a UTM 18N view wide enough to span from
  // the view center out to the Great Lakes (~1,200km), where the first-order
  // (Jacobian-only) approximation visibly misregisters LNGLAT vector layers against
  // an exact per-vertex CPU transform (e.g. the Phase 3 warped basemap).
  const center: [number, number] = [-72.5, 41];
  const target: [number, number] = [-85.7, 45.9]; // near the Great Lakes, ~1,195km away

  // Compute the zoom for a view wide enough to actually show the sample point: since
  // the target is ~1,200km from the (centered) view, the view needs to be ~2,400km
  // wide for it to sit near the visible edge rather than off-screen. Pixels-per-
  // common-unit is 2^zoom, and common units per meter is
  // CRS_WORLD_SIZE / (extent width in meters) for this CRS.
  const viewWidthPixels = 1024;
  const viewWidthMeters = 2_400_000;
  const commonUnitsPerMeter = 512 / (UTM18N.extent[2] - UTM18N.extent[0]);
  const viewWidthCommon = viewWidthMeters * commonUnitsPerMeter;
  const zoom = Math.log2(viewWidthPixels / viewWidthCommon);

  const viewport = new CRSViewport({
    width: viewWidthPixels,
    height: 768,
    crs: UTM18N,
    longitude: center[0],
    latitude: center[1],
    zoom,
    pitch: 0,
    bearing: 0
  });
  const uniforms = getUniformsFromViewport({viewport});

  const exact = viewport.projectPosition([target[0], target[1], 0]);
  const firstOrder = shaderProjectLngLatFirstOrder(uniforms, target);
  const secondOrder = shaderProjectLngLat(uniforms, target);

  const firstOrderErrorPixels =
    Math.hypot(firstOrder[0] - exact[0], firstOrder[1] - exact[1]) * viewport.scale;
  const secondOrderErrorPixels =
    Math.hypot(secondOrder[0] - exact[0], secondOrder[1] - exact[1]) * viewport.scale;

  // Before: first-order-only linearization misregisters by roughly 100km at this
  // distance (visibly wrong at any zoom level for this extent).
  expect(firstOrderErrorPixels).toBeGreaterThan(1);
  // After: the second-order correction brings the same sample under 2px - visually
  // indistinguishable from the exact per-vertex CPU transform at this zoom.
  expect(secondOrderErrorPixels).toBeLessThan(2);
  // eslint-disable-next-line no-console
  console.log(
    `[CRS 1,200km scenario] zoom=${zoom.toFixed(3)} firstOrderError=${firstOrderErrorPixels.toFixed(1)}px secondOrderError=${secondOrderErrorPixels.toFixed(4)}px`
  );
});
