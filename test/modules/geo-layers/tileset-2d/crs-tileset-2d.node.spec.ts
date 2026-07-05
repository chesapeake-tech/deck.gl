// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {
  _CRSTileset2D as CRSTileset2D,
  _getURLFromTemplate as getURLFromTemplate
} from '@deck.gl/geo-layers';
import {
  getTileIndicesInBounds,
  normalizeTileMatrixSet
} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {makeWorldCRS84Quad512, makeUTM18NTms, GIBS_500M_TMS} from './tms-fixtures';

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

function crsIndices(tileset: CRSTileset2D, viewport: CRSViewport) {
  return tileset.getTileIndices({
    viewport: viewport as any,
    minZoom: undefined,
    maxZoom: undefined,
    zRange: null
  }) as {x: number; y: number; z: number; tm: string}[];
}

test('CRSTileset2D#pitched view selects per-region LOD (far coarser, near finer)', () => {
  const tms = makeUTM18NTms(9);
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: tms});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 6,
    pitch: 65
  });
  const indices = crsIndices(tileset, viewport);
  const zs = indices.map(i => i.z);
  // Known answer: near band at the view-center level 6, far band one level coarser
  expect([...new Set(zs)].sort((a, b) => a - b)).toEqual([5, 6]);
  expect(Math.min(...zs)).toBe(5);
  expect(Math.max(...zs)).toBe(6);
  expect(indices.length).toBe(20);
  // every tile carries its level's TMS id (not the view-center level's)
  for (const i of indices) {
    expect(i.tm).toBe(String(i.z));
  }

  // Pre-change behavior: fill the whole view AABB at the single finest level.
  const ntms = normalizeTileMatrixSet(tms, {metersPerUnit: 1});
  const corners = [
    [0, 0],
    [viewport.width, 0],
    [0, viewport.height],
    [viewport.width, viewport.height]
  ]
    .map(p => viewport.unproject(p))
    .map(ll => UTM18N.transform.forward([ll[0], ll[1]]));
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const p of corners) {
    a = Math.min(a, p[0]);
    b = Math.min(b, p[1]);
    c = Math.max(c, p[0]);
    d = Math.max(d, p[1]);
  }
  const singleLevel = getTileIndicesInBounds(ntms.tileMatrices[6], [a, b, c, d]).length;
  expect(singleLevel).toBe(49);
  expect(indices.length).toBeLessThan(singleLevel * 0.5);
});

test('CRSTileset2D#unpitched view is byte-identical to the single-level path', () => {
  const tms = makeUTM18NTms(9);
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: tms});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 6,
    pitch: 0
  });
  const indices = crsIndices(tileset, viewport);
  expect(new Set(indices.map(i => i.z))).toEqual(new Set([6]));
  // matches a direct single-level fill of the view AABB
  const ntms = normalizeTileMatrixSet(tms, {metersPerUnit: 1});
  const corners = [
    [0, 0],
    [viewport.width, 0],
    [0, viewport.height],
    [viewport.width, viewport.height]
  ]
    .map(p => viewport.unproject(p))
    .map(ll => UTM18N.transform.forward([ll[0], ll[1]]));
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const p of corners) {
    a = Math.min(a, p[0]);
    b = Math.min(b, p[1]);
    c = Math.max(c, p[0]);
    d = Math.max(d, p[1]);
  }
  const expected = getTileIndicesInBounds(ntms.tileMatrices[6], [a, b, c, d]).map(({x, y}) => ({
    x,
    y,
    z: 6,
    tm: '6'
  }));
  expect(indices).toEqual(expected);
});

