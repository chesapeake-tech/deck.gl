// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {mercatorEquivalentZoom} from '@deck.gl/geo-layers/maplibre-style-layer/style-eval-zoom';
import {zoomBucket} from '@deck.gl/geo-layers/maplibre-style-layer/compile-expression';
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

// Multi-view mixed-projection audit (docs/superpowers/specs/2026-07-06-crs-multiview-audit.md),
// scenario 3: `_MapLibreStyleLayer.renderLayers()` (maplibre-style-layer.ts:304) computes
// `mercatorEquivalentZoom(this.context.viewport)` exactly once per `layerManager.updateLayers()`
// cycle and uses it both as the value zoom-dependent style expressions/minzoom/maxzoom gating are
// evaluated at, AND as half of the per-(tile, style-layer) memoized sublayer cache key
// (`zoomBucket(zoom)`, see the "bucket-crossing regen" perf fix). `context.viewport` is the
// single mutable slot every view sharing this layer instance updates
// (`layer-manager.ts#activateViewport`) -- if a Mercator view and this UTM CRS view happen to
// share the SAME nominal `viewState.zoom` (a plausible synced-viewState multi-view setup), they
// resolve to wildly different `mercatorEquivalentZoom`/`zoomBucket` values. Whichever view isn't
// "active" in the shared context when `renderLayers()` runs gets its zoom-dependent styling (and
// its minzoom/maxzoom gating) evaluated -- and cached -- for the OTHER view's ground scale, off
// by more than 5 zoom levels here: labels/lines/fills sized or gated for a UTM-zoomed-in view
// would silently apply to the Mercator view (or vice versa) whenever this layer is shared, rather
// than each view's own actual scale (root cause shared with scenario 1's MVTLayer tileset/binary
// staleness and scenario 2's WarpedTileLayer mesh staleness: sublayer generation is a per-update,
// not per-viewport, operation -- see composite-layer.ts's own doc comment).
test('mercatorEquivalentZoom#a shared style layer would resolve wildly different zoom buckets for a Mercator view and a same-nominal-zoom CRS view', () => {
  const mercatorViewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  const crsViewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });

  const mercatorZoom = mercatorEquivalentZoom(mercatorViewport);
  const crsZoom = mercatorEquivalentZoom(crsViewport);

  // Mercator is an exact no-op (pinned above), so this is exactly the CRS view's own ~5.52-level
  // gap (pinned above) surfacing as a cross-view mismatch once the two views' zoom-dependent
  // styling is forced through a single shared value.
  expect(mercatorZoom).toBeCloseTo(7, 9);
  expect(crsZoom - mercatorZoom).toBeGreaterThan(5);
  expect(zoomBucket(mercatorZoom)).not.toBe(zoomBucket(crsZoom));
});
