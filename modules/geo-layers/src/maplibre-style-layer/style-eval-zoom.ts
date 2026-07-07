// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {unitsPerMeter} from '@math.gl/web-mercator';

/**
 * Mercator-equivalent zoom for MapLibre style evaluation: `minzoom`/`maxzoom` gating,
 * `["zoom"]`-dependent paint/layout expressions, and the zoom-bucket `updateTriggers` key.
 *
 * A CRS `MapView`'s `viewport.zoom` is extent-relative (docs/api-reference/core/map-view.md#crs):
 * at zoom `z` the CRS's `extent` spans `512 * 2^z` common-space pixels, so a projected CRS with a
 * much smaller extent than Web Mercator's whole world (e.g. a single UTM zone) reaches the same
 * zoom NUMBER at a far more zoomed-in ground scale -- concretely, EPSG:32610 (UTM zone 10N) at San
 * Francisco's latitude sits ~5.56 levels below the Mercator-equivalent zoom for the same ground
 * resolution. Style layers author `minzoom`/`maxzoom`
 * and zoom expressions against the Mercator pyramid's own zoom numbering (MapLibre/Mapbox tile
 * services are Mercator-pyramid services), so evaluating them at the raw CRS zoom silently hides
 * every minzoom-gated layer -- most visibly labels, which are almost always minzoom-gated.
 *
 * Derives the actual ground resolution the viewport is showing (`viewport.metersPerPixel`,
 * already correct for either a `WebMercatorViewport` or a `CRSViewport`) and inverts the Web
 * Mercator ground-resolution formula to recover the zoom level Mercator would need to display
 * that same ground scale at that latitude -- the same ground-resolution relationship
 * `selectMercatorSourceZoom` (`../warped-tile-layer/warp-mesh.ts`) already uses to pick a Mercator
 * source tile level for a CRS view's warped-raster path, generalized here to a continuous
 * (non-rounded) zoom suitable for style/expression evaluation rather than a discrete tile-pyramid
 * level.
 *
 * Reuses `@math.gl/web-mercator`'s own `unitsPerMeter(latitude)` -- the exact same helper
 * `WebMercatorViewport` uses to build its `distanceScales` -- rather than re-deriving the
 * meters-per-common-unit-at-zoom-0 relationship from a locally-declared Earth circumference
 * constant. This makes the result an EXACT no-op for a real `WebMercatorViewport` (pinned to
 * machine precision by `style-eval-zoom.node.spec.ts`): at zoom 0 (`scale` 1),
 * `metersPerPixel` is by construction `1 / unitsPerMeter(latitude)`, so solving
 * `metersPerPixel = (1 / unitsPerMeter(latitude)) * 2^-zoom` for `zoom` recovers the viewport's
 * own zoom unchanged. (`warp-mesh.ts`'s own `EARTH_CIRCUMFERENCE` constant is a more precise
 * equatorial-circumference figure than `@math.gl/web-mercator`'s internal one, which is fine for
 * that module's *rounded* discrete tile-level selection but would reintroduce a ~0.0016-zoom-level
 * discrepancy here, exactly large enough to matter for `minzoom`/`maxzoom` gating at an
 * integer-zoom boundary.)
 */
export function mercatorEquivalentZoom(viewport: {
  zoom: number;
  latitude?: number;
  metersPerPixel: number;
}): number {
  const latitude = viewport.latitude ?? 0;
  const metersPerPixelAtZoom0 = 1 / unitsPerMeter(latitude);
  return Math.log2(metersPerPixelAtZoom0 / viewport.metersPerPixel);
}
