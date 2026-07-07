// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {selectBandLevel} from '@deck.gl/geo-layers/tileset-2d/pitched-lod';
import {selectTileMatrix} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';

/** A non-dyadic TMS (GIBS-style irregular cellSize progression: 10 -> 5 -> 3 -> 2, coarse to
 * fine), used to distinguish "zoomOffset as an index shift" (the fix) from "zoomOffset as a
 * resolution-scaling factor" (the pre-fix behavior) -- the two select the same level for a
 * dyadic (each level exactly half the last) pyramid, but not for this one. */
const NON_DYADIC_TMS: NormalizedTileMatrixSet = {
  tileMatrices: [10, 5, 3, 2].map((cellSize, i) => ({
    id: String(i),
    cellSize,
    pointOfOrigin: [0, 0],
    cornerOfOrigin: 'topLeft',
    tileWidth: 256,
    tileHeight: 256,
    matrixWidth: 1,
    matrixHeight: 1,
    tileSpanX: cellSize * 256,
    tileSpanY: cellSize * 256
  }))
};

const TARGET_RES = 4.0;
const ZOOM_OFFSET = 1;

test('selectBandLevel#zoomOffset 0 matches plain selectTileMatrix (no shift)', () => {
  expect(selectBandLevel(NON_DYADIC_TMS, TARGET_RES, 0, 0, 3)).toBe(
    selectTileMatrix(NON_DYADIC_TMS, TARGET_RES)
  );
});

test('selectBandLevel#applies zoomOffset as an index shift matching warp-mesh.ts#selectWarpSourceZoom, not a resolution-scaling factor', () => {
  const baseLevel = selectTileMatrix(NON_DYADIC_TMS, TARGET_RES);
  const indexShiftAnswer = baseLevel + ZOOM_OFFSET;
  // The pre-fix (buggy) resolution-scaling treatment: look up the level nearest to
  // `targetUnitsPerPixel * 2**-zoomOffset` instead of shifting the plain-res index.
  const resolutionScalingAnswer = selectTileMatrix(
    NON_DYADIC_TMS,
    TARGET_RES * Math.pow(2, -ZOOM_OFFSET)
  );
  // Precondition: for this non-dyadic TMS and target resolution, the two strategies
  // genuinely disagree -- otherwise this test would pass regardless of which one
  // `selectBandLevel` implements.
  expect(resolutionScalingAnswer).not.toBe(indexShiftAnswer);

  // warp-mesh.ts's `selectWarpSourceZoom` applies zoomOffset the same way: `return
  // selectTileMatrix(source.tms, sourceUnitsPerPixel) + zoomOffset` -- index-shift, not
  // resolution-scaling. `selectBandLevel` must pick the same level for the same
  // (tms, res, zoomOffset) so a pitched view's near/far bands land on the same level the
  // unpitched (warp-mesh) path would for the same effective ground resolution.
  expect(selectBandLevel(NON_DYADIC_TMS, TARGET_RES, ZOOM_OFFSET, 0, 3)).toBe(indexShiftAnswer);
});

test('selectBandLevel#clamps to [minLevel, maxLevel]', () => {
  expect(selectBandLevel(NON_DYADIC_TMS, TARGET_RES, 5, 0, 3)).toBe(3);
  expect(selectBandLevel(NON_DYADIC_TMS, TARGET_RES, -5, 0, 3)).toBe(0);
});
