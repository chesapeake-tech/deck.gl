// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport, WebMercatorViewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {
  makeWebMercatorQuadTms,
  selectMercatorSourceZoom,
  buildWarpedTileMesh,
  MAX_MERCATOR_LATITUDE
} from '@deck.gl/geo-layers/warped-tile-layer/warp-mesh';
import {getTileBoundsCRS} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {osmTile2lngLat} from '@deck.gl/geo-layers/tileset-2d/utils';
import {UTM18N} from '../../core/viewports/crs-fixtures';
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
  // UTM 18N at lat 40: ground m/px = metersPerUnit * 2^-zoom.
  // commonUnitsPerCRSUnit = 512 / 667957.12, so at zoom 7 the view resolves
  // ~10.2 m/px ground; OSM 256px at lat 40 resolves C*cos(40)/(256*2^z) —
  // z should land at 12 (11.96 m/px) or 13; assert the formula's exact rounding.
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });
  const g = viewport.distanceScales.metersPerUnit[0] * 2 ** -7;
  const expected = Math.round(
    Math.log2((40075016.686 * Math.cos((40 * Math.PI) / 180)) / (256 * g))
  );
  expect(selectMercatorSourceZoom(viewport, 256)).toBe(expected);
  // zoomOffset shifts the result by exactly its value
  expect(selectMercatorSourceZoom(viewport, 256, 1)).toBe(expected + 1);
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
  // texCoords: v=0 at the image top, u/v span [0, 1]
  expect(mesh.attributes.texCoords.value[0]).toBe(0);
  expect(mesh.attributes.texCoords.value[1]).toBe(0);
  const last = rows * rows - 1;
  expect(mesh.attributes.texCoords.value[last * 2]).toBe(1);
  expect(mesh.attributes.texCoords.value[last * 2 + 1]).toBe(1);
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
