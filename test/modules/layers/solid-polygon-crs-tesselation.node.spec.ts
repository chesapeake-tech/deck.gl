// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport, PROJECTION_MODE} from '@deck.gl/core';
import _GlobeViewport from '@deck.gl/core/viewports/globe-viewport';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import type {CRSDefinition} from '@deck.gl/core/viewports/crs-utils';
import * as Polygon from '@deck.gl/layers/solid-polygon-layer/polygon';
import {
  createCRSAffinePreproject,
  getPolygonTesselatorPreproject
} from '@deck.gl/layers/solid-polygon-layer/crs-affine-preproject';
import {UTM18N} from '../core/viewports/crs-fixtures';

/** Wraps a CRSDefinition's `transform.forward` to count calls, without mutating the
 * shared fixture (each test gets its own definition object, and `CRSViewport`
 * re-normalizes - and so freshly keys the (crs, origin) Jacobian/Hessian memoization
 * cache in crs-utils.ts - on every construction). */
function countingCRS(base: CRSDefinition): {crs: CRSDefinition; count: () => number} {
  let calls = 0;
  const crs: CRSDefinition = {
    ...base,
    transform: {
      forward: (lnglat: [number, number]) => {
        calls++;
        return base.transform.forward(lnglat);
      },
      inverse: base.transform.inverse
    }
  };
  return {crs, count: () => calls};
}

/** A closed ring approximating a small (~0.01 degree, tile-scale) polygon with a
 * concave notch and a hole - exercises earcut beyond a trivial convex shape. */
function tileScalePolygon(lng: number, lat: number) {
  const s = 0.01;
  return {
    positions: [
      lng,
      lat,
      lng + 2 * s,
      lat,
      lng + 2 * s,
      lat + 2 * s,
      lng + s,
      lat + s,
      lng,
      lat + 2 * s,
      lng,
      lat,
      // hole
      lng + 0.5 * s,
      lat + 0.5 * s,
      lng + s,
      lat + 0.5 * s,
      lng + 0.5 * s,
      lat + s
    ],
    holeIndices: [12]
  };
}

function signedArea(positions: number[], i0: number, i1: number, i2: number): number {
  const [x0, y0] = [positions[i0 * 2], positions[i0 * 2 + 1]];
  const [x1, y1] = [positions[i1 * 2], positions[i1 * 2 + 1]];
  const [x2, y2] = [positions[i2 * 2], positions[i2 * 2 + 1]];
  return 0.5 * ((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0));
}

test('createCRSAffinePreproject#identity jacobian is a pure translation', () => {
  const preproject = createCRSAffinePreproject(
    [1, 0, 0, 1],
    {x: [0, 0, 0], y: [0, 0, 0]},
    [-75, 40]
  );
  const [x, y] = preproject([-75.01, 40.02]);
  expect(x).toBeCloseTo(-0.01, 12);
  expect(y).toBeCloseTo(0.02, 12);
  expect(preproject([-75, 40])).toEqual([0, 0]);
});

test('createCRSAffinePreproject#matches manual affine+quadratic Taylor expansion', () => {
  const jacobian: [number, number, number, number] = [2, 0.1, -0.05, 3];
  const hessian = {
    x: [0.2, 0.05, -0.1] as [number, number, number],
    y: [-0.3, 0.02, 0.15] as [number, number, number]
  };
  const origin: [number, number] = [10, 20];
  const preproject = createCRSAffinePreproject(jacobian, hessian, origin);

  const dLng = 0.03;
  const dLat = -0.02;
  const [x, y] = preproject([origin[0] + dLng, origin[1] + dLat]);

  const qLngLng = 0.5 * dLng * dLng;
  const qLngLat = dLng * dLat;
  const qLatLat = 0.5 * dLat * dLat;
  const expectedX =
    jacobian[0] * dLng +
    jacobian[2] * dLat +
    (hessian.x[0] * qLngLng + hessian.x[1] * qLngLat + hessian.x[2] * qLatLat);
  const expectedY =
    jacobian[1] * dLng +
    jacobian[3] * dLat +
    (hessian.y[0] * qLngLng + hessian.y[1] * qLngLat + hessian.y[2] * qLatLat);

  expect(x).toBeCloseTo(expectedX, 12);
  expect(y).toBeCloseTo(expectedY, 12);
});

test('getPolygonTesselatorPreproject#non-lnglat coordinateSystem needs no preprojection', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  expect(
    getPolygonTesselatorPreproject(viewport, 'cartesian', false, PROJECTION_MODE.CRS)
  ).toBeUndefined();
});

test('getPolygonTesselatorPreproject#full3d always uses projectPosition, even in a CRS view', () => {
  const viewport = new CRSViewport({
    width: 800,
    height: 600,
    crs: UTM18N,
    longitude: -75,
    latitude: 40,
    zoom: 10
  });
  const preproject = getPolygonTesselatorPreproject(viewport, 'lnglat', true, PROJECTION_MODE.CRS);
  const sample = [-75.01, 40.02, 5];
  expect(preproject!(sample)).toEqual(viewport.projectPosition(sample));
});

