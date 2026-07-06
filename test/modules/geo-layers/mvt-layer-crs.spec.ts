// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, COORDINATE_SYSTEM, WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {
  MVTLayer,
  _CRSTileset2D as CRSTileset2D,
  _Tileset2D as Tileset2D,
  _MercatorCRSTileset2D as MercatorCRSTileset2D
} from '@deck.gl/geo-layers';
import {selectMercatorSourceZoom} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {transform} from '@deck.gl/geo-layers/mvt-layer/coordinate-transform';
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

// The universal, motivating case (review Finding 2): a classic Mercator-pyramid vector-tile
// source (no `tileMatrixSet` - e.g. Esri's "Ocean Reference" MVT service, or any public XYZ MVT
// endpoint) used inside a CRS `MapView`. Before this fix, `_getTilesetClass()` fell through to
// the default `Tileset2D`, which indexes tiles by treating the CRS viewport's zoom/bounds as if
// they were Mercator - meaningless for a UTM view. `MVTLayer._getTilesetClass()` now routes this
// combination through `MercatorCRSTileset2D` (the same class `_WarpedTileLayer` already uses to
// reproject a CRS view into Mercator source space), automatically - no warning, no opt-in prop.
test('MVTLayer#Mercator-pyramid MVT source (no tileMatrixSet) in a CRS MapView selects MercatorCRSTileset2D', async () => {
  const view = new MapView({crs: UTM18N});
  const viewState = {longitude: -72, latitude: 40, zoom: 5};
  const viewport = view.makeViewport({width: 800, height: 600, viewState})!;

  const testCases = [
    {
      title: 'Mercator-pyramid MVT auto-route',
      props: {
        data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
        binary: true // explicit default; must still be forced off (same as the tileMatrixSet case)
      },
      onAfterUpdate: ({layer}: {layer: any}) => {
        const {tileset} = layer.state;
        expect(tileset).toBeInstanceOf(MercatorCRSTileset2D);
        expect(tileset).not.toBeInstanceOf(CRSTileset2D);
        expect(layer.state.binary).toBe(false);

        // Known-answer tile level: the same ground-resolution match MercatorCRSTileset2D's own
        // spec proves independently (mercator-crs-tileset-2d.node.spec.ts) - verified here
        // through the real MVTLayer/TileLayer wiring, not the tileset class directly.
        const expectedZ = selectMercatorSourceZoom(viewport, layer.props.tileSize ?? 512);
        const tiles = tileset.selectedTiles;
        expect(tiles.length).toBeGreaterThan(0);
        expect(new Set(tiles.map((t: any) => t.zoom))).toEqual(new Set([expectedZ]));
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

test('MVTLayer#_getTilesetClass: Mercator view stays the default Tileset2D (byte-identical, no MercatorCRSTileset2D)', () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const layer = new MVTLayer({data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'});
  // @ts-expect-error - unit-level context injection, mirrors the renderSubLayers test above
  layer.context = {viewport, layerManager: null, deck: null};
  (layer as any).initializeState();
  expect((layer as any)._getTilesetClass()).toBe(Tileset2D);
  expect((layer as any)._getTilesetClass()).not.toBe(MercatorCRSTileset2D);
});

test('MVTLayer#Mercator-pyramid MVT source: features decode wgs84 using MercatorCRSTileset2D bbox, land at exact positions', () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 5}
  })!;

  const layer = new MVTLayer({data: 'https://example.com/tiles/{z}/{x}/{y}.mvt', tileSize: 512});
  // @ts-expect-error - unit-level context injection, mirrors the tests above
  layer.context = {viewport, layerManager: null, deck: null};
  (layer as any).initializeState();
  expect((layer as any)._getTilesetClass()).toBe(MercatorCRSTileset2D);

  // Real indexing: build the exact tileset class `_getTilesetClass()` selects, and let it
  // select real tiles for this viewport - not a fabricated x/y/z.
  const tileset = new MercatorCRSTileset2D({
    getTileData: () => Promise.resolve(null),
    tileSize: 512
  });
  tileset.update(viewport);
  const tile = tileset.selectedTiles![0];
  const {x, y, z} = tile.index as {x: number; y: number; z: number};

  // Known-answer bbox: closed-form OSM/Web-Mercator tile corner math, independent of the
  // tileset's own `getTileMetadata()` implementation.
  const [west, north] = osmTile2lngLat(x, y, z);
  const [east, south] = osmTile2lngLat(x + 1, y + 1, z);
  const bbox = tile.bbox as {west: number; south: number; east: number; north: number};
  expect(bbox.west).toBeCloseTo(west, 6);
  expect(bbox.north).toBeCloseTo(north, 6);
  expect(bbox.east).toBeCloseTo(east, 6);
  expect(bbox.south).toBeCloseTo(south, 6);

  // A tile-local point at the tile's center; the loader would hand MVTLayer exactly this shape
  // (`coordinates: 'local'`) before the wgs84 decode route reprojects it.
  const centerPoint = {
    type: 'Feature',
    properties: {},
    geometry: {type: 'Point', coordinates: [0.5, 0.5]}
  };
  (tile as any).content = [centerPoint];
  layer.state.tileset = {selectedTiles: [tile]} as any;
  (layer as any)._setWGS84PropertyForTiles();

  const decoded = (tile as any).dataInWGS84[0];
  const [actualLng, actualLat] = decoded.geometry.coordinates;

  // Expected position: the same generic tile-local -> lnglat transform (already exercised for
  // GlobeView/tileMatrixSet CRS content), fed the independently-computed closed-form bbox.
  const expected = transform(centerPoint.geometry, {west, north, east, south}, viewport);
  expect(actualLng).toBeCloseTo(expected.coordinates[0], 6);
  expect(actualLat).toBeCloseTo(expected.coordinates[1], 6);
});
