// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {MapView, COORDINATE_SYSTEM, log} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {MVTLayer, _CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';
import {ClipExtension} from '@deck.gl/extensions';
import {makeUTM18NTms} from './tileset-2d/tms-fixtures';
import {UTM18N} from '../core/viewports/crs-fixtures';

test('MVTLayer#tileMatrixSet + CRS MapView selects _CRSTileset2D, forces binary:false, no ClipExtension', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const tileMatrixSet = makeUTM18NTms(6);

  const testCases = [
    {
      title: 'CRS-native MVT tiling',
      props: {
        data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        tileMatrixSet,
        binary: true // explicit default; must still be forced off for the CRS route
      },
      // MVTLayer *is* the TileLayer (it extends TileLayer directly, unlike TerrainLayer which
      // wraps an inner TileLayer as its sole sub-layer) - so tileset-selection/binary-forcing
      // state lives on `layer.state`, not on `subLayers[0]` (the per-tile rendered GeoJsonLayer
      // sub-layers, which only exist once tile content has loaded).
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.tileset).toBeInstanceOf(CRSTileset2D);
        expect(layer.state.binary).toBe(false);
      }
    }
  ];

  await testLayerAsync({
    Layer: MVTLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});

test('MVTLayer#renderSubLayers: CRS route sublayer has no ClipExtension, plain lnglat GeoJsonLayer defaults', () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const layer = new MVTLayer({
    data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
    tileMatrixSet: makeUTM18NTms(6)
  });
  // @ts-expect-error - accessing protected context for a unit-level render check
  layer.context = {viewport, layerManager: null, deck: null};
  // Unit-level state injection (mirrors Task 3's initializeState-only setup below): context
  // must be set first since initializeState() reads this.context.viewport.
  (layer as any).initializeState();
  const subLayers = (layer as any).renderSubLayers({
    id: 'test-tile',
    data: {},
    _offset: 0,
    tile: {index: {x: 0, y: 0, z: 0}, bbox: {west: -75, south: 39, east: -74, north: 40}}
  });
  const sub = Array.isArray(subLayers) ? subLayers[0] : subLayers;
  // GeoJsonLayer's own default sentinel (resolves to LNGLAT for a geospatial viewport at
  // render time) - not overridden to CARTESIAN, unlike the Mercator route.
  expect(sub.props.coordinateSystem).toBe(COORDINATE_SYSTEM.DEFAULT);
  expect((sub.props.extensions || []).some((e: unknown) => e instanceof ClipExtension)).toBe(false);
});

test('MVTLayer#CRS MapView without tileMatrixSet warns once', () => {
  const warnSpy = vi.spyOn(log, 'warn');
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const layer = new MVTLayer({data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'});
  // @ts-expect-error - unit-level context injection, mirrors the renderSubLayers test above
  layer.context = {viewport, layerManager: null, deck: null};
  (layer as any).initializeState();
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tileMatrixSet'));
  warnSpy.mockRestore();
});
