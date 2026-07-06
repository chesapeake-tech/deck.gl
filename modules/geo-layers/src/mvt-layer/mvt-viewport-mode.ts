// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {PROJECTION_MODE, type Viewport} from '@deck.gl/core';

/** True when `MVTLayer` should use the "feature route": tile-local coordinates decoded to
 * plain lnglat (loader `coordinates: 'wgs84'`), `binary` forced `false`, no Mercator
 * power-of-two `modelMatrix`/`CARTESIAN` sublayer transform, no `ClipExtension`. This is the
 * route `GlobeView` has used since MVTLayer added globe support (`viewport.resolution` is a
 * Globe-only signal) — CRS views need the identical route for the identical reason: neither
 * is a Mercator XYZ power-of-two tile pyramid, so the Mercator-specific sublayer transform
 * (`WORLD_SIZE / 2^z` scaling) does not apply, and both already have per-tile lnglat bounds
 * available (`GeoBoundingBox`) to decode against. See
 * `docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md`, Stage 1 Design. */
export function usesFeatureRoute(viewport: Viewport): boolean {
  return (
    (viewport as {resolution?: number}).resolution !== undefined ||
    viewport.projectionMode === PROJECTION_MODE.CRS
  );
}
