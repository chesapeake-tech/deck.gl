// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {
  makeWebMercatorQuadTms,
  selectMercatorSourceZoom,
  selectWarpSourceZoom,
  resolveWarpSource,
  buildWarpedTileMesh,
  estimateWarpMeshResolution,
  MAX_MERCATOR_LATITUDE
} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {getTileBoundsCRS, selectTileMatrix} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';
import {GIBS_500M_TMS} from '../tileset-2d/tms-fixtures';
import {normalizeCRS} from '@deck.gl/core/viewports/crs-utils';

test('makeWebMercatorQuadTms#matches OSM tile math', () => {
  const tms = makeWebMercatorQuadTms(256, 5);
  expect(tms.tileMatrices).toHaveLength(5);
  expect(tms.tileMatrices[0].matrixWidth).toBe(1);
  expect(tms.tileMatrices[3].matrixWidth).toBe(8);
  expect(tms.tileMatrices[0].cellSize).toBe(2); // 512 world units / 256 px
  // tile (x, y, z) world bounds agree with osmTile2lngLat corners
  for (const [x, y, z] of [
    [0, 0, 0],
    [2, 1, 2],
    [5, 9, 4]
  ]) {
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tms.tileMatrices[z], x, y);
    const [westWorldX, northWorldY] = lngLatToWorld(osmTile2lngLat(x, y, z));
    const [eastWorldX, southWorldY] = lngLatToWorld(osmTile2lngLat(x + 1, y + 1, z));
    expect(minX).toBeCloseTo(westWorldX, 6);
    expect(maxY).toBeCloseTo(northWorldY, 6);
    expect(maxX).toBeCloseTo(eastWorldX, 6);
    expect(minY).toBeCloseTo(southWorldY, 6);
  }
});

test('selectMercatorSourceZoom#reduces to the OSM rule for a Mercator view', () => {
  // The OSM path uses round(zoom + log2(512 / tileSize)); the ground-resolution
  // formula must reproduce it when the view itself is Web Mercator
  for (const zoom of [0, 3.4, 7, 12.7]) {
    for (const lat of [0, 40, 70]) {
      const viewport = new WebMercatorViewport({
        width: 800,
        height: 600,
        longitude: -72,
        latitude: lat,
        zoom
      });
      expect(selectMercatorSourceZoom(viewport, 256)).toBe(Math.round(zoom + Math.log2(512 / 256)));
      expect(selectMercatorSourceZoom(viewport, 512)).toBe(Math.round(zoom));
    }
  }
});

test('selectMercatorSourceZoom#UTM view known answer', () => {
  // UTM 18N at lat 40, zoom 7: ground resolution is metersPerUnit * 2^-zoom (~10.20 m/px).
  // Matching that against the OSM 256px pyramid's per-level resolution
  // C*cos(lat)/(256*2^z) (C = Earth's circumference in meters) and solving for z gives a
  // fractional level of ~13.52, which Math.round takes up to level 14 (not the
  // naively-eyeballed 12/13 the original derivation-in-place comment estimated).
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  expect(selectMercatorSourceZoom(viewport, 256)).toBe(14);
  // zoomOffset shifts the result by exactly its value
  expect(selectMercatorSourceZoom(viewport, 256, 1)).toBe(15);
});

