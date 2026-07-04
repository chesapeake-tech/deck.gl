// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** One level of an OGC two-dimensional TileMatrixSet (subset of TMS 2.0) */
export type TileMatrix = {
  /** Tile matrix identifier, e.g. '0'. Substituted for `{tm}` in URL templates. */
  id: string;
  /** Resolution in CRS units per pixel. If omitted, derived from `scaleDenominator`. */
  cellSize?: number;
  /** OGC scale denominator (0.28 mm/pixel convention). Used when `cellSize` is omitted. */
  scaleDenominator?: number;
  /** Grid origin in CRS coordinates */
  pointOfOrigin: [number, number];
  /** Which corner of the grid `pointOfOrigin` refers to. Default 'topLeft' */
  cornerOfOrigin?: 'topLeft' | 'bottomLeft';
  /** Tile width in pixels */
  tileWidth: number;
  /** Tile height in pixels */
  tileHeight: number;
  /** Number of tile columns */
  matrixWidth: number;
  /** Number of tile rows */
  matrixHeight: number;
};

/** An OGC two-dimensional TileMatrixSet (subset of TMS 2.0) */
export type TileMatrixSet = {
  id?: string;
  /** CRS identifier, e.g. 'EPSG:32618' or an OGC CRS URI. Checked against the view CRS. */
  crs?: string;
  /** Tile matrices ordered coarse to fine (strictly decreasing cellSize) */
  tileMatrices: TileMatrix[];
};

export type NormalizedTileMatrix = {
  id: string;
  cellSize: number;
  pointOfOrigin: [number, number];
  cornerOfOrigin: 'topLeft' | 'bottomLeft';
  tileWidth: number;
  tileHeight: number;
  matrixWidth: number;
  matrixHeight: number;
  /** cellSize * tileWidth, in CRS units */
  tileSpanX: number;
  /** cellSize * tileHeight, in CRS units */
  tileSpanY: number;
};

export type NormalizedTileMatrixSet = {
  id?: string;
  crs?: string;
  tileMatrices: NormalizedTileMatrix[];
};

/** OGC standardized rendering pixel size: 0.28 mm */
const OGC_PIXEL_SIZE_M = 0.28e-3;

/** Resolve cellSize/cornerOfOrigin, precompute tile spans, and validate level ordering.
 * `metersPerUnit` converts scaleDenominator to CRS units: 1 for meters CRSs,
 * 111319.49079327358 (OGC convention) for degrees. */
export function normalizeTileMatrixSet(
  tms: TileMatrixSet,
  options: {metersPerUnit?: number} = {}
): NormalizedTileMatrixSet {
  const {metersPerUnit = 1} = options;
  const {tileMatrices} = tms;
  if (!tileMatrices || tileMatrices.length === 0) {
    throw new Error('TileMatrixSet: tileMatrices must not be empty');
  }
  const normalized = tileMatrices.map(tm => {
    // Note: derives cellSize from OGC 0.28mm/px convention when explicit cellSize is omitted.
    // Some registries (e.g., CanadianNAD83_LCC) do not follow this convention; always prefer explicit cellSize.
    const cellSize =
      tm.cellSize ??
      (tm.scaleDenominator !== undefined
        ? (tm.scaleDenominator * OGC_PIXEL_SIZE_M) / metersPerUnit
        : undefined);
    if (cellSize === undefined || !Number.isFinite(cellSize) || cellSize <= 0) {
      throw new Error(
        `TileMatrixSet: tileMatrix ${tm.id} needs a positive cellSize or scaleDenominator`
      );
    }
    return {
      id: tm.id,
      cellSize,
      pointOfOrigin: tm.pointOfOrigin,
      cornerOfOrigin: tm.cornerOfOrigin ?? ('topLeft' as const),
      tileWidth: tm.tileWidth,
      tileHeight: tm.tileHeight,
      matrixWidth: tm.matrixWidth,
      matrixHeight: tm.matrixHeight,
      tileSpanX: cellSize * tm.tileWidth,
      tileSpanY: cellSize * tm.tileHeight
    };
  });
  for (let i = 1; i < normalized.length; i++) {
    if (!(normalized[i].cellSize < normalized[i - 1].cellSize)) {
      throw new Error('TileMatrixSet: tileMatrices must be ordered coarse to fine');
    }
  }
  return {id: tms.id, crs: tms.crs, tileMatrices: normalized};
}

