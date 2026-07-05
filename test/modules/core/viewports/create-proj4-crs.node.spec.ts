// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {Proj4Projection} from '@math.gl/proj4';
import {createProj4CRS, normalizeCRS} from '@deck.gl/core/viewports/crs-utils';

// UTM zone 18N. Anchor is definitional: central meridian -75deg at the equator maps to
// easting 500000, northing 0 - a real proj4-backed converter, matching the fixture used
// by crs-utils.node.spec.ts/crs-fixtures.ts.
const UTM18N_PROJ_STRING = '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs';
const UTM18N_EXTENT: [number, number, number, number] = [166021.44, 0, 833978.56, 9329005.18];
const UTM18N_EXTENT_GEOGRAPHIC: [number, number, number, number] = [-78, 0, -72, 84];

test('createProj4CRS#accepts a project/unproject converter (e.g. @math.gl/proj4 Proj4Projection)', () => {
  const projection = new Proj4Projection({from: 'WGS84', to: UTM18N_PROJ_STRING});

  const crs = createProj4CRS({
    code: 'EPSG:32618',
    converter: projection,
    extent: UTM18N_EXTENT,
    units: 'meters'
  });

  expect(crs.code).toBe('EPSG:32618');
  expect(crs.extent).toEqual(UTM18N_EXTENT);
  expect(crs.units).toBe('meters');

  // Definitional anchor: the central meridian at the equator is exactly (500000, 0).
  const [x, y] = crs.transform.forward([-75, 0]);
  expect(x).toBeCloseTo(500000, 3);
  expect(y).toBeCloseTo(0, 3);

  // Round-trips through inverse.
  const [lng, lat] = crs.transform.inverse([x, y]);
  expect(lng).toBeCloseTo(-75, 6);
  expect(lat).toBeCloseTo(0, 6);

  // The resulting CRSDefinition passes downstream validation unchanged.
  expect(() => normalizeCRS(crs)).not.toThrow();
});

test('createProj4CRS#accepts a forward/inverse converter (e.g. proj4 itself) and matches project/unproject', () => {
  const projection = new Proj4Projection({from: 'WGS84', to: UTM18N_PROJ_STRING});
  // A minimal proj4-shaped converter (proj4's own `Converter` uses `forward`/`inverse`
  // naming) backed by the same real projection, so results can be compared directly
  // against the project/unproject case above.
  const forwardInverseConverter = {
    forward: (lnglat: [number, number]) => projection.project(lnglat) as [number, number],
    inverse: (xy: [number, number]) => projection.unproject(xy) as [number, number]
  };

  const crs = createProj4CRS({
    code: 'EPSG:32618',
    converter: forwardInverseConverter,
    extent: UTM18N_EXTENT
  });

  const forward = crs.transform.forward([-75.6, 39.9]);
  const expected = projection.project([-75.6, 39.9]);
  expect(forward[0]).toBeCloseTo(expected[0], 9);
  expect(forward[1]).toBeCloseTo(expected[1], 9);

  const inverse = crs.transform.inverse(forward);
  const expectedInverse = projection.unproject(forward);
  expect(inverse[0]).toBeCloseTo(expectedInverse[0], 9);
  expect(inverse[1]).toBeCloseTo(expectedInverse[1], 9);
});

test("createProj4CRS#passes extentGeographic through untouched (extent derivation is normalizeCRS's job)", () => {
  const projection = new Proj4Projection({from: 'WGS84', to: UTM18N_PROJ_STRING});

  const crs = createProj4CRS({
    code: 'EPSG:32618',
    converter: projection,
    extentGeographic: UTM18N_EXTENT_GEOGRAPHIC,
    units: 'meters'
  });

  expect(crs.extent).toBeUndefined();
  expect(crs.extentGeographic).toEqual(UTM18N_EXTENT_GEOGRAPHIC);

  // normalizeCRS derives a projected extent from extentGeographic that's a close
  // approximation of the known UTM 18N extent (same derivation crs-utils.node.spec.ts
  // already pins independently).
  const normalized = normalizeCRS(crs);
  expect(normalized.extent[0]).toBeCloseTo(UTM18N_EXTENT[0], -3);
  expect(normalized.extent[2]).toBeCloseTo(UTM18N_EXTENT[2], -3);
});

test('createProj4CRS#defaults units when omitted (normalizeCRS applies its own default)', () => {
  const projection = new Proj4Projection({from: 'WGS84', to: UTM18N_PROJ_STRING});
  const crs = createProj4CRS({
    code: 'EPSG:32618',
    converter: projection,
    extent: UTM18N_EXTENT
  });
  expect(crs.units).toBeUndefined();
  expect(normalizeCRS(crs).units).toBe('meters');
});
