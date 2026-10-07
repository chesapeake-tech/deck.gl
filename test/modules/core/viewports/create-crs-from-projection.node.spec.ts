// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {Proj4Projection} from '@math.gl/proj4';
import {_createCRSFromProjection} from '@deck.gl/core';
import {
  createCRSFromProjection,
  normalizeCRS,
  commonToLngLat
} from '@deck.gl/core/viewports/crs-utils';
import type {ProjectionConverter} from '@deck.gl/core/viewports/crs-utils';

const UTM18N_PROJ_STRING = '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs';
const UTM18N_EXTENT: [number, number, number, number] = [166021.44, 0, 833978.56, 9329005.18];
const UTM18N_BOUNDS: [number, number, number, number] = [-78, 0, -72, 84];

/** A converter in the `ProjectionConverter` shape: XYZ arrays in and out, as proj4js returns. */
function makeUTM18NConverter(): ProjectionConverter {
  const projection = new Proj4Projection({from: 'WGS84', to: UTM18N_PROJ_STRING});
  return {
    forward: position => projection.project(position),
    inverse: position => projection.unproject(position)
  };
}

test('createCRSFromProjection#is exported from @deck.gl/core', () => {
  expect(_createCRSFromProjection).toBe(createCRSFromProjection);
});

test('createCRSFromProjection#builds a CRS from a projection converter', () => {
  const crs = createCRSFromProjection({
    projection: makeUTM18NConverter(),
    toCrs: 'EPSG:32618',
    extent: UTM18N_EXTENT
  });

  expect(crs.code).toBe('EPSG:32618');
  expect(crs.extent).toEqual(UTM18N_EXTENT);
  expect(crs.units).toBe('meters');

  // Definitional anchor: the central meridian at the equator is exactly (500000, 0).
  const [x, y] = crs.transform.forward([-75, 0]);
  expect(x).toBeCloseTo(500000, 3);
  expect(y).toBeCloseTo(0, 3);
  const [lng, lat] = crs.transform.inverse([x, y]);
  expect(lng).toBeCloseTo(-75, 6);
  expect(lat).toBeCloseTo(0, 6);

  expect(() => normalizeCRS(crs)).not.toThrow();
});

test('createCRSFromProjection#returns XY pairs from a converter that returns XYZ', () => {
  const crs = createCRSFromProjection({
    projection: {
      forward: ([x, y]) => [x * 2, y * 3, 100],
      inverse: ([x, y]) => [x / 2, y / 3, 100]
    },
    toCrs: 'TEST:XYZ',
    extent: [-360, -270, 360, 270]
  });

  expect(crs.transform.forward([10, 20])).toEqual([20, 60]);
  expect(crs.transform.inverse([20, 60])).toEqual([10, 20]);
});

test('createCRSFromProjection#maps a null inverse to NaN', () => {
  // Only the inside of the extent has an inverse, as for a converter with a bounded domain.
  const crs = normalizeCRS(
    createCRSFromProjection({
      projection: {
        forward: ([x, y]) => [x, y],
        inverse: ([x, y]) => (Math.abs(x) <= 10 && Math.abs(y) <= 10 ? [x, y] : null)
      },
      toCrs: 'TEST:BOUNDED',
      extent: [-10, -10, 10, 10]
    })
  );

  expect(crs.transform.inverse([0, 5])).toEqual([0, 5]);
  expect(crs.transform.inverse([50, 0])).toEqual([NaN, NaN]);
  // Common space beyond the extent unprojects to NaN instead of throwing on a null result.
  expect(commonToLngLat(crs, [10000, 0])).toEqual([NaN, NaN]);
});

test('createCRSFromProjection#does not let the converter mutate the caller input', () => {
  const crs = createCRSFromProjection({
    projection: {
      forward: position => {
        position[0] = 0;
        return position;
      },
      inverse: position => {
        position[1] = 0;
        return position;
      }
    },
    toCrs: 'TEST:MUTATING',
    extent: [-180, -90, 180, 90]
  });

  const lnglat: [number, number] = [12, 34];
  crs.transform.forward(lnglat);
  expect(lnglat).toEqual([12, 34]);
  const xy: [number, number] = [56, 78];
  crs.transform.inverse(xy);
  expect(xy).toEqual([56, 78]);
});

test('createCRSFromProjection#derives the extent from fromBounds', () => {
  const fromBounds = createCRSFromProjection({
    projection: makeUTM18NConverter(),
    toCrs: 'EPSG:32618',
    fromBounds: UTM18N_BOUNDS
  });
  expect(fromBounds.extentGeographic).toEqual(UTM18N_BOUNDS);
  expect(fromBounds.extent).toBeUndefined();

  // Same derivation as the equivalent extentGeographic definition.
  const derived = normalizeCRS(fromBounds).extent;
  expect(derived[0]).toBeCloseTo(UTM18N_EXTENT[0], -4);
  expect(derived[2]).toBeCloseTo(UTM18N_EXTENT[2], -4);
});

test('createCRSFromProjection#prefers an exact extent over fromBounds', () => {
  const crs = createCRSFromProjection({
    projection: makeUTM18NConverter(),
    toCrs: 'EPSG:32618',
    fromBounds: UTM18N_BOUNDS,
    extent: UTM18N_EXTENT
  });
  expect(crs.extent).toEqual(UTM18N_EXTENT);
  expect(crs.extentGeographic).toBeUndefined();
});

test('createCRSFromProjection#requires fromBounds or extent', () => {
  expect(() =>
    createCRSFromProjection({projection: makeUTM18NConverter(), toCrs: 'EPSG:32618'})
  ).toThrow(/fromBounds or extent/);
});

test('createCRSFromProjection#accepts only WGS84 world coordinates', () => {
  for (const fromCrs of [undefined, 'WGS84', 'EPSG:4326']) {
    expect(() =>
      createCRSFromProjection({
        projection: makeUTM18NConverter(),
        fromCrs,
        toCrs: 'EPSG:32618',
        extent: UTM18N_EXTENT
      })
    ).not.toThrow();
  }
  expect(() =>
    createCRSFromProjection({
      projection: makeUTM18NConverter(),
      fromCrs: 'EPSG:3857',
      toCrs: 'EPSG:32618',
      extent: UTM18N_EXTENT
    })
  ).toThrow(/fromCrs/);
});
