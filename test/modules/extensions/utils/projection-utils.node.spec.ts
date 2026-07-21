// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe, test, expect} from 'vitest';
import {
  WebMercatorViewport,
  OrthographicViewport,
  _CRSViewport as CRSViewport
} from '@deck.gl/core';
import {
  makeViewport,
  getViewportWorldBounds,
  Bounds
} from '@deck.gl/extensions/utils/projection-utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';

const CRS_SOURCE_VIEWPORT = new CRSViewport({
  id: 'crs-view',
  crs: UTM18N,
  width: 800,
  height: 600,
  longitude: -72,
  latitude: 40,
  zoom: 3
});

const MERCATOR_SOURCE_VIEWPORT = new WebMercatorViewport({
  id: 'mercator-view',
  width: 800,
  height: 600,
  longitude: -72,
  latitude: 40,
  zoom: 8
});

/** Axis-aligned common-space box covering the given lnglat corners, in the source
 * viewport's own common space (mirrors what joinLayerBounds produces for mask layers) */
function commonBoundsFromLngLat(
  viewport: WebMercatorViewport | CRSViewport,
  cornerA: [number, number],
  cornerB: [number, number]
): Bounds {
  const a = viewport.projectFlat(cornerA);
  const b = viewport.projectFlat(cornerB);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** Common-space extent of a top-down viewport created by makeViewport */
function commonExtentOf(viewport: WebMercatorViewport | CRSViewport): Bounds {
  const halfWidth = viewport.width / (2 * viewport.scale);
  const halfHeight = viewport.height / (2 * viewport.scale);
  const [centerX, centerY] = viewport.center;
  return [centerX - halfWidth, centerY - halfHeight, centerX + halfWidth, centerY + halfHeight];
}

describe('makeViewport', () => {
  test('constructs a CRSViewport for a CRS source viewport', () => {
    const bounds = commonBoundsFromLngLat(CRS_SOURCE_VIEWPORT, [-73, 39.5], [-71, 40.5]);
    const result = makeViewport({
      bounds,
      viewport: CRS_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048,
      border: 1
    });

    expect(result).toBeInstanceOf(CRSViewport);
    const crsResult = result as CRSViewport;
    expect(crsResult.crs.code).toBe('EPSG:32618');
    expect(crsResult.id).toBe('crs-view');

    // Centered on the bounds, in the SAME common space the source viewport projects to
    expect(crsResult.center[0]).toBeCloseTo((bounds[0] + bounds[2]) / 2, 6);
    expect(crsResult.center[1]).toBeCloseTo((bounds[1] + bounds[3]) / 2, 6);

    // Fitted: covers the bounds (up to fp error from the center's project/unproject
    // round trip), and fits them exactly along the tighter axis
    const extent = commonExtentOf(crsResult);
    const epsilon = 1e-9 * (bounds[2] - bounds[0]);
    expect(extent[0]).toBeLessThanOrEqual(bounds[0] + epsilon);
    expect(extent[1]).toBeLessThanOrEqual(bounds[1] + epsilon);
    expect(extent[2]).toBeGreaterThanOrEqual(bounds[2] - epsilon);
    expect(extent[3]).toBeGreaterThanOrEqual(bounds[3] - epsilon);
    const fitRatio = Math.min(
      (extent[2] - extent[0]) / (bounds[2] - bounds[0]),
      (extent[3] - extent[1]) / (bounds[3] - bounds[1])
    );
    expect(fitRatio).toBeCloseTo(1, 6);
  });

  test('still constructs a WebMercatorViewport for a Mercator source viewport', () => {
    const bounds = commonBoundsFromLngLat(MERCATOR_SOURCE_VIEWPORT, [-73, 39.5], [-71, 40.5]);
    const result = makeViewport({
      bounds,
      viewport: MERCATOR_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048,
      border: 1
    });

    expect(result).toBeInstanceOf(WebMercatorViewport);
    expect(result).not.toBeInstanceOf(CRSViewport);
    expect(result!.id).toBe('mercator-view');

    const extent = commonExtentOf(result as WebMercatorViewport);
    const epsilon = 1e-9 * (bounds[2] - bounds[0]);
    expect(extent[0]).toBeLessThanOrEqual(bounds[0] + epsilon);
    expect(extent[1]).toBeLessThanOrEqual(bounds[1] + epsilon);
    expect(extent[2]).toBeGreaterThanOrEqual(bounds[2] - epsilon);
    expect(extent[3]).toBeGreaterThanOrEqual(bounds[3] - epsilon);
  });

  test('mercatorBounds forces a WebMercatorViewport for a CRS source viewport', () => {
    // The terrain passes compute bounds in absolute Mercator common space and opt out
    // of source-viewport-typed construction
    const bounds = commonBoundsFromLngLat(
      new WebMercatorViewport({width: 1, height: 1, longitude: 0, latitude: 0, zoom: 0}),
      [-73, 39.5],
      [-71, 40.5]
    );
    const result = makeViewport({
      bounds,
      viewport: CRS_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048,
      mercatorBounds: true
    });

    expect(result).toBeInstanceOf(WebMercatorViewport);
    expect(result).not.toBeInstanceOf(CRSViewport);
  });

  test('still constructs an OrthographicViewport for a non-geospatial source viewport', () => {
    const source = new OrthographicViewport({
      id: 'ortho-view',
      width: 800,
      height: 600,
      target: [10, 20, 0],
      zoom: 2
    });
    const result = makeViewport({
      bounds: [0, 0, 100, 50],
      viewport: source,
      width: 2048,
      height: 2048
    });

    expect(result).toBeInstanceOf(OrthographicViewport);
  });

  test('returns null for empty bounds', () => {
    const result = makeViewport({
      bounds: [1, 1, 1, 1],
      viewport: CRS_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048
    });
    expect(result).toBeNull();
  });
});

describe('getViewportWorldBounds', () => {
  test('CRS: corners project back to the exact common-space extent', () => {
    const bounds = commonBoundsFromLngLat(CRS_SOURCE_VIEWPORT, [-73, 39.5], [-71, 40.5]);
    const maskViewport = makeViewport({
      bounds,
      viewport: CRS_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048,
      border: 1
    }) as CRSViewport;

    const worldBounds = getViewportWorldBounds(maskViewport);
    const extent = commonExtentOf(maskViewport);
    const extentSize = Math.max(extent[2] - extent[0], extent[3] - extent[1]);

    // This is the round trip the masked layers' draw pass performs: world (lnglat)
    // corners -> the source projection's common space. It must recover the mask FBO's
    // exact extent, otherwise the mask texture is sampled with an offset/skew.
    const bottomLeft = CRS_SOURCE_VIEWPORT.projectFlat([worldBounds[0], worldBounds[1]]);
    const topRight = CRS_SOURCE_VIEWPORT.projectFlat([worldBounds[2], worldBounds[3]]);
    const exactError = Math.max(
      Math.abs(bottomLeft[0] - extent[0]),
      Math.abs(bottomLeft[1] - extent[1]),
      Math.abs(topRight[0] - extent[2]),
      Math.abs(topRight[1] - extent[3])
    );
    expect(exactError).toBeLessThan(1e-6 * extentSize);

    // The naive min/max-of-corners round trip (viewport.getBounds()) does NOT recover
    // the extent for a CRS: grid convergence skews the lnglat-axis-aligned bbox. This
    // guards against regressing getViewportWorldBounds to getBounds().
    const naiveBounds = maskViewport.getBounds();
    const naiveBottomLeft = CRS_SOURCE_VIEWPORT.projectFlat([naiveBounds[0], naiveBounds[1]]);
    const naiveTopRight = CRS_SOURCE_VIEWPORT.projectFlat([naiveBounds[2], naiveBounds[3]]);
    const naiveError = Math.max(
      Math.abs(naiveBottomLeft[0] - extent[0]),
      Math.abs(naiveBottomLeft[1] - extent[1]),
      Math.abs(naiveTopRight[0] - extent[2]),
      Math.abs(naiveTopRight[1] - extent[3])
    );
    expect(naiveError).toBeGreaterThan(1e-3 * extentSize);
  });

  test('Web Mercator: identical to viewport.getBounds()', () => {
    const bounds = commonBoundsFromLngLat(MERCATOR_SOURCE_VIEWPORT, [-73, 39.5], [-71, 40.5]);
    const maskViewport = makeViewport({
      bounds,
      viewport: MERCATOR_SOURCE_VIEWPORT,
      width: 2048,
      height: 2048,
      border: 1
    }) as WebMercatorViewport;

    expect(getViewportWorldBounds(maskViewport)).toEqual(maskViewport.getBounds());
  });
});
