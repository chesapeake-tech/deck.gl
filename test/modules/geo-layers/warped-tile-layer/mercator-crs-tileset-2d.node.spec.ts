// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {lngLatToWorld} from '@math.gl/web-mercator';
import {MercatorCRSTileset2D} from '@deck.gl/geo-layers/warped-tile-layer/mercator-crs-tileset-2d';
import {
  selectMercatorSourceZoom,
  makeWebMercatorQuadTms,
  MAX_MERCATOR_LATITUDE
} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {getTileIndicesInBounds} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {GIBS_500M_TMS} from '../tileset-2d/tms-fixtures';

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

function getIndices(tileset: MercatorCRSTileset2D, viewport: CRSViewport) {
  return tileset.getTileIndices({
    viewport: viewport as any,
    minZoom: undefined,
    maxZoom: undefined,
    zRange: null
  });
}

test('MercatorCRSTileset2D#warps a non-Mercator (4326 GIBS) source in a UTM view', () => {
  const tileset = new MercatorCRSTileset2D({
    getTileData,
    tileSize: 512,
    sourceTileMatrixSet: GIBS_500M_TMS,
    sourceCrs: 'EPSG:4326'
  } as any);
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 3
  });
  const indices = getIndices(tileset, viewport);
  expect(indices.length).toBeGreaterThan(0);
  // GIBS 500m bottoms out at level 7; a UTM zoom-3 view resolves to that deepest level
  expect(new Set(indices.map(i => i.z))).toEqual(new Set([7]));

  // Metadata: boundsWorld is in the SOURCE units (degrees); for a 4326 source the lnglat bbox
  // equals it (identity source->lnglat). Index math is the shared tile-matrix-set code.
  tileset.update(viewport);
  // metadata is exact for any selected level-7 tile: bbox == boundsWorld (identity 4326 source)
  const anyTile = tileset.selectedTiles!.find(t => t.zoom === 7)!;
  const abw = (anyTile as any).boundsWorld as [number, number, number, number];
  const abbox = anyTile.bbox as {west: number; north: number; east: number; south: number};
  expect(abbox.west).toBeCloseTo(abw[0], 6);
  expect(abbox.north).toBeCloseTo(abw[3], 6);
  expect(abbox.east).toBeCloseTo(abw[2], 6);
  expect(abbox.south).toBeCloseTo(abw[1], 6);
  // the selected set covers the view center (-72, 40) — some tile contains it (within epsilon)
  const eps = 1e-6;
  const tile = tileset.selectedTiles!.find(t => {
    const b = t.bbox as {west: number; north: number; east: number; south: number};
    return b.west - eps <= -72 && b.east + eps >= -72 && b.south - eps <= 40 && b.north + eps >= 40;
  })!;
  expect(tile).toBeDefined();

  // Geometric (non-quadtree) parent — GIBS is not a quadtree, so this is not x>>1
  const parent = tileset.getParentIndex(tile.index) as {x: number; y: number; z: number};
  expect(parent.z).toBe(6);
  expect(parent.x).toBeGreaterThanOrEqual(0);
  expect(parent.x).toBeLessThan(GIBS_500M_TMS.tileMatrices[6].matrixWidth);
});