test('buildWarpedTileMesh#exact vertices for a 4326 target', () => {
  // For the built-in EPSG:4326 CRS, common space is linear in lnglat, so mesh
  // vertices must equal worldToLngLat of the grid points, scaled by 512/360
  const crs = normalizeCRS('EPSG:4326');
  const tms = makeWebMercatorQuadTms(256, 4);
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[2], 1, 1);
  const mesh = buildWarpedTileMesh(boundsWorld, crs, 4);
  const rows = 5;
  expect(mesh.attributes.positions.value).toHaveLength(rows * rows * 3);
  expect(mesh.attributes.texCoords.value).toHaveLength(rows * rows * 2);
  expect(mesh.indices.value).toHaveLength(4 * 4 * 6);
  // corner vertex (i=0, j=0) is the tile's top-left: matches osmTile2lngLat(1,1,2)
  const k = 512 / 360;
  const [west, north] = osmTile2lngLat(1, 1, 2);
  const expectX = (west - -180) * k;
  const expectY = (north - -90) * k;
  expect(mesh.origin[0]).toBeCloseTo(expectX, 6);
  expect(mesh.origin[1]).toBeCloseTo(expectY, 6);
  // positions are origin-relative: vertex 0 is exactly [0, 0, 0]
  expect(mesh.attributes.positions.value[0]).toBeCloseTo(0, 6);
  expect(mesh.attributes.positions.value[1]).toBeCloseTo(0, 6);
  // texCoords: v=0 at the image top, u/v span the full [0, 1] with no tileSize given (no inset)
  expect(mesh.attributes.texCoords.value[0]).toBe(0);
  expect(mesh.attributes.texCoords.value[1]).toBe(0);
  const last = rows * rows - 1;
  expect(mesh.attributes.texCoords.value[last * 2]).toBe(1);
  expect(mesh.attributes.texCoords.value[last * 2 + 1]).toBe(1);
});

test('buildWarpedTileMesh#half-texel UV inset (seam gutter) leaves positions unchanged', () => {
  // Seam elimination: passing tileSize insets the UVs by half a texel so a triangle can't
  // sample past its tile's border texels. This is a knowing update of the pre-inset assertions
  // above — UVs now span [0.5/w, 1 - 0.5/w]; positions/indices are byte-identical to no-inset.
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 6);
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[4], 5, 6);
  const w = 256;
  const n = 4;
  const inset = buildWarpedTileMesh(boundsWorld, crs, n, {tileSize: w});
  const plain = buildWarpedTileMesh(boundsWorld, crs, n);
  const rows = n + 1;

  // UVs are remapped [0,1] -> [0.5/w, 1 - 0.5/w]
  const uv = inset.attributes.texCoords.value;
  expect(uv[0]).toBeCloseTo(0.5 / w, 9); // i=0
  expect(uv[1]).toBeCloseTo(0.5 / w, 9); // j=0
  const last = rows * rows - 1;
  expect(uv[last * 2]).toBeCloseTo(1 - 0.5 / w, 9); // i=n
  expect(uv[last * 2 + 1]).toBeCloseTo(1 - 0.5 / w, 9); // j=n
  // a mid vertex maps proportionally into the inset range
  const midU = 0.5 / w + (2 / n) * ((w - 1) / w);
  expect(uv[2 * 2]).toBeCloseTo(midU, 9); // vertex (i=2, j=0) u

  // positions and indices are exactly the same as the no-inset build (only UVs move)
  expect(inset.attributes.positions.value).toEqual(plain.attributes.positions.value);
  expect(inset.indices.value).toEqual(plain.indices.value);
  expect(inset.origin).toEqual(plain.origin);
});

/** Max edge-midpoint interpolation error (in screen px) of an N-grid mesh, measured against a
 * much finer exact build (4N) as the reference for the true warped edge midpoints. */
function actualMeshErrorPx(
  boundsWorld: [number, number, number, number],
  crs: ReturnType<typeof normalizeCRS>,
  n: number,
  pixelsPerCommonUnit: number
): number {
  const mesh = buildWarpedTileMesh(boundsWorld, crs, n);
  const rows = n + 1;
  const pos = mesh.attributes.positions.value;
  const P = (i: number, j: number) => [
    mesh.origin[0] + pos[(j * rows + i) * 3],
    mesh.origin[1] + pos[(j * rows + i) * 3 + 1]
  ];
  const ref = buildWarpedTileMesh(boundsWorld, crs, n * 4);
  const frows = n * 4 + 1;
  const fpos = ref.attributes.positions.value;
  const FP = (i: number, j: number) => [
    ref.origin[0] + fpos[(j * frows + i) * 3],
    ref.origin[1] + fpos[(j * frows + i) * 3 + 1]
  ];
  let maxDev = 0;
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i < n; i++) {
      const a = P(i, j);
      const b = P(i + 1, j);
      const mid = FP(4 * i + 2, 4 * j);
      maxDev = Math.max(maxDev, Math.hypot(mid[0] - (a[0] + b[0]) / 2, mid[1] - (a[1] + b[1]) / 2));
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i <= n; i++) {
      const a = P(i, j);
      const b = P(i, j + 1);
      const mid = FP(4 * i, 4 * j + 2);
      maxDev = Math.max(maxDev, Math.hypot(mid[0] - (a[0] + b[0]) / 2, mid[1] - (a[1] + b[1]) / 2));
    }
  }
  return maxDev * pixelsPerCommonUnit;
}

