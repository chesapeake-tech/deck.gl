// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {testInitializeLayer} from '@deck.gl/test-utils/vitest';
import {_CRSViewport as CRSViewport, COORDINATE_SYSTEM, log} from '@deck.gl/core';
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';
import {
  getCRSViewBoundsInCRSUnits,
  crsUnitsToCommonBounds
} from '@deck.gl/geo-layers/wms-layer/utils';
import {ImageSource} from '@loaders.gl/wms';
import type {GetImageParameters, ImageSourceMetadata, ImageType} from '@loaders.gl/loader-utils';
import {UTM18N} from '../core/viewports/crs-fixtures';

/** A no-network ImageSource stub: records every `getImage` call so tests can assert on the
 * GetMap parameters the layer built, without touching the network. */
class FakeWMSSource extends ImageSource {
  calls: GetImageParameters[] = [];

  async getMetadata(): Promise<ImageSourceMetadata> {
    return {name: 'fake', keywords: [], layers: []};
  }

  async getImage(parameters: GetImageParameters): Promise<ImageType> {
    this.calls.push(parameters);
    // A minimal stand-in for a decoded image; the layer only reads width/height off it.
    return {width: 10, height: 10} as unknown as ImageType;
  }
}

/** Mounts a WMSLayer against `viewport`, cancels its auto-scheduled initial `loadImage`
 * (debounced via `setTimeout`, which would otherwise race the manual call below), and
 * returns the layer plus its fake source and a `finalize` to clean up the LayerManager. */
function mountWMSLayer(viewport: CRSViewport, props: Partial<{srs: string}> = {}) {
  const source = new FakeWMSSource();
  const layer = new WMSLayer({
    id: 'test-wms',
    data: source,
    serviceType: 'wms',
    layers: ['test-layer'],
    ...props
  });
  const {finalize} = testInitializeLayer({
    layer,
    viewport,
    finalize: false,
    onError: err => expect(err).toBeFalsy()
  });
  clearTimeout((layer.state as any)._timeoutId);
  return {layer, source, finalize};
}

test('getCRSViewBoundsInCRSUnits#UTM view, axis-aligned, matches the analytic half-extent formula', () => {
  const width = 800;
  const height = 600;
  const zoom = 10;
  const longitude = -75;
  const latitude = 40;
  const viewport = new CRSViewport({crs: UTM18N, width, height, longitude, latitude, zoom});

  // For pitch/bearing 0, common-space bounds are exactly the projected center +/-
  // (size / 2) / scale — the same relationship WebMercatorViewport#getBounds relies on.
  const scale = Math.pow(2, zoom);
  const [centerX, centerY] = viewport.projectFlat([longitude, latitude]);
  const halfW = width / 2 / scale;
  const halfH = height / 2 / scale;
  const commonBounds: [number, number, number, number] = [
    centerX - halfW,
    Math.min(centerY - halfH, centerY + halfH),
    centerX + halfW,
    Math.max(centerY - halfH, centerY + halfH)
  ];

  // Un-normalize the analytic common-space bounds to CRS units by hand (independent of
  // the function under test) using extent/commonUnitsPerCRSUnit directly.
  const commonUnitsPerCRSUnit = 512 / (UTM18N.extent[2] - UTM18N.extent[0]);
  const expectedCRSBounds: [number, number, number, number] = [
    commonBounds[0] / commonUnitsPerCRSUnit + UTM18N.extent[0],
    commonBounds[1] / commonUnitsPerCRSUnit + UTM18N.extent[1],
    commonBounds[2] / commonUnitsPerCRSUnit + UTM18N.extent[0],
    commonBounds[3] / commonUnitsPerCRSUnit + UTM18N.extent[1]
  ];

  const actual = getCRSViewBoundsInCRSUnits(viewport as any);
  expect(actual[0]).toBeCloseTo(expectedCRSBounds[0], 6);
  expect(actual[1]).toBeCloseTo(expectedCRSBounds[1], 6);
  expect(actual[2]).toBeCloseTo(expectedCRSBounds[2], 6);
  expect(actual[3]).toBeCloseTo(expectedCRSBounds[3], 6);
});

