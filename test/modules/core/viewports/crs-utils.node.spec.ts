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
