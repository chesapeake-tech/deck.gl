// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {_GlobeViewport as GlobeViewport, Viewport} from '@deck.gl/core';
import type {Bounds, GeoBoundingBox, TileBoundingBox} from '../tileset-2d/index';

export const TILE_OVERLAP_PIXELS = 1;
export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

/** Pads a tile's bounds rectangle by one tile-overlap pixel-equivalent on each side, so
 * adjacent tile meshes stitch without seams. `clampLngLat` clamps the result to the lnglat
 * domain — only correct when `bounds` is itself in lnglat degrees (the GlobeViewport case,
 * where `projectFlat` is identity); common-space and non-geospatial bounds must not be
 * clamped to +/-180/+/-90. */
export function getOverlappedBounds(
  bounds: Bounds,
  tileSize: number,
  clampLngLat: boolean
): Bounds {
  const xPad = ((bounds[2] - bounds[0]) / tileSize) * TILE_OVERLAP_PIXELS;
  const yPad = ((bounds[3] - bounds[1]) / tileSize) * TILE_OVERLAP_PIXELS;
  const overlappedBounds: Bounds = [
    bounds[0] - xPad,
    bounds[1] - yPad,
    bounds[2] + xPad,
    bounds[3] + yPad
  ];

  if (!clampLngLat) {
    return overlappedBounds;
  }

  return [
    Math.max(overlappedBounds[0], -MAX_LONGITUDE),
    Math.max(overlappedBounds[1], -MAX_LATITUDE),
    Math.min(overlappedBounds[2], MAX_LONGITUDE),
    Math.min(overlappedBounds[3], MAX_LATITUDE)
  ];
}

/** Resolves a terrain tile's mesh-bounds rectangle (the `@loaders.gl/terrain` loader's
 * `bounds` argument) and whether it should be clamped to the lnglat domain.
 *
 * Prefers `tile.boundsCommon` — set by `_CRSTileset2D` (`modules/geo-layers/src/tileset-2d/
 * crs-tileset-2d.ts`) when `TileLayer`'s `tileMatrixSet` prop is used. It is exact, not an
 * approximation: a `tileMatrixSet`-indexed tile is by construction a rectangle in the CRS's
 * own native grid units, and CRS-view common space is that same plane, only offset and
 * uniformly rescaled — so `boundsCommon` needs no reprojection, unlike a source pyramid in a
 * *different* projection from the view (the Phase 3 warped-tile problem).
 *
 * Falls back to the pre-existing behavior, unchanged, when `boundsCommon` is absent: Mercator
 * geospatial viewports use `viewport.projectFlat` on the tile's lnglat `bbox` corners
 * (`clampLngLat` true only for `GlobeViewport`, where `projectFlat` is identity and the result
 * is lnglat degrees, not common-space units); non-geospatial viewports use the raw
 * pixel-space `bbox` directly. */
export function resolveTiledTerrainBounds(
  tile: {bbox: TileBoundingBox; boundsCommon?: Bounds},
  viewport: Viewport
): {bounds: Bounds; clampLngLat: boolean} {
  if (tile.boundsCommon) {
    return {bounds: tile.boundsCommon, clampLngLat: false};
  }
  if (viewport.isGeospatial) {
    const bbox = tile.bbox as GeoBoundingBox;
    const bottomLeft = viewport.projectFlat([bbox.west, bbox.south]);
    const topRight = viewport.projectFlat([bbox.east, bbox.north]);
    return {
      bounds: [bottomLeft[0], bottomLeft[1], topRight[0], topRight[1]],
      clampLngLat: viewport instanceof GlobeViewport
    };
  }
  const bbox = tile.bbox as Exclude<TileBoundingBox, GeoBoundingBox>;
  return {
    bounds: [bbox.left, bbox.bottom, bbox.right, bbox.top],
    clampLngLat: false
  };
}
