// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {mercatorEquivalentZoom} from '@deck.gl/geo-layers/maplibre-style-layer/style-eval-zoom';
import {selectMercatorSourceZoom} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// Round 8 (real-integration feedback) finding 1: `_MapLibreStyleLayer` evaluated style
// expressions and minzoom/maxzoom gating at the raw `viewport.zoom`, which is extent-relative in
// a CRS `MapView` -- a UTM zone's much-smaller extent reaches the same zoom NUMBER at a far more
// zoomed-in ground scale than Web Mercator's whole-world extent, silently hiding every
// minzoom-gated style layer (labels, most visibly) in a CRS view. `mercatorEquivalentZoom` fixes
// this by deriving the Mercator-equivalent zoom from ground resolution instead.

test('mercatorEquivalentZoom#exact no-op for a real WebMercatorViewport across zoom and latitude', () => {
  for (const zoom of [0, 3.4, 7, 12.7, 19.9]) {
    for (const latitude of [0, 40, 70, -33.87]) {
      const viewport = new WebMercatorViewport({
        width: 800,
        height: 600,
        longitude: -72,
        latitude,
        zoom
      });
      expect(mercatorEquivalentZoom(viewport)).toBeCloseTo(zoom, 9);
    }
  }
});

test('mercatorEquivalentZoom#UTM CRS view: matches the known ground-resolution answer (cross-checked against selectMercatorSourceZoom)', () => {
  // Same "UTM 18N at lat 40, zoom 7" scenario `warp-mesh.node.spec.ts`'s
  // "selectMercatorSourceZoom#UTM view known answer" test already pins: ground resolution is
  // metersPerUnit * 2^-zoom (~10.20 m/px), which resolves to a fractional Mercator-equivalent
  // zoom of ~12.52 -- `selectMercatorSourceZoom(viewport, 512)` (the same relationship, rounded
  // to the nearest discrete tile level) independently confirms this rounds to 13, cross-checking
  // `mercatorEquivalentZoom`'s continuous result without re-deriving the formula from scratch.
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  const equivalentZoom = mercatorEquivalentZoom(viewport);
  expect(equivalentZoom).toBeGreaterThan(12);
  expect(equivalentZoom).toBeLessThan(13);
  expect(Math.round(equivalentZoom)).toBe(selectMercatorSourceZoom(viewport, 512));

  // The CRS view's raw zoom (7) sits well below the Mercator-equivalent zoom (~12.52) for the
  // same ground scale -- the extent-relative gap the fork feedback describes, and exactly why a
  // minzoom:9-gated style layer would be wrongly hidden if evaluated at the raw zoom instead.
  expect(equivalentZoom - viewport.zoom).toBeGreaterThan(5);
});

test('mercatorEquivalentZoom#a CRS view at a higher raw zoom crosses more minzoom thresholds (monotonic in ground resolution)', () => {
  const coarse = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const fine = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 9
  });
  expect(mercatorEquivalentZoom(fine)).toBeGreaterThan(mercatorEquivalentZoom(coarse));
});