test('CRSTileset2D#pitched view with minZoom deeper than the TMS clamps instead of crashing', () => {
  // Regression: a minZoom past the last tileMatrices index (with an extent, so the flood guard
  // passes) used to reach tileMatrices[minZoom] -> undefined -> TypeError inside the band
  // traversal. The band floor must clamp to the (already array-clamped) selected level.
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: GIBS_500M_TMS, // 8 levels: 0..7
    minZoom: 20,
    extent: [-90, 20, -50, 60]
  });
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 800,
    height: 600,
    longitude: -70,
    latitude: 40,
    zoom: 3,
    pitch: 60
  });
  tileset.update(viewport); // must not throw
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  // everything clamps to the deepest real level
  expect(new Set(tiles.map(t => t.zoom))).toEqual(new Set([7]));
});

test('CRSTileset2D#pitched bands apply zoomOffset', () => {
  const makeTiles = (zoomOffset: number) => {
    const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeUTM18NTms(9), zoomOffset});
    const viewport = new CRSViewport({
      crs: UTM18N,
      width: 800,
      height: 600,
      longitude: -72,
      latitude: 40,
      zoom: 6,
      pitch: 65
    });
    tileset.update(viewport);
    return tileset.selectedTiles!;
  };
  const levelsOf = (tiles: {zoom: number}[]) =>
    [...new Set(tiles.map(t => t.zoom))].sort((a, b) => a - b);
  expect(levelsOf(makeTiles(0))).toEqual([5, 6]);
  // +1 zoomOffset shifts every band (near AND far) one level finer
  expect(levelsOf(makeTiles(1))).toEqual([6, 7]);
});

test('CRSTileset2D#pitched view keeps the minZoom flood guard (no extent -> no tiles)', () => {
  // A pitched view far above minZoom: without an extent, the guard must still return nothing
  // (banding must not become a backdoor around the flood guard).
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: GIBS_500M_TMS,
    minZoom: 5
  });
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: Math.log2(0.703125 / 0.5625),
    pitch: 60
  });
  tileset.update(viewport);
  expect(tileset.selectedTiles).toEqual([]);
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

test('CRSTileset2D#real GIBS grid: overflow clamping, root parent, bbox domain clamp', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: GIBS_500M_TMS});
  // zoom log2(0.703125/0.5625): crsUnitsPerPixel === GIBS level-0 cellSize exactly
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: Math.log2(0.703125 / 0.5625)
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.map(t => t.index)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({x: 0, y: 0, z: 0, tm: '0'}),
      expect.objectContaining({x: 1, y: 0, z: 0, tm: '0'})
    ])
  );
  expect(tiles).toHaveLength(2);
  const tile = tiles.find(t => (t.index as any).x === 0)!;
  // exact grid rect overflows the CRS extent (row past the south pole)...
  const boundsCRS = (tile as any).boundsCRS;
  expect(boundsCRS[1]).toBeCloseTo(-198, 6);
  // ...and the lnglat bbox must cover the TRUE tile span: 4326's linear inverse is
  // exact beyond the extent, and raster sublayers stretch imagery across the bbox —
  // clamping it would render overflow tiles distorted
  expect((tile.bbox as any).west).toBeCloseTo(-180, 6);
  expect((tile.bbox as any).south).toBeCloseTo(-198, 6);
  expect((tile.bbox as any).east).toBeCloseTo(108, 6);
  expect((tile.bbox as any).north).toBeCloseTo(90, 6);
  // the root level has no parent: index is returned unchanged
  const parent = tileset.getParentIndex(tile.index);
  expect(parent).toEqual(tile.index);
});

test('CRSTileset2D#getParentIndex across non-integer level ratios', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: GIBS_500M_TMS});
  // select level 2 (5x3): crsUnitsPerPixel === level-2 cellSize exactly
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 512,
    height: 512,
    longitude: 150,
    latitude: -60,
    zoom: Math.log2(0.703125 / 0.140625)
  });
  tileset.update(viewport);
  const tiles = tileset.selectedTiles!;
  expect(tiles.length).toBeGreaterThan(0);
  for (const tile of tiles) {
    expect(tile.zoom).toBe(2);
    const parent = tileset.getParentIndex(tile.index) as any;
    expect(parent.z).toBe(1);
    expect(parent.tm).toBe('1');
    // parent is inside the 3x2 level-1 matrix even when the child center
    // falls outside it (grids overflow the extent unevenly between levels)
    expect(parent.x).toBeGreaterThanOrEqual(0);
    expect(parent.x).toBeLessThan(3);
    expect(parent.y).toBeGreaterThanOrEqual(0);
    expect(parent.y).toBeLessThan(2);
  }
});

