// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {
  WebMercatorViewport,
  _GlobeViewport as GlobeViewport,
  _CRSViewport as CRSViewport
} from '@deck.gl/core';
import {usesFeatureRoute} from '@deck.gl/geo-layers/mvt-layer/mvt-viewport-mode';
import {UTM18N} from '../../core/viewports/crs-fixtures';

test('usesFeatureRoute#Mercator: false (unchanged binary/local/CARTESIAN route)', () => {
  const viewport = new WebMercatorViewport({width: 800, height: 600});
  expect(usesFeatureRoute(viewport)).toBe(false);
});

test('usesFeatureRoute#Globe: true (regression — same signal Globe already uses)', () => {
  const viewport = new GlobeViewport({width: 800, height: 600});
  expect(usesFeatureRoute(viewport)).toBe(true);
});

test('usesFeatureRoute#CRS: true (new)', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10
  });
  expect(usesFeatureRoute(viewport)).toBe(true);
});

test('usesFeatureRoute#non-geospatial: false', () => {
  const fakeViewport = {resolution: undefined, projectionMode: 0} as any;
  expect(usesFeatureRoute(fakeViewport)).toBe(false);
});