/** Index of the tile matrix whose cellSize best matches the target resolution.
 * Distance is measured in log2 space; ties go to the finer level (mirrors the OSM
 * `Math.round(zoom)` behavior). */
export function selectTileMatrix(tms: NormalizedTileMatrixSet, crsUnitsPerPixel: number): number {
  const {tileMatrices} = tms;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < tileMatrices.length; i++) {
    const dist = Math.abs(Math.log2(tileMatrices[i].cellSize / crsUnitsPerPixel));
    if (dist <= bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

/** The [minX, minY, maxX, maxY] rect of a tile in CRS units */
export function getTileBoundsCRS(
  tm: NormalizedTileMatrix,
  x: number,
  y: number
): [number, number, number, number] {
  const [originX, originY] = tm.pointOfOrigin;
  const minX = originX + x * tm.tileSpanX;
  const maxX = minX + tm.tileSpanX;
  if (tm.cornerOfOrigin === 'bottomLeft') {
    const minY = originY + y * tm.tileSpanY;
    return [minX, minY, maxX, minY + tm.tileSpanY];
  }
  const maxY = originY - y * tm.tileSpanY;
  return [minX, maxY - tm.tileSpanY, maxX, maxY];
}

/** All tile {x, y} in the matrix intersecting the CRS-unit bounds (clamped to the grid) */
export function getTileIndicesInBounds(
  tm: NormalizedTileMatrix,
  bounds: [number, number, number, number]
): {x: number; y: number}[] {
  const [minX, minY, maxX, maxY] = bounds;
  const [originX, originY] = tm.pointOfOrigin;
  const x0 = Math.max(Math.floor((minX - originX) / tm.tileSpanX), 0);
  const x1 = Math.min(Math.ceil((maxX - originX) / tm.tileSpanX), tm.matrixWidth);
  let y0: number;
  let y1: number;
  if (tm.cornerOfOrigin === 'bottomLeft') {
    y0 = Math.max(Math.floor((minY - originY) / tm.tileSpanY), 0);
    y1 = Math.min(Math.ceil((maxY - originY) / tm.tileSpanY), tm.matrixHeight);
  } else {
    y0 = Math.max(Math.floor((originY - maxY) / tm.tileSpanY), 0);
    y1 = Math.min(Math.ceil((originY - minY) / tm.tileSpanY), tm.matrixHeight);
  }
  const indices: {x: number; y: number}[] = [];
  for (let x = x0; x < x1; x++) {
    for (let y = y0; y < y1; y++) {
      indices.push({x, y});
    }
  }
  return indices;
}

/** The tile containing a CRS point. Outside the matrix: returns null, or the nearest
 * valid tile when `options.clamp` is set. */
export function getTileIndexAtPoint(
  tm: NormalizedTileMatrix,
  point: [number, number],
  options: {clamp?: boolean} = {}
): {x: number; y: number} | null {
  const [originX, originY] = tm.pointOfOrigin;
  const x = Math.floor((point[0] - originX) / tm.tileSpanX);
  const y =
    tm.cornerOfOrigin === 'bottomLeft'
      ? Math.floor((point[1] - originY) / tm.tileSpanY)
      : Math.floor((originY - point[1]) / tm.tileSpanY);
  if (x < 0 || x >= tm.matrixWidth || y < 0 || y >= tm.matrixHeight) {
    if (options.clamp) {
      return {
        x: Math.min(Math.max(x, 0), tm.matrixWidth - 1),
        y: Math.min(Math.max(y, 0), tm.matrixHeight - 1)
      };
    }
    return null;
  }
  return {x, y};
}
