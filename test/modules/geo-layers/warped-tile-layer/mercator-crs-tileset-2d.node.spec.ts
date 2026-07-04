// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {lngLatToWorld} from '@math.gl/web-mercator';
import {MercatorCRSTileset2D} from '@deck.gl/geo-layers/warped-tile-layer/mercator-crs-tileset-2d';
import {selectMercatorSourceZoom} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';

const getTileData = () => Promise.resolve(null);

function makeUTMViewport(zoom: number) {
  return new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom
  });
}

test('MercatorCRSTileset2D#selects the ground-resolution-matched OSM level', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = makeUTMViewport(7);
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  const expectedZ = selectMercatorSourceZoom(viewport, 256);
  expect(new Set(tiles.map(t => t.zoom))).toEqual(new Set([expectedZ]));
  // every selected tile's lnglat bbox intersects the viewport's lnglat bounds
  const [west, south, east, north] = viewport.getBounds();
  for (const tile of tiles) {
    const bbox = tile.bbox as {west: number; south: number; east: number; north: number};
    expect(bbox.west).toBeLessThan(east);
    expect(bbox.east).toBeGreaterThan(west);
    expect(bbox.south).toBeLessThan(north);
    expect(bbox.north).toBeGreaterThan(south);
  }
});

test('MercatorCRSTileset2D#metadata: exact OSM bbox and world-unit bounds', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = makeUTMViewport(7);
  tileset.update(viewport);
  const tile = tileset.selectedTiles![0];
  const {x, y, z} = tile.index as {x: number; y: number; z: number};
  const [west, north] = osmTile2lngLat(x, y, z);
  const [east, south] = osmTile2lngLat(x + 1, y + 1, z);
  const bbox = tile.bbox as {west: number; south: number; east: number; north: number};
  expect(bbox.west).toBeCloseTo(west, 6);
  expect(bbox.north).toBeCloseTo(north, 6);
  expect(bbox.east).toBeCloseTo(east, 6);
  expect(bbox.south).toBeCloseTo(south, 6);
  const boundsWorld = (tile as any).boundsWorld as [number, number, number, number];
  const [wx, ny] = lngLatToWorld([west, north]);
  expect(boundsWorld[0]).toBeCloseTo(wx, 6);
  expect(boundsWorld[3]).toBeCloseTo(ny, 6);
});

test('MercatorCRSTileset2D#quadtree parent and root guard', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  tileset.update(makeUTMViewport(7));
  const tile = tileset.selectedTiles![0];
  const {x, y, z} = tile.index as {x: number; y: number; z: number};
  expect(tileset.getParentIndex(tile.index)).toEqual({x: x >> 1, y: y >> 1, z: z - 1});
  expect(tileset.getParentIndex({x: 0, y: 0, z: 0})).toEqual({x: 0, y: 0, z: 0});
});

test('MercatorCRSTileset2D#throws without a CRS viewport', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const fakeViewport = {zoom: 4, width: 100, height: 100, unproject: () => [0, 0]};
  expect(() =>
    tileset.getTileIndices({
      viewport: fakeViewport as any,
      minZoom: undefined,
      maxZoom: undefined,
      zRange: null
    })
  ).toThrow(/CRS view/);
});

test('MercatorCRSTileset2D#maxZoom clamps the source level; negative minZoom clamps to 0', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256, maxZoom: 5, minZoom: -3});
  tileset.update(makeUTMViewport(10)); // would select a deep source level
  expect(new Set(tileset.selectedTiles!.map(t => t.zoom))).toEqual(new Set([5]));
  expect((tileset as any)._minZoom).toBe(0);
});

test('MercatorCRSTileset2D#4326 view: whole-world latitude clamp', () => {
  // A whole-world 4326 view sees latitudes beyond the Mercator domain; corner
  // clamping must produce the full valid grid rather than NaN indices
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: 0.5
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) {
    const {x, y, z} = tile.index as {x: number; y: number; z: number};
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2 ** z);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(2 ** z);
  }
});
