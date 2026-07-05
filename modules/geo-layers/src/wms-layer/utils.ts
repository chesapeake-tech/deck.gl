// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {lngLatToWorld, pixelsToWorld} from '@math.gl/web-mercator';

// https://epsg.io/3857
// +proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs
const HALF_EARTH_CIRCUMFERENCE = 6378137 * Math.PI;

/** Projects EPSG:4326 to EPSG:3857
 * This is a lightweight replacement of proj4. Use tests to ensure conformance.
 */
export function WGS84ToPseudoMercator(coord: [number, number]): [number, number] {
  const mercator = lngLatToWorld(coord);
  mercator[0] = (mercator[0] / 256 - 1) * HALF_EARTH_CIRCUMFERENCE;
  mercator[1] = (mercator[1] / 256 - 1) * HALF_EARTH_CIRCUMFERENCE;
  return mercator;
}

/** Duck-typed shape of a `_CRSViewport` sufficient to compute an exact CRS-unit bbox
 * and to convert a CRS-unit rectangle to common space (avoids a hard dependency on
 * `_CRSViewport`, matching the convention in `crs-tileset-2d.ts`/`mercator-crs-tileset-2d.ts`). */
export type WMSCRSViewportLike = {
  width: number;
  height: number;
  /** Public field on `Viewport`, populated by `_initMatrices`. */
  pixelUnprojectionMatrix: number[];
  crs: {
    code: string;
    extent: [number, number, number, number];
    commonUnitsPerCRSUnit: number;
  };
};

/**
 * Computes the exact view bounds in CRS units, for use as a WMS `GetMap` bbox.
 *
 * This takes the AABB of the 4 screen corners' *common-space* coordinates — the same
 * `pixelUnprojectionMatrix`-based computation `Viewport#unproject`/`#getBounds` use
 * internally, stopped one step earlier, before the common->lnglat conversion — and then
 * un-normalizes directly back to CRS units via the CRS's extent offset and
 * `commonUnitsPerCRSUnit` scale (the exact inverse of `lngLatToCommon`'s linear part, see
 * `crs-utils.ts`).
 *
 * This is deliberately NOT `viewport.getBounds()` (lnglat) forward-projected through
 * `crs.transform.forward`: that route round-trips every corner through the CRS's
 * forward/inverse projection formulas (exact, but e.g. UTM's involve trig/log terms that
 * accumulate floating-point rounding on every evaluation). The common-space <-> CRS-units
 * relationship is a pure per-axis affine transform (offset + scale) with no transcendental
 * functions involved, so computing directly in common space and un-normalizing is the more
 * exact of the two routes, and cheaper.
 */
export function getCRSViewBoundsInCRSUnits(
  viewport: WMSCRSViewportLike
): [number, number, number, number] {
  const {width, height, pixelUnprojectionMatrix, crs} = viewport;
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height]
  ].map(pixel => pixelsToWorld(pixel, pixelUnprojectionMatrix));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of corners) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const {extent, commonUnitsPerCRSUnit} = crs;
  return [
    minX / commonUnitsPerCRSUnit + extent[0],
    minY / commonUnitsPerCRSUnit + extent[1],
    maxX / commonUnitsPerCRSUnit + extent[0],
    maxY / commonUnitsPerCRSUnit + extent[1]
  ];
}

/** Converts a `[minX, minY, maxX, maxY]` rectangle in CRS units to common space, using the
 * same extent-offset normalization as `boundsCommon` in `crs-tileset-2d.ts` (`getTileMetadata`). */
export function crsUnitsToCommonBounds(
  bounds: [number, number, number, number],
  crs: {extent: [number, number, number, number]; commonUnitsPerCRSUnit: number}
): [number, number, number, number] {
  const [minX, minY, maxX, maxY] = bounds;
  const {extent, commonUnitsPerCRSUnit} = crs;
  return [
    (minX - extent[0]) * commonUnitsPerCRSUnit,
    (minY - extent[1]) * commonUnitsPerCRSUnit,
    (maxX - extent[0]) * commonUnitsPerCRSUnit,
    (maxY - extent[1]) * commonUnitsPerCRSUnit
  ];
}
