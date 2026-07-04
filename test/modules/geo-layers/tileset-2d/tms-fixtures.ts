// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileMatrixSet} from '@deck.gl/geo-layers/tileset-2d/tile-matrix-set';

/** Synthetic WorldCRS84Quad-style quadtree with 512px tiles: level z covers the world in
 * 2^(z+1) x 2^z tiles. cellSize at level 0 is 180 / 512 = 0.3515625 deg/px.
 * (Not a real service's grid — see GIBS_500M_TMS for a verbatim production TMS.) */
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

/** NASA GIBS EPSG:4326 '500m' TileMatrixSet, verbatim from the WMTS capabilities
 * (https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml).
 * Non-power-of-two matrix dimensions and grids that overflow the world extent
 * (level 0 tiles span 288 degrees), with scaleDenominator-only levels. */
export const GIBS_500M_TMS: TileMatrixSet = {
  id: '500m',
  crs: 'EPSG:4326',
  tileMatrices: [
    [223632905.6114871, 2, 1],
    [111816452.8057436, 3, 2],
    [55908226.40287178, 5, 3],
    [27954113.20143589, 10, 5],
    [13977056.60071795, 20, 10],
    [6988528.300358973, 40, 20],
    [3494264.150179486, 80, 40],
    [1747132.075089743, 160, 80]
  ].map(([scaleDenominator, matrixWidth, matrixHeight], z) => ({
    id: String(z),
    scaleDenominator,
    pointOfOrigin: [-180, 90] as [number, number],
    tileWidth: 512,
    tileHeight: 512,
    matrixWidth,
    matrixHeight
  }))
};
