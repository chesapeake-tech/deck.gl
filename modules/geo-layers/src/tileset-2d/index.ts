// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl, MIT license

export type {
  TileLoadProps,
  Bounds,
  ZRange,
  GeoBoundingBox,
  NonGeoBoundingBox,
  TileBoundingBox
} from './types';

export type {Tileset2DProps, RefinementStrategy} from './tileset-2d';
export {Tileset2D, STRATEGY_DEFAULT} from './tileset-2d';

export {Tile2DHeader} from './tile-2d-header';

export {CRSTileset2D} from './crs-tileset-2d';
export type {CRSTileset2DProps, CRSTileIndex} from './crs-tileset-2d';
export {normalizeTileMatrixSet} from './tile-matrix-set';
export type {
  TileMatrixSet,
  TileMatrix,
  NormalizedTileMatrixSet,
  NormalizedTileMatrix
} from './tile-matrix-set';

export type {URLTemplate} from './utils';
export {
  isGeoBoundingBox,
  isURLTemplate,
  urlType,
  getURLFromTemplate,
  getTileIndices,
  tileToBoundingBox
} from './utils';