test('getCRSViewBoundsInCRSUnits#UTM view, pitched/rotated, agrees with unproject+forward within float tolerance', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 6,
    pitch: 40,
    bearing: 25
  });

  // Reference route: unproject the 4 screen corners to lnglat, forward-project each
  // through the CRS transform, take the AABB (same core algorithm as
  // `crs-tileset-2d.ts#_getViewBoundsCRS`, without its extent fallback).
  const corners = [
    [0, 0],
    [800, 0],
    [0, 600],
    [800, 600]
  ].map(pixel => viewport.unproject(pixel));
  const xs = corners.map(c => UTM18N.transform.forward([c[0], c[1]])[0]);
  const ys = corners.map(c => UTM18N.transform.forward([c[0], c[1]])[1]);
  const reference: [number, number, number, number] = [
    Math.min(...xs),
    Math.min(...ys),
    Math.max(...xs),
    Math.max(...ys)
  ];

  const actual = getCRSViewBoundsInCRSUnits(viewport as any);
  // Both routes should agree closely (the analytic UTM forward/inverse round-trips
  // exactly); the common-space route is expected to be at least as precise, not less.
  expect(actual[0]).toBeCloseTo(reference[0], 3);
  expect(actual[1]).toBeCloseTo(reference[1], 3);
  expect(actual[2]).toBeCloseTo(reference[2], 3);
  expect(actual[3]).toBeCloseTo(reference[3], 3);
});

test('crsUnitsToCommonBounds#known-answer normalization matching the boundsCommon formula', () => {
  const crs = {
    extent: [100, 200, 600, 700] as [number, number, number, number],
    commonUnitsPerCRSUnit: 2
  };
  const bounds: [number, number, number, number] = [150, 250, 550, 650];
  expect(crsUnitsToCommonBounds(bounds, crs)).toEqual([
    (150 - 100) * 2,
    (250 - 200) * 2,
    (550 - 100) * 2,
    (650 - 200) * 2
  ]);
});

test('WMSLayer#CRS view with matching srs requests an exact CRS-unit bbox and positions via CARTESIAN', async () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  const {layer, source, finalize} = mountWMSLayer(viewport, {srs: UTM18N.code});
  try {
    await layer.loadImage(viewport, 'test');

    expect(source.calls).toHaveLength(1);
    const request = source.calls[0];
    expect(request.crs).toBe(UTM18N.code);

    const expectedCRSBounds = getCRSViewBoundsInCRSUnits(viewport as any);
    expect(request.boundingBox).toEqual([
      [expectedCRSBounds[0], expectedCRSBounds[1]],
      [expectedCRSBounds[2], expectedCRSBounds[3]]
    ]);

    const expectedCommonBounds = crsUnitsToCommonBounds(expectedCRSBounds, viewport.crs);
    expect((layer.state as any).bounds).toEqual(expectedCommonBounds);
    expect((layer.state as any).boundsCoordinateSystem).toBe(COORDINATE_SYSTEM.CARTESIAN);

    const sublayer = layer.renderLayers() as any;
    expect(sublayer.props.coordinateSystem).toBe(COORDINATE_SYSTEM.CARTESIAN);
    expect(sublayer.props._imageCoordinateSystem).toBe(COORDINATE_SYSTEM.CARTESIAN);
    expect(sublayer.props.bounds).toEqual(expectedCommonBounds);
  } finally {
    finalize();
  }
});

test('WMSLayer#CRS view with srs "auto" defaults to the view CRS', async () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 400,
    height: 300,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  const {layer, source, finalize} = mountWMSLayer(viewport); // srs defaults to 'auto'
  try {
    await layer.loadImage(viewport, 'test');
    expect(source.calls[0].crs).toBe(UTM18N.code);
    expect((layer.state as any).boundsCoordinateSystem).toBe(COORDINATE_SYSTEM.CARTESIAN);
  } finally {
    finalize();
  }
});

test('WMSLayer#CRS view with a mismatched srs warns and falls back to LNGLAT bounds', async () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 400,
    height: 300,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  const warnSpy = vi.spyOn(log, 'warn');
  const {layer, source, finalize} = mountWMSLayer(viewport, {srs: 'EPSG:3857'});
  try {
    await layer.loadImage(viewport, 'test');

    expect(warnSpy).toHaveBeenCalled();
    const warnedMessage = warnSpy.mock.calls.map(call => String(call[0])).join('\n');
    expect(warnedMessage).toContain('EPSG:3857');
    expect(warnedMessage).toContain(UTM18N.code);

    // Falls back to the pre-existing LNGLAT-bounds positioning rather than an exact rect
    expect(source.calls[0].crs).toBe('EPSG:3857');
    expect((layer.state as any).boundsCoordinateSystem).toBeUndefined();
    expect((layer.state as any).bounds).toEqual(viewport.getBounds());
  } finally {
    warnSpy.mockRestore();
    finalize();
  }
});

test('WMSLayer#CRS view mismatch warning only fires once per srs/crs combination', async () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 400,
    height: 300,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  const warnSpy = vi.spyOn(log, 'warn');
  const {layer, finalize} = mountWMSLayer(viewport, {srs: 'EPSG:3857'});
  try {
    await layer.loadImage(viewport, 'first');
    await layer.loadImage(viewport, 'second');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  } finally {
    warnSpy.mockRestore();
    finalize();
  }
});
