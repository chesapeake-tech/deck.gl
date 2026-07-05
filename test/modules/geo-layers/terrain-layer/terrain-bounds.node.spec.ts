// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport, _GlobeViewport as GlobeViewport} from '@deck.gl/core';
import {
  resolveTiledTerrainBounds,
  getOverlappedBounds,
  MAX_LATITUDE,
  MAX_LONGITUDE
} from '@deck.gl/geo-layers/terrain-layer/terrain-bounds';

const geoBbox = {west: -122.5, south: 37.6, east: -122.3, north: 37.8};
const nonGeoBbox = {left: 0, bottom: 0, right: 256, top: 256};

test('resolveTiledTerrainBounds#prefers boundsCommon when present (CRS-native tile)', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  const boundsCommon: [number, number, number, number] = [10, 20, 30, 40];
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: geoBbox, boundsCommon}, viewport);
  expect(bounds).toEqual(boundsCommon);
  expect(clampLngLat).toBe(false);
});

test('resolveTiledTerrainBounds#Mercator regression: projectFlat path unchanged, not clamped', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: geoBbox}, viewport);
  const bottomLeft = viewport.projectFlat([geoBbox.west, geoBbox.south]);
  const topRight = viewport.projectFlat([geoBbox.east, geoBbox.north]);
  expect(bounds).toEqual([bottomLeft[0], bottomLeft[1], topRight[0], topRight[1]]);
  expect(clampLngLat).toBe(false);
});

test('resolveTiledTerrainBounds#GlobeViewport regression: projectFlat is identity, clamp true', () => {
  const viewport = new GlobeViewport({width: 800, height: 600});
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: geoBbox}, viewport);
  // GlobeViewport#projectFlat is identity: lng/lat pass through as common-space x/y
  expect(bounds).toEqual([geoBbox.west, geoBbox.south, geoBbox.east, geoBbox.north]);
  expect(clampLngLat).toBe(true);
});

test('resolveTiledTerrainBounds#non-geospatial regression: raw bbox, no clamp', () => {
  // WebMercatorViewport is always isGeospatial: true; a non-geospatial Viewport (e.g. plain
  // orthographic/OrbitView) only needs the `isGeospatial` flag for this branch, so a minimal
  // stub is sufficient and avoids depending on a specific non-geospatial viewport class.
  const fakeViewport = {isGeospatial: false} as any;
  const {bounds, clampLngLat} = resolveTiledTerrainBounds({bbox: nonGeoBbox}, fakeViewport);
  expect(bounds).toEqual([nonGeoBbox.left, nonGeoBbox.bottom, nonGeoBbox.right, nonGeoBbox.top]);
  expect(clampLngLat).toBe(false);
});

test('getOverlappedBounds#pads proportionally and clamps only when requested', () => {
  expect(getOverlappedBounds([0, 0, 256, 256], 256, false)).toEqual([-1, -1, 257, 257]);
  const clamped = getOverlappedBounds([179, 89, 180, 90], 256, true);
  expect(clamped[2]).toBe(MAX_LONGITUDE);
  expect(clamped[3]).toBe(MAX_LATITUDE);
});