test('estimateWarpMeshResolution#adapts grid size to tile distortion, holding the 0.15px bound', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 20);
  const tileAt = (z: number): [number, number, number, number] => {
    const x = Math.floor(((-75 + 180) / 360) * 2 ** z);
    const y = Math.floor(2 ** z / 2); // equator row, centered on the UTM 18N meridian
    return getTileBoundsCRS(tms.tileMatrices[z], x, y);
  };

  // A source-level tile is displayed at a view scale matched to its ground resolution
  // (~2^(z-1) for 256px tiles). A deep, small tile (survey scale) is nearly affine -> coarse
  // grid; a shallow, large tile (continental) bows strongly -> fine grid.
  const lowDistortion = tileAt(9);
  const highDistortion = tileAt(6);
  const lowScale = 2 ** 8;
  const highScale = 2 ** 5;

  const nLow = estimateWarpMeshResolution(lowDistortion, crs, lowScale);
  const nHigh = estimateWarpMeshResolution(highDistortion, crs, highScale);
  // Known answers: low distortion picks the coarsest grid, high distortion a much finer one
  expect(nLow).toBe(4);
  expect(nHigh).toBe(16);
  expect(nLow).toBeLessThan(nHigh);

  // The ≤0.15px budget holds against the exact transform for each chosen grid size
  expect(actualMeshErrorPx(lowDistortion, crs, nLow, lowScale)).toBeLessThanOrEqual(0.15);
  expect(actualMeshErrorPx(highDistortion, crs, nHigh, highScale)).toBeLessThanOrEqual(0.15);
  // ...and the coarser grid really would have blown the budget on the high-distortion tile
  // (proving the finer choice was necessary, not gratuitous)
  expect(actualMeshErrorPx(highDistortion, crs, 4, highScale)).toBeGreaterThan(0.15);
});

test('estimateWarpMeshResolution#falls back to the finest grid when even 32 overshoots', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 20);
  // A shallow, continental tile spans far outside the UTM zone: distortion so extreme that no
  // grid in the set meets the budget, so the estimator returns the finest (32) as a best effort.
  const z = 2;
  const boundsWorld = getTileBoundsCRS(
    tms.tileMatrices[z],
    Math.floor(2 ** z / 2),
    Math.floor(2 ** z / 2)
  );
  expect(estimateWarpMeshResolution(boundsWorld, crs, 2 ** (z - 1))).toBe(32);
});

test('buildWarpedTileMesh#UTM vertices match the exact transform', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 12);
  // An OSM z=11 tile over the UTM 18N anchor (-75, 0 -> easting 500000)
  const z = 11;
  const scale = 2 ** z;
  const x = Math.floor(((-75 + 180) / 360) * scale);
  const y = Math.floor(scale / 2); // equator row
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[z], x, y);
  const n = 8;
  const mesh = buildWarpedTileMesh(boundsWorld, crs, n);
  // center vertex: recompute independently through the same chain
  const cxWorld = (boundsWorld[0] + boundsWorld[2]) / 2;
  const cyWorld = (boundsWorld[1] + boundsWorld[3]) / 2;
  const lnglat = worldToLngLat([cxWorld, cyWorld]);
  const utm = UTM18N.transform.forward([lnglat[0], lnglat[1]]);
  const k = 512 / (UTM18N.extent[2] - UTM18N.extent[0]);
  const expectX = (utm[0] - UTM18N.extent[0]) * k;
  const expectY = (utm[1] - UTM18N.extent[1]) * k;
  const rows = n + 1;
  const center = (n / 2) * rows + n / 2;
  expect(mesh.origin[0] + mesh.attributes.positions.value[center * 3]).toBeCloseTo(expectX, 5);
  expect(mesh.origin[1] + mesh.attributes.positions.value[center * 3 + 1]).toBeCloseTo(expectY, 5);
});

