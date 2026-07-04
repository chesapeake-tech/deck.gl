// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {
  normalizeTileMatrixSet,
  selectTileMatrix,
  getTileBoundsCRS,
  getTileIndicesInBounds,
  getTileIndexAtPoint
} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import {makeWorldCRS84Quad512, makeUTM18NTms, UTM_EXTENT} from './tms-fixtures';

test('normalizeTileMatrixSet#cellSize passthrough and spans', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(3));
  expect(tms.tileMatrices).toHaveLength(3);
  expect(tms.tileMatrices[0].cellSize).toBe(0.3515625);
  expect(tms.tileMatrices[0].cornerOfOrigin).toBe('topLeft');
  expect(tms.tileMatrices[0].tileSpanX).toBe(180); // 0.3515625 * 512
  expect(tms.tileMatrices[1].tileSpanX).toBe(90);
});

test('normalizeTileMatrixSet#scaleDenominator fallback', () => {
  // Official WorldCRS84Quad level 0 (256px): sd 279541132.0143589 -> 0.703125 deg/px
  const tms = normalizeTileMatrixSet(
    {
      tileMatrices: [
        {
          id: '0',
          scaleDenominator: 279541132.0143589,
          pointOfOrigin: [-180, 90],
          tileWidth: 256,
          tileHeight: 256,
          matrixWidth: 2,
          matrixHeight: 1
        }
      ]
    },
    {metersPerUnit: 111319.49079327358}
  );
  expect(tms.tileMatrices[0].cellSize).toBeCloseTo(0.703125, 9);
});

test('normalizeTileMatrixSet#validation', () => {
  expect(() => normalizeTileMatrixSet({tileMatrices: []})).toThrow();
  // missing cellSize and scaleDenominator
  expect(() =>
    normalizeTileMatrixSet({
      tileMatrices: [
        {
          id: '0',
          pointOfOrigin: [0, 0],
          tileWidth: 256,
          tileHeight: 256,
          matrixWidth: 1,
          matrixHeight: 1
        }
      ]
    })
  ).toThrow();
  // wrong order (fine before coarse)
  const wrongOrder = makeWorldCRS84Quad512(2);
  wrongOrder.tileMatrices.reverse();
  expect(() => normalizeTileMatrixSet(wrongOrder)).toThrow();
});

test('selectTileMatrix#matching and clamping', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(4));
  const c0 = tms.tileMatrices[0].cellSize;
  // exact matches
  expect(selectTileMatrix(tms, c0)).toBe(0);
  expect(selectTileMatrix(tms, c0 / 4)).toBe(2);
  // slightly finer than halfway (in log space) rounds to the finer level
  expect(selectTileMatrix(tms, c0 / 2 ** 1.6)).toBe(2);
  // slightly coarser than halfway rounds to the coarser level
  expect(selectTileMatrix(tms, c0 / 2 ** 1.4)).toBe(1);
  // out of range clamps
  expect(selectTileMatrix(tms, c0 * 100)).toBe(0);
  expect(selectTileMatrix(tms, c0 / 1e6)).toBe(3);
});

test('getTileBoundsCRS#topLeft origin', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(2));
  expect(getTileBoundsCRS(tms.tileMatrices[0], 0, 0)).toEqual([-180, -90, 0, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[0], 1, 0)).toEqual([0, -90, 180, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[1], 0, 0)).toEqual([-180, 0, -90, 90]);
  expect(getTileBoundsCRS(tms.tileMatrices[1], 3, 1)).toEqual([90, -90, 180, 0]);
});

test('getTileBoundsCRS#bottomLeft origin', () => {
  const tms = normalizeTileMatrixSet({
    tileMatrices: [
      {
        id: '0',
        cellSize: 0.3515625,
        pointOfOrigin: [-180, -90],
        cornerOfOrigin: 'bottomLeft',
        tileWidth: 512,
        tileHeight: 512,
        matrixWidth: 2,
        matrixHeight: 1
      }
    ]
  });
  expect(getTileBoundsCRS(tms.tileMatrices[0], 0, 0)).toEqual([-180, -90, 0, 90]);
});

test('getTileIndicesInBounds#intersection and clamping', () => {
  const tms = normalizeTileMatrixSet(makeWorldCRS84Quad512(2));
  const tm1 = tms.tileMatrices[1]; // 4x2 tiles of 90 deg
  const indices = getTileIndicesInBounds(tm1, [-10, -10, 10, 10]);
  expect(indices).toHaveLength(4);
  expect(indices).toEqual(
    expect.arrayContaining([
      {x: 1, y: 0},
      {x: 2, y: 0},
      {x: 1, y: 1},
      {x: 2, y: 1}
    ])
  );
  // bounds larger than the matrix clamp to the full grid
  expect(getTileIndicesInBounds(tm1, [-1e4, -1e4, 1e4, 1e4])).toHaveLength(8);
  // disjoint bounds produce nothing
  expect(getTileIndicesInBounds(tm1, [200, -10, 300, 10])).toEqual([]);
});

test('getTileIndicesInBounds#non-square UTM matrix', () => {
  const tms = normalizeTileMatrixSet(makeUTM18NTms(1));
  const tm0 = tms.tileMatrices[0]; // 1 column x 14 rows
  expect(tm0.matrixHeight).toBe(14);
  // Whole zone
  expect(getTileIndicesInBounds(tm0, UTM_EXTENT)).toHaveLength(14);
});

test('getTileIndexAtPoint', () => {
  const tms = normalizeTileMatrixSet(makeUTM18NTms(1));
  const tm0 = tms.tileMatrices[0];
  // northing 4430000 (lat ~40): y = floor((9329005.18 - 4430000) / 667957.12) = 7
  expect(getTileIndexAtPoint(tm0, [500000, 4430000])).toEqual({x: 0, y: 7});
  // outside the matrix
  expect(getTileIndexAtPoint(tm0, [0, 4430000])).toBeNull();
});
