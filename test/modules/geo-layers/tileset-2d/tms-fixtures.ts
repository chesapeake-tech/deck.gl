// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileMatrixSet} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';

/** GIBS-style WorldCRS84Quad with 512px tiles: level z covers the world in 2^(z+1) x 2^z tiles.
 * cellSize at level 0 is 180 / 512 = 0.3515625 deg/px. */
export function makeWorldCRS84Quad512(numLevels: number): TileMatrixSet {
  return {
    id: 'WorldCRS84Quad-512',
    crs: 'EPSG:4326',
    tileMatrices: Array.from({length: numLevels}, (_, z) => ({
      id: String(z),
      cellSize: 0.3515625 / 2 ** z,
      pointOfOrigin: [-180, 90] as [number, number],
      tileWidth: 512,
      tileHeight: 512,
      matrixWidth: 2 ** (z + 1),
      matrixHeight: 2 ** z
    }))
  };
}

export const UTM_EXTENT: [number, number, number, number] = [166021.44, 0, 833978.56, 9329005.18];

/** Non-quadtree UTM 18N demo TMS derived from the zone extent: level z has 2^z columns and
 * ceil(zoneHeight / tileSpan) rows (14 rows at level 0 — deliberately not a square quadtree). */
export function makeUTM18NTms(numLevels: number): TileMatrixSet {
  const width = UTM_EXTENT[2] - UTM_EXTENT[0];
  return {
    id: 'UTM18N-demo',
    crs: 'EPSG:32618',
    tileMatrices: Array.from({length: numLevels}, (_, z) => {
      const cellSize = width / 512 / 2 ** z;
      return {
        id: String(z),
        cellSize,
        pointOfOrigin: [UTM_EXTENT[0], UTM_EXTENT[3]] as [number, number],
        tileWidth: 512,
        tileHeight: 512,
        matrixWidth: 2 ** z,
        matrixHeight: Math.ceil((UTM_EXTENT[3] - UTM_EXTENT[1]) / (cellSize * 512))
      };
    })
  };
}