test('CRSTileset2D#minZoom without extent returns no tiles instead of the whole grid', () => {
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: GIBS_500M_TMS,
    minZoom: 5
  });
  // Far above level 5: would select level 0
  const viewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: Math.log2(0.703125 / 0.5625)
  });
  tileset.update(viewport);
  expect(tileset.selectedTiles).toEqual([]);
});

test('CRSTileset2D#view CRS swap flushes stale tiles', () => {
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: makeUTM18NTms(6)});
  const utmViewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  tileset.update(utmViewport);
  const before = tileset.selectedTiles![0];
  // Same tileset, different view CRS (mismatch is warned; tiles must be recreated
  // because cached bbox/boundsCommon metadata is meaningless under the new CRS)
  const degViewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  tileset.update(degViewport);
  // A mismatched TMS/CRS combination legitimately indexes nothing; the important
  // part is that the stale cache is gone
  expect(tileset.selectedTiles).not.toContain(before);

  // Swapping back re-selects the same {x, y, z} but must create a fresh tile
  // (the old one carried metadata computed under the swapped-in CRS rules)
  const utmViewport2 = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  tileset.update(utmViewport2);
  const again = tileset.selectedTiles!.find(t => t.id === before.id)!;
  expect(again).toBeDefined();
  expect(again).not.toBe(before);
});

test('CRSTileset2D#bbox falls back to extent-clamped corners when inverse is non-finite', () => {
  // A curved-CRS-like transform whose inverse is undefined outside the extent
  const FUSSY_CRS = {
    code: 'TEST:1',
    units: 'degrees' as const,
    extent: [-180, -90, 180, 90] as [number, number, number, number],
    transform: {
      forward: (lnglat: [number, number]): [number, number] => [lnglat[0], lnglat[1]],
      inverse: (xy: [number, number]): [number, number] =>
        xy[1] < -90 || xy[1] > 90 || xy[0] < -180 || xy[0] > 180 ? [NaN, NaN] : [xy[0], xy[1]]
    }
  };
  const tileset = new CRSTileset2D({getTileData, tileMatrixSet: GIBS_500M_TMS});
  const viewport = new CRSViewport({
    crs: FUSSY_CRS,
    width: 1024,
    height: 512,
    longitude: 0,
    latitude: 0,
    zoom: Math.log2(0.703125 / 0.5625)
  });
  tileset.update(viewport);
  const tile = tileset.selectedTiles!.find(t => (t.index as any).x === 0)!;
  // boundsCRS keeps the true overflowing rect...
  expect((tile as any).boundsCRS[1]).toBeCloseTo(-198, 6);
  // ...but with a non-finite inverse the bbox corner falls back to the extent (no NaN)
  expect((tile.bbox as any).south).toBeCloseTo(-90, 6);
  expect(Number.isFinite((tile.bbox as any).west)).toBe(true);
  expect(Number.isFinite((tile.bbox as any).east)).toBe(true);
});

test('CRSTileset2D#negative minZoom is clamped to 0 (ancestor-walk loop safety)', () => {
  const tileset = new CRSTileset2D({
    getTileData,
    tileMatrixSet: GIBS_500M_TMS,
    minZoom: -5
  });
  // getParentIndex returns the root index unchanged at level 0, so the base class's
  // `getTileZoom(index) > _minZoom` ancestor walk must never see a negative floor
  expect((tileset as any)._minZoom).toBe(0);
});