test('buildWarpedTileMesh#neighbor tiles share identical edge vertices (seams)', () => {
  const crs = normalizeCRS(UTM18N);
  const tms = makeWebMercatorQuadTms(256, 12);
  const z = 10;
  const x = 300;
  const y = 380;
  const n = 8;
  const rows = n + 1;
  const left = buildWarpedTileMesh(getTileBoundsCRS(tms.tileMatrices[z], x, y), crs, n);
  const right = buildWarpedTileMesh(getTileBoundsCRS(tms.tileMatrices[z], x + 1, y), crs, n);
  // left tile's right edge (i = n) equals right tile's left edge (i = 0), in absolute terms
  for (let j = 0; j <= n; j++) {
    const li = j * rows + n;
    const ri = j * rows + 0;
    const lxAbs = left.origin[0] + left.attributes.positions.value[li * 3];
    const rxAbs = right.origin[0] + right.attributes.positions.value[ri * 3];
    const lyAbs = left.origin[1] + left.attributes.positions.value[li * 3 + 1];
    const ryAbs = right.origin[1] + right.attributes.positions.value[ri * 3 + 1];
    // float32 relative-to-origin quantization only
    expect(Math.abs(lxAbs - rxAbs)).toBeLessThan(1e-5);
    expect(Math.abs(lyAbs - ryAbs)).toBeLessThan(1e-5);
  }
});

test('MAX_MERCATOR_LATITUDE export', () => {
  expect(MAX_MERCATOR_LATITUDE).toBeCloseTo(85.051129, 6);
});

test('resolveWarpSource#sourceTileMatrixSet without sourceCrs throws (units are undefined)', () => {
  // Silently treating a (e.g. meters-based) TMS as deck's 512-unit Mercator world would index
  // garbage — the pairing rule is enforced in both directions.
  expect(() => resolveWarpSource({tileSize: 512, sourceTileMatrixSet: GIBS_500M_TMS})).toThrow(
    /sourceTileMatrixSet requires sourceCrs/
  );
  expect(() => resolveWarpSource({tileSize: 512, sourceCrs: 'EPSG:4326'})).toThrow(
    /sourceTileMatrixSet is required/
  );
});

test('resolveWarpSource#default is the built-in Web-Mercator source (byte-equivalent)', () => {
  const source = resolveWarpSource({tileSize: 256});
  expect(source.isMercator).toBe(true);
  // TMS matches makeWebMercatorQuadTms exactly (same cellSizes / matrix dims)
  const expected = makeWebMercatorQuadTms(256, 23);
  expect(source.tms.tileMatrices).toHaveLength(expected.tileMatrices.length);
  expect(source.tms.tileMatrices[5].cellSize).toBe(expected.tileMatrices[5].cellSize);
  // toLngLat is worldToLngLat; fromLngLat clamps into the Mercator domain
  expect(source.toLngLat([256, 256])).toEqual(worldToLngLat([256, 256]));
  expect(source.fromLngLat([0, 100])[1]).toBeLessThan(source.fromLngLat([0, 85.051129])[1] + 1e-6);
  // a mesh built through the resolved source equals one built with no source option (default path)
  const crs = normalizeCRS(UTM18N);
  const boundsWorld = getTileBoundsCRS(source.tms.tileMatrices[10], 300, 380);
  const viaSource = buildWarpedTileMesh(boundsWorld, crs, 8, {sourceToLngLat: source.toLngLat});
  const viaDefault = buildWarpedTileMesh(boundsWorld, crs, 8);
  expect(viaSource.attributes.positions.value).toEqual(viaDefault.attributes.positions.value);
  expect(viaSource.origin).toEqual(viaDefault.origin);
});

