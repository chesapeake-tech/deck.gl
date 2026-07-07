// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Feature} from 'geojson';
import type {Viewport} from '@deck.gl/core';

/** Samples per extent edge when densifying a CRS's projected `extent` into a covering lnglat
 * polygon (matches `crs-utils.ts`'s own `EXTENT_GEOGRAPHIC_SAMPLES` convention for the same kind
 * of boundary-densification problem). */
const EXTENT_SAMPLES = 8;

const WORLD_RECT: Feature = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-180, -90],
        [180, -90],
        [180, 90],
        [-180, 90],
        [-180, -90]
      ]
    ]
  }
};

/** Duck-typed `CRSViewport.crs` shape (`modules/core/src/viewports/crs-utils.ts`'s
 * `NormalizedCRS`) — only the two fields this module needs. */
type ViewportCRS = {
  extent: [number, number, number, number];
  transform: {inverse: (xy: [number, number]) => [number, number]};
};

/** Perf fix (review): `renderLayers()` runs on every frame during camera motion (whenever
 * `shouldUpdateState` sees `changeFlags.somethingChanged`), and `backgroundCoveringFeature`
 * previously rebuilt the covering feature from scratch on EVERY call — `EXTENT_SAMPLES * 4 + 1`
 * (33) `crs.transform.inverse` calls plus a fresh `Feature` allocation — even though the
 * covering shape depends only on `crs.extent`/`crs.transform`, not on pan/zoom/pitch, so it
 * never actually changes across those calls. That fresh object reference then propagated
 * through `mapBackgroundLayer`'s `data: [feature]` (style-layer-mappers.ts) into
 * `GeoJsonLayer`'s `data` prop, forcing a full re-tessellation on every frame. Memoized per
 * `crs` object identity (`WeakMap`, mirroring `crs-utils.ts`'s own `memoizedByOrigin` pattern
 * for the same class of per-(crs) derived value) — see `backgroundCoveringFeature`'s doc
 * comment for the caveat this only helps within calls sharing the exact same `viewport.crs`
 * reference (e.g. multiple background style layers/instances in one frame), since
 * `CRSViewport`'s constructor re-normalizes `crs` fresh on every construction. */
const coveringFeatureCache = new WeakMap<ViewportCRS, Feature>();

/** Sample points along the four edges of a `[minX, minY, maxX, maxY]` extent,
 * `EXTENT_SAMPLES` points per edge, traversed as a single closed ring. */
function densifyExtentRing(extent: [number, number, number, number]): [number, number][] {
  const [minX, minY, maxX, maxY] = extent;
  const n = EXTENT_SAMPLES;
  const bottom: [number, number][] = [];
  const right: [number, number][] = [];
  const top: [number, number][] = [];
  const left: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = minX + t * (maxX - minX);
    const y = minY + t * (maxY - minY);
    bottom.push([x, minY]);
    right.push([maxX, y]);
    top.push([maxX - t * (maxX - minX), maxY]);
    left.push([minX, maxY - t * (maxY - minY)]);
  }
  return [...bottom, ...right, ...top, ...left, bottom[0]];
}

/** Review fix (Round 8 finding 3): `background` style layers have no source features to derive
 * a covering shape from — the previous implementation always used a hardcoded ±180°/±90° LNGLAT
 * world rectangle, which is only valid in a Web Mercator (or other whole-world) view. A
 * projected CRS with a much smaller domain (a single UTM zone, a few hundred kilometers wide)
 * folds that rectangle into a degenerate shape once run through its (necessarily non-linear,
 * often domain-limited) `transform.forward` — observed as the background failing to render at
 * all in a UTM `MapView`, not merely misshapen.
 *
 * Builds a lnglat polygon that covers the *viewport's own CRS's* valid domain instead: for a
 * classic Mercator (or any other non-CRS geospatial) viewport this is still the whole-world
 * rectangle (identity, unchanged Mercator behavior); for a `CRSViewport` it densifies
 * `viewport.crs.extent` (the CRS's own projected-unit bounds — already validated finite/positive
 * at `CRSViewport` construction, see `crs-viewport.ts`) and inverse-projects the sampled boundary
 * to lnglat, mirroring the same corner+edge-midpoint densification `crs-utils.ts` uses to derive
 * a projected `extent` from a geographic bbox. */
export function backgroundCoveringFeature(viewport: Viewport): Feature {
  // `CRSViewport` (not the base `Viewport` class this composite's `this.context.viewport` is
  // statically typed as) carries a `crs` field — duck-typed here (rather than importing
  // `_CRSViewport` and using `instanceof`) to match this module's other CRS-viewport-shaped
  // helpers (`style-eval-zoom.ts`) and the fork's own `warp-mesh.ts` convention.
  const crs = (viewport as Viewport & {crs?: ViewportCRS}).crs;
  if (!crs) {
    // Already a module constant (`WORLD_RECT`), so this is memoized "for free" -- every
    // Mercator (non-CRS) call already returns the exact same reference, no cache needed.
    return WORLD_RECT;
  }
  const cached = coveringFeatureCache.get(crs);
  if (cached) {
    return cached;
  }
  const ring = densifyExtentRing(crs.extent).map(xy => crs.transform.inverse(xy));
  const feature: Feature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring]
    }
  };
  coveringFeatureCache.set(crs, feature);
  return feature;
}