test('getPolygonTesselatorPreproject#Web Mercator is untouched (byte-identical to projectFlat)', () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -75,
    latitude: 40,
    zoom: 10
  });
  const preproject = getPolygonTesselatorPreproject(viewport, 'lnglat', false, PROJECTION_MODE.CRS);
  for (const sample of [
    [-75, 40],
    [-75.2, 40.3],
    [10, -10]
  ]) {
    expect(preproject!(sample)).toEqual(viewport.projectFlat(sample));
  }
});

test('getPolygonTesselatorPreproject#Globe is untouched (byte-identical to projectFlat)', () => {
  const viewport = new _GlobeViewport({
    width: 800,
    height: 600,
    longitude: -75,
    latitude: 40,
    zoom: 2
  });
  const preproject = getPolygonTesselatorPreproject(viewport, 'lnglat', false, PROJECTION_MODE.CRS);
  for (const sample of [
    [-75, 40],
    [-75.2, 40.3]
  ]) {
    expect(preproject!(sample)).toEqual(viewport.projectFlat(sample));
  }
});

test('getPolygonTesselatorPreproject#CRS view eliminates per-vertex proj-wasm calls', () => {
  const {crs, count} = countingCRS(UTM18N);
  const viewport = new CRSViewport({
    width: 800,
    height: 600,
    crs,
    longitude: -75,
    latitude: 40,
    zoom: 12
  });

  // A polygon-scale set of vertices, well beyond earcut's typical basemap tile size
  const n = 500;
  const points: number[][] = [];
  for (let i = 0; i < n; i++) {
    points.push([-75 + 0.001 * Math.cos(i), 40 + 0.001 * Math.sin(i)]);
  }

  const before = count();
  const exactPreproject = viewport.projectFlat.bind(viewport);
  for (const p of points) exactPreproject(p);
  const afterExact = count();
  expect(afterExact - before).toBe(n); // one proj-wasm call per vertex, as before

  const approxPreproject = getPolygonTesselatorPreproject(
    viewport,
    'lnglat',
    false,
    PROJECTION_MODE.CRS
  )!;
  const beforeApprox = count();
  for (const p of points) approxPreproject(p);
  const afterApprox = count();
  // Jacobian (2 finite differences) + Hessian (up to 9 samples, memoized/shared) at a
  // single origin - O(1), not one call per vertex - and the Jacobian/Hessian were
  // already computed once (memoized) when `getPolygonTesselatorPreproject` built the
  // closure, so applying it to further vertices costs zero additional proj-wasm calls.
  expect(afterApprox - beforeApprox).toBe(0);
});

test('getSurfaceIndices#CRS affine approximation matches exact proj-wasm triangulation for a tile-scale polygon', () => {
  const exactViewport = new CRSViewport({
    width: 800,
    height: 600,
    crs: UTM18N,
    longitude: -75,
    latitude: 40,
    zoom: 14
  });
  const approxPreproject = getPolygonTesselatorPreproject(
    exactViewport,
    'lnglat',
    false,
    PROJECTION_MODE.CRS
  )!;
  const exactPreproject = exactViewport.projectFlat.bind(exactViewport);

  const polygon = Polygon.normalize(tileScalePolygon(-75, 40), 2);

  const exactIndices = Polygon.getSurfaceIndices(polygon, 2, exactPreproject);
  const approxIndices = Polygon.getSurfaceIndices(polygon, 2, approxPreproject);

  // Same topology: the cheap local approximation is close enough to the exact
  // transform, at tile scale, that earcut makes identical ear-clipping decisions.
  expect(approxIndices).toEqual(exactIndices);
  expect(approxIndices.length).toBeGreaterThan(0);
  expect(approxIndices.length % 3).toBe(0);

  // No degenerate/inverted triangles, and consistent winding, against the exact
  // projected positions (what would actually be closest to on-screen shape).
  const positions = Polygon.getPositions(polygon);
  const projected = positions.slice();
  for (let i = 0; i < projected.length; i += 2) {
    const [x, y] = exactPreproject([positions[i], positions[i + 1]]);
    projected[i] = x;
    projected[i + 1] = y;
  }
  let totalArea = 0;
  for (let i = 0; i < approxIndices.length; i += 3) {
    const area = signedArea(
      projected,
      approxIndices[i],
      approxIndices[i + 1],
      approxIndices[i + 2]
    );
    expect(Math.abs(area)).toBeGreaterThan(0);
    totalArea += Math.abs(area);
  }
  expect(totalArea).toBeGreaterThan(0);
});

test('getSurfaceIndices#raw lnglat (no preproject) is unaffected', () => {
  const polygon = Polygon.normalize(tileScalePolygon(-75, 40), 2);
  const indices = Polygon.getSurfaceIndices(polygon, 2);
  expect(indices.length).toBeGreaterThan(0);
  expect(indices.length % 3).toBe(0);
});
