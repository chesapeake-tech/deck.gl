// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {backgroundCoveringFeature} from '@deck.gl/geo-layers/maplibre-style-layer/background-coverage';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// Round 8 (real-integration feedback) finding 3: `background` style layers were rendered as a
// hardcoded ±180°/±90° LNGLAT world polygon -- CRS-unsafe, since a UTM (or other small-extent)
// projected CRS's `transform.forward` folds that rectangle into a degenerate shape that never
// covers the viewport (observed: a positron-style background failed to render at all in a UTM
// `MapView`). `backgroundCoveringFeature` covers the viewport's own CRS's valid extent instead.

test('backgroundCoveringFeature#Mercator (non-CRS) viewport: unchanged whole-world rectangle', () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: 0,
    latitude: 0,
    zoom: 3
  });
  const feature = backgroundCoveringFeature(viewport as any);
  const ring = (feature.geometry as any).coordinates[0] as [number, number][];
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  expect(Math.min(...lngs)).toBe(-180);
  expect(Math.max(...lngs)).toBe(180);
  expect(Math.min(...lats)).toBe(-90);
  expect(Math.max(...lats)).toBe(90);
});

test('backgroundCoveringFeature#CRS (UTM) viewport: covers the CRS extent, not a degenerate world rectangle', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const feature = backgroundCoveringFeature(viewport as any);
  const ring = (feature.geometry as any).coordinates[0] as [number, number][];
  // A real, non-degenerate ring: enough distinct points, non-zero area in lnglat space.
  expect(ring.length).toBeGreaterThan(4);
  const lngs = ring.map(([lng]) => lng);
  const lats = ring.map(([, lat]) => lat);
  const lngSpan = Math.max(...lngs) - Math.min(...lngs);
  const latSpan = Math.max(...lats) - Math.min(...lats);
  expect(lngSpan).toBeGreaterThan(0);
  expect(latSpan).toBeGreaterThan(0);
  // Not the whole-world rectangle: the fixture's UTM 18N `extent` is bounded well short of a
  // full ±180°/±90° world (it's a single UTM zone's northing/easting range, equator to
  // near-pole), so every sampled corner/edge point should land strictly inside the world rect.
  expect(Math.max(...lngs.map(Math.abs))).toBeLessThan(180);
  expect(Math.max(...lats.map(Math.abs))).toBeLessThan(90);
  // The view center should fall within the covering ring's bounding box (sanity: it actually
  // covers the area the viewport is looking at, not some unrelated part of the CRS domain).
  expect(viewport.longitude).toBeGreaterThan(Math.min(...lngs));
  expect(viewport.longitude).toBeLessThan(Math.max(...lngs));
  expect(viewport.latitude).toBeGreaterThan(Math.min(...lats));
  expect(viewport.latitude).toBeLessThan(Math.max(...lats));
});
