// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import {PROJECTION_MODE} from '@deck.gl/core/lib/constants';
import {UTM18N} from './crs-utils.node.spec';

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
  expect(new CRSViewport(opts).equals(new CRSViewport({...opts, crs: 'EPSG:4326'}))).toBe(false);
});
