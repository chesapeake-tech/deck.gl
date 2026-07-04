// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {PROJECTION_MODE} from '@deck.gl/core/lib/constants';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import {getUniformsFromViewport} from '@deck.gl/core/shaderlib/project/viewport-uniforms';
import {UTM18N} from '../../viewports/crs-utils.node.spec';

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
