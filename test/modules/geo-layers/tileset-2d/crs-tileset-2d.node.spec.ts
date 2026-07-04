// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {
  _CRSTileset2D as CRSTileset2D,
  _getURLFromTemplate as getURLFromTemplate
} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {makeWorldCRS84Quad512, makeUTM18NTms} from './tms-fixtures';

const getTileData = () => Promise.resolve(null);

test('CRSTileset2D#4326 whole-world level 0', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(6)});
  // zoom 1: the 512-unit world spans 1024 px; crsUnitsPerPixel = 2^-1 / (512/360) = 0.3515625
  // = level 0 cellSize exactly
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: 1
  });
  tileset.update(viewport);
  const indices = tileset.selectedTiles!.map(t => t.index);
  expect(indices).toHaveLength(2);
  expect(indices).toEqual(
    expect.arrayContaining([expect.objectContaining({x: 0, y: 0, z: 0, tm: '0'})])
  );
  expect(indices).toEqual(
    expect.arrayContaining([expect.objectContaining({x: 1, y: 0, z: 0, tm: '0'})])
  );
  // metadata: bbox is exact lnglat for 4326
  const tile = tileset.selectedTiles!.find(t => (t.index as any).x === 0)!;
  expect(tile.bbox).toEqual({west: -180, south: -90, east: 0, north: 90});
  expect((tile as any).boundsCRS).toEqual([-180, -90, 0, 90]);
  // common space: extent [-180,-90,180,90] scaled by 512/360
  const k = 512 / 360;
  expect((tile as any).boundsCommon).toEqual([0, 0, 180 * k, 180 * k]);
});

test('CRSTileset2D#4326 deeper zoom selects deeper level', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(6)});
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 512,
    height: 512,
    longitude: -72,
    latitude: 40,
    zoom: 4
  });
  tileset.update(viewport);
  const zs = new Set(tileset.selectedTiles!.map(t => t.zoom));
  expect(zs).toEqual(new Set([3])); // level = deck zoom - 1 for 512px WorldCRS84Quad tiles
});

test('CRSTileset2D#UTM indices, metadata and parent chain', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeUTM18NTms(6)});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  // level 3 is an exact cellSize match for this TMS at zoom 3
  expect(new Set(tiles.map(t => t.zoom))).toEqual(new Set([3]));
  const matrixWidth3 = 8; // 2^3 columns at level 3
  for (const tile of tiles) {
    const {x, y, z} = tile.index as {x: number; y: number; z: number};
    expect(z).toBe(3);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(matrixWidth3);
    expect(y).toBeGreaterThanOrEqual(0);
    // bbox contains the tile's own CRS rect center
    const [minX, minY, maxX, maxY] = (tile as any).boundsCRS;
    const center = UTM18N.transform.inverse([(minX + maxX) / 2, (minY + maxY) / 2]);
    expect(center[0]).toBeGreaterThanOrEqual((tile.bbox as any).west - 1e-6);
    expect(center[0]).toBeLessThanOrEqual((tile.bbox as any).east + 1e-6);
  }
  // parent chain: one level up, matching TMS id
  const child = tiles[0];
  const parentIndex = tileset.getParentIndex(child.index);
  expect(parentIndex.z).toBe(2);
  expect((parentIndex as any).tm).toBe('2');
});

test('CRSTileset2D#throws without a CRS viewport', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeWorldCRS84Quad512(2)});
  const fakeViewport = {zoom: 1, width: 100, height: 100, unproject: () => [0, 0]};
  expect(() =>
    tileset.getTileIndices({
      viewport: fakeViewport as any,
      minZoom: undefined,
      maxZoom: undefined,
      zRange: null
    })
  ).toThrow(/CRS view/);
});

test('CRSTileset2D#minZoom/maxZoom clamp the level', () => {
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: makeWorldCRS84Quad512(6),
    maxZoom: 1,
    minZoom: 0
  });
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 512,
    height: 512,
    longitude: -72,
    latitude: 40,
    zoom: 6
  });
  tileset.update(viewport);
  expect(new Set(tileset.selectedTiles!.map(t => t.zoom))).toEqual(new Set([1]));
});

test('CRSTileset2D#url template with {tm}', () => {
  const url = getURLFromTemplate('https://example.com/{tm}/{x}/{y}.png', {
    index: {x: 3, y: 1, z: 2, tm: '2'} as any,
    id: '3-1-2'
  });
  expect(url).toBe('https://example.com/2/3/1.png');
});