test('resolveWarpSource#EPSG:4326 GIBS source warps into a UTM view with exact vertices', () => {
  // A 4326 source's tile coordinates ARE lnglat: the source->lnglat transform is the identity,
  // so a mesh vertex at source point p equals UTM.forward(p) in common space, exactly.
  const source = resolveWarpSource({
    tileSize: 512,
    sourceTileMatrixSet: GIBS_500M_TMS,
    sourceCrs: 'EPSG:4326'
  });
  expect(source.isMercator).toBe(false);
  expect(source.toLngLat([-72, 40])).toEqual([-72, 40]); // identity

  const crs = normalizeCRS(UTM18N);
  // GIBS level 4 tile (6, 2) spans lng [-72, -54], lat [36, 54] — over the UTM 18N anchor region
  const z = 4;
  const boundsSource = getTileBoundsCRS(source.tms.tileMatrices[z], 6, 2);
  expect(boundsSource[0]).toBeCloseTo(-72, 6); // west lng
  expect(boundsSource[3]).toBeCloseTo(54, 6); // north lat
  const n = 8;
  const mesh = buildWarpedTileMesh(boundsSource, crs, n, {sourceToLngLat: source.toLngLat});

  const k = 512 / (UTM18N.extent[2] - UTM18N.extent[0]);
  const toCommon = (lng: number, lat: number): [number, number] => {
    const utm = UTM18N.transform.forward([lng, lat]);
    return [(utm[0] - UTM18N.extent[0]) * k, (utm[1] - UTM18N.extent[1]) * k];
  };
  const rows = n + 1;
  const abs = (v: number) => [
    mesh.origin[0] + mesh.attributes.positions.value[v * 3],
    mesh.origin[1] + mesh.attributes.positions.value[v * 3 + 1]
  ];
  // top-left vertex (i=0, j=0) -> source (minX=-72, maxY=54) -> exact UTM
  const tl = toCommon(boundsSource[0], boundsSource[3]);
  expect(abs(0)[0]).toBeCloseTo(tl[0], 4);
  expect(abs(0)[1]).toBeCloseTo(tl[1], 4);
  // center vertex -> source tile center -> exact UTM
  const center = (n / 2) * rows + n / 2;
  const cc = toCommon(
    (boundsSource[0] + boundsSource[2]) / 2,
    (boundsSource[1] + boundsSource[3]) / 2
  );
  expect(abs(center)[0]).toBeCloseTo(cc[0], 4);
  expect(abs(center)[1]).toBeCloseTo(cc[1], 4);
});

test('selectWarpSourceZoom#default source reduces to selectMercatorSourceZoom', () => {
  const source = resolveWarpSource({tileSize: 256});
  for (const zoom of [3, 7, 11]) {
    const viewport = new CRSViewport({
      crs: UTM18N,
      width: 800,
      height: 600,
      longitude: -72,
      latitude: 40,
      zoom
    });
    expect(selectWarpSourceZoom(viewport as any, source, 256, 0)).toBe(
      selectMercatorSourceZoom(viewport, 256)
    );
  }
});

test('selectWarpSourceZoom#4326 source matches the source cellSize at the view center', () => {
  const source = resolveWarpSource({
    tileSize: 512,
    sourceTileMatrixSet: GIBS_500M_TMS,
    sourceCrs: 'EPSG:4326'
  });
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 2
  });
  // Independently reproduce the level: degrees-per-pixel at the view center, matched to the TMS.
  const a = viewport.unproject([400, 300]);
  const b = viewport.unproject([401, 300]);
  const degPerPixel = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const expected = selectTileMatrix(source.tms, degPerPixel);
  expect(selectWarpSourceZoom(viewport as any, source, 512, 0)).toBe(expected);
  expect(expected).toBe(7); // deepest GIBS level, this coarse source bottoms out here
});
