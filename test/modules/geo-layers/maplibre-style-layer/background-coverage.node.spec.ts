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

// Perf fix (review): `renderLayers()` runs on every frame during camera motion (whenever
// `shouldUpdateState` sees `changeFlags.somethingChanged`, which a pan/zoom/pitch triggers), and
// previously rebuilt the covering feature -- and, one level up in `mapBackgroundLayer`
// (style-layer-mappers.ts), a fresh `[feature]` wrapping array -- from scratch on every single
// call: 33 `crs.transform.inverse` calls (`densifyExtentRing`'s 32 samples + the repeated first
// point) plus a fresh `Feature`/array allocation, which propagated into `GeoJsonLayer`'s
// `data` prop changing reference every frame and forcing a full re-tessellation each time, even
// though the CRS (and so the true covering shape) never changed. `backgroundCoveringFeature`
// must return the SAME `Feature` reference for the same `crs` identity across calls.
test('backgroundCoveringFeature#CRS viewport: memoized per crs identity (same reference across repeated calls, no repeated transform.inverse work)', () => {
  // `CRSViewport`'s constructor calls `normalizeCRS(opts.crs)`, which is now itself memoized
  // on the input `crs` object's identity (see crs-utils.node.spec.ts's "normalizeCRS identity
  // memoization" tests) -- so two independently-constructed viewports built from the SAME
  // `CRSDefinition` object now share the same `.crs` (`NormalizedCRS`) reference too, and this
  // memo (keyed on that reference) reuses cross-frame, not just within one viewport instance.
  // This is the realistic win: an app that memoizes its `CRSDefinition` (per docs guidance)
  // and constructs a fresh `CRSViewport` per frame (as `ViewManager` does on every viewState
  // change) now gets full cross-frame cache reuse here, not just reuse within one frame's
  // repeated calls (e.g. multiple `MapLibreStyleLayer` instances sharing one viewport).
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });

  const feature1 = backgroundCoveringFeature(viewport as any);
  const feature2 = backgroundCoveringFeature(viewport as any);
  expect(feature2).toBe(feature1);

  // A DIFFERENTLY-CONSTRUCTED viewport, built from the SAME `CRSDefinition` object (`UTM18N`),
  // now shares that same normalizeCRS-memoized `.crs` reference -- so it shares the cache
  // entry too, and gets back the identical `Feature` object, not just an equal one.
  const otherViewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const otherFeature = backgroundCoveringFeature(otherViewport as any);
  expect(otherFeature).toBe(feature1);
});

// A viewport built from a genuinely DIFFERENT `CRSDefinition` object (even with identical
// content) must NOT share the first viewport's cache entry -- normalizeCRS's memoization is
// keyed on the input object's identity, not on its `code`/contents (see
// crs-utils.node.spec.ts's "two distinct object literals ... return different references"
// test), so a distinct `CRSDefinition` object correctly yields a distinct `.crs` reference and
// thus a distinct (but value-equal) covering feature.
test('backgroundCoveringFeature#CRS viewport: a genuinely distinct CRSDefinition object does not share the cache entry', () => {
  const distinctUTM18N = {...UTM18N};

  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const otherViewport = new CRSViewport({
    crs: distinctUTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });

  const feature1 = backgroundCoveringFeature(viewport as any);
  const otherFeature = backgroundCoveringFeature(otherViewport as any);
  expect(otherFeature).not.toBe(feature1);
  // ...but is still equal in VALUE -- the memoization is a cache, not a change in output.
  expect(otherFeature).toEqual(feature1);
});

test('backgroundCoveringFeature#Mercator (non-CRS) viewport: same module-constant reference across calls', () => {
  const viewport1 = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: 0,
    latitude: 0,
    zoom: 3
  });
  const viewport2 = new WebMercatorViewport({
    width: 400,
    height: 300,
    longitude: 10,
    latitude: 5,
    zoom: 8
  });
  expect(backgroundCoveringFeature(viewport2 as any)).toBe(
    backgroundCoveringFeature(viewport1 as any)
  );
});