test('MercatorCRSTileset2D#pitched view selects per-region LOD (far coarser, near finer)', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7,
    pitch: 65
  });
  const indices = getIndices(tileset, viewport);
  const zs = indices.map(i => i.z);
  const levels = [...new Set(zs)].sort((a, b) => a - b);
  // Known answer: three levels span the pitched frustum, far field two levels coarser than near
  expect(levels).toEqual([12, 13, 14]);
  expect(Math.min(...zs)).toBe(12); // far band
  expect(Math.max(...zs)).toBe(14); // near band == the single view-center level
  expect(indices.length).toBe(40);

  // The pre-change behavior filled the whole view AABB at the single view-center level.
  // Reconstruct that count and confirm the banded selection is far below it.
  const z = selectMercatorSourceZoom(viewport, 256);
  expect(z).toBe(14);
  const corners = [
    [0, 0],
    [viewport.width, 0],
    [0, viewport.height],
    [viewport.width, viewport.height]
  ].map(p => viewport.unproject(p));
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const ll of corners) {
    const [wx, wy] = lngLatToWorld([
      Math.min(Math.max(ll[0], -180), 180),
      Math.min(Math.max(ll[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
    ]);
    a = Math.min(a, wx);
    b = Math.min(b, wy);
    c = Math.max(c, wx);
    d = Math.max(d, wy);
  }
  const singleLevel = getTileIndicesInBounds(makeWebMercatorQuadTms(256, 23).tileMatrices[z], [
    a,
    b,
    c,
    d
  ]).length;
  expect(singleLevel).toBe(272);
  expect(indices.length).toBeLessThan(singleLevel * 0.2);
});

test('MercatorCRSTileset2D#unpitched view is byte-identical to the single-level path', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7,
    pitch: 0
  });
  const indices = getIndices(tileset, viewport);
  // exactly one level (the view-center level), matching pre-change single-level behavior
  expect(new Set(indices.map(i => i.z))).toEqual(
    new Set([selectMercatorSourceZoom(viewport, 256)])
  );
  // and it equals a direct single-level fill of the view AABB
  const corners = [
    [0, 0],
    [viewport.width, 0],
    [0, viewport.height],
    [viewport.width, viewport.height]
  ].map(p => viewport.unproject(p));
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const ll of corners) {
    const [wx, wy] = lngLatToWorld([
      Math.min(Math.max(ll[0], -180), 180),
      Math.min(Math.max(ll[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
    ]);
    a = Math.min(a, wx);
    b = Math.min(b, wy);
    c = Math.max(c, wx);
    d = Math.max(d, wy);
  }
  const z = selectMercatorSourceZoom(viewport, 256);
  const expected = getTileIndicesInBounds(makeWebMercatorQuadTms(256, 23).tileMatrices[z], [
    a,
    b,
    c,
    d
  ]).map(({x, y}) => ({x, y, z}));
  expect(indices).toEqual(expected);
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

test('MercatorCRSTileset2D#view CRS swap flushes stale tiles', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  const viewport = makeUTMViewport(7);
  tileset.update(viewport);
  const before = tileset.selectedTiles![0];
  expect(before).toBeDefined();

  // Same tileset instance, different view CRS — cached tiles (and any mesh/metadata
  // memoized on them under the old CRS) must be dropped, not reused
  const degViewport = new CRSViewport({
    crs: 'EPSG:4326',
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  tileset.update(degViewport);
  expect(tileset.selectedTiles!.length).toBeGreaterThan(0);
  expect(tileset.selectedTiles).not.toContain(before);
  for (const tile of tileset.selectedTiles!) {
    const {x, y, z} = tile.index as {x: number; y: number; z: number};
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2 ** z);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(2 ** z);
  }

  // Swapping back re-selects the same {x, y, z} but must create a fresh tile object
  // (the old one may carry a mesh/metadata computed under the swapped-in CRS)
  const viewport2 = makeUTMViewport(7);
  tileset.update(viewport2);
  const again = tileset.selectedTiles!.find(t => t.id === before.id);
  expect(again).toBeDefined();
  expect(again).not.toBe(before);
});

test('MercatorCRSTileset2D#unbounded fallback stays bounded when fewer than 2 corners are finite', () => {
  const tileset = new MercatorCRSTileset2D({getTileData, tileSize: 256});
  // Simulates a steep-pitch view: only one corner (bottom-left) unprojects finitely,
  // the other three are beyond the horizon (NaN) — mirrors the mock-viewport pattern
  // used by the "#throws without a CRS viewport" test above
  const fakeViewport = {
    crs: UTM18N,
    width: 800,
    height: 600,
    zoom: 18,
    latitude: 40,
    distanceScales: {metersPerUnit: [1, 1, 1]},
    unproject: (pixel: number[]) => (pixel[0] === 0 && pixel[1] === 600 ? [-72, 40] : [NaN, NaN])
  };
  const indices = tileset.getTileIndices({
    viewport: fakeViewport as any,
    minZoom: undefined,
    maxZoom: undefined,
    zRange: null
  });
  // Without the fix, z would be selected from `zoom: 18` (up to the source pyramid's
  // deepest level) and bounds would still widen to the whole world -> up to 4^19 indices.
  // The fallback clamps z to a shallow level instead, bounding the whole-world case to 4^z.
  expect(indices.length).toBeGreaterThan(0);
  expect(indices.length).toBeLessThanOrEqual(4 ** 8);
  const z = indices[0].z;
  expect(z).toBeLessThanOrEqual(8);
  for (const {x, y, z: tz} of indices) {
    expect(tz).toBe(z);
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(2 ** z);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThan(2 ** z);
  }
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
