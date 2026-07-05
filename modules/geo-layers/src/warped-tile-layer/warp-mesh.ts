// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {worldToLngLat} from '@math.gl/web-mercator';
import {normalizeTileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '../tileset-2d/tile-matrix-set';

/** Width of deck's Mercator common-space world, and of the world expressed here */
const MERCATOR_WORLD_SIZE = 512;
/** Earth circumference at the equator, meters (matches @math.gl/web-mercator) */
const EARTH_CIRCUMFERENCE = 40075016.686;
/** Latitude bound of the square Web Mercator world */
export const MAX_MERCATOR_LATITUDE = 85.051129;

/** The shape of `_CRSViewport.crs` (duck-typed; same as Phase 2's CRSViewportLike['crs']) */
export type WarpTargetCRS = {
  code: string;
  units: 'meters' | 'degrees';
  extent: [number, number, number, number];
  commonUnitsPerCRSUnit: number;
  transform: {
    forward: (lnglat: [number, number]) => [number, number];
    inverse: (xy: [number, number]) => [number, number];
  };
};

/** The OSM/WebMercatorQuad pyramid as a TileMatrixSet over deck's 512-unit Mercator world.
 * World y grows northward, OSM row 0 is the top row: origin [0, 512], cornerOfOrigin topLeft. */
export function makeWebMercatorQuadTms(
  tileSizePx: number,
  numLevels: number
): NormalizedTileMatrixSet {
  return normalizeTileMatrixSet({
    id: 'WebMercatorQuad',
    crs: 'EPSG:3857',
    tileMatrices: Array.from({length: numLevels}, (_, z) => ({
      id: String(z),
      cellSize: MERCATOR_WORLD_SIZE / (2 ** z * tileSizePx),
      pointOfOrigin: [0, MERCATOR_WORLD_SIZE] as [number, number],
      tileWidth: tileSizePx,
      tileHeight: tileSizePx,
      matrixWidth: 2 ** z,
      matrixHeight: 2 ** z
    }))
  });
}

/** Source OSM level whose ground resolution at the view center best matches the view.
 * gView = metersPerUnit[0] * 2^-zoom; source level z resolves
 * C*cos(lat) / (tileSizePx * 2^z) ground meters per pixel. For a Web Mercator view this
 * reduces exactly to the OSM rule round(zoom + log2(512 / tileSize)). */
export function selectMercatorSourceZoom(
  viewport: {zoom: number; latitude?: number; distanceScales: {metersPerUnit: number[]}},
  tileSizePx: number,
  zoomOffset: number = 0
): number {
  const latitude = viewport.latitude ?? 0;
  const groundMetersPerPixel = viewport.distanceScales.metersPerUnit[0] * 2 ** -viewport.zoom;
  const z = Math.log2(
    (EARTH_CIRCUMFERENCE * Math.cos((latitude * Math.PI) / 180)) /
      (tileSizePx * groundMetersPerPixel)
  );
  return Math.round(z + zoomOffset);
}

/** Candidate warp-grid sizes (cells per edge), coarse to fine. */
export const WARP_GRID_SIZES = [4, 8, 16, 32] as const;
/** Target worst-case interpolation error between mesh vertices, in screen pixels.
 * Matches the design's N=16 UTM budget; the adaptive selector holds it as a runtime bound. */
export const WARP_ERROR_BUDGET_PX = 0.15;
/** Multiplier applied to the midpoint-deviation estimate so the actual (not just estimated)
 * worst-case error stays within {@link WARP_ERROR_BUDGET_PX}. */
const WARP_ERROR_SAFETY = 2;

/** Exact Mercator-world -> target-CRS common-space transform of one point. */
function warpPoint(wx: number, wy: number, crs: WarpTargetCRS): [number, number] {
  const [lng, lat] = worldToLngLat([wx, wy]);
  const xy = crs.transform.forward([lng, lat]);
  return [
    (xy[0] - crs.extent[0]) * crs.commonUnitsPerCRSUnit,
    (xy[1] - crs.extent[1]) * crs.commonUnitsPerCRSUnit
  ];
}

/**
 * Choose a warp-grid size for one tile from its actual distortion, holding the ≤0.15 px
 * interpolation-error budget as a runtime bound.
 *
 * The estimator measures the deviation between the exact warp of each tile-edge midpoint (and the
 * tile center) and the position a straight-line interpolation of that edge's endpoints would give
 * — i.e. the single-cell (N=1) piecewise-linear error, in common-space units. Piecewise-linear
 * interpolation error of a smooth map scales as the square of the cell size, so subdividing to an
 * N x N grid shrinks it ~N^2: `errorPx(N) ≈ d1 / N^2 * pixelsPerCommonUnit`. It returns the
 * smallest {@link WARP_GRID_SIZES} entry whose estimated pixel error is within
 * {@link WARP_ERROR_BUDGET_PX}, falling back to the finest (32) when even that overshoots —
 * mirroring the design error-table's "raise N until sub-pixel, capped" behavior.
 *
 * @param pixelsPerCommonUnit screen pixels per common-space unit — the viewport's `scale`
 *   (`2^zoom`); converts the common-space deviation to on-screen pixels.
 */
export function estimateWarpMeshResolution(
  boundsWorld: [number, number, number, number],
  crs: WarpTargetCRS,
  pixelsPerCommonUnit: number
): number {
  const [minX, minY, maxX, maxY] = boundsWorld;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const c00 = warpPoint(minX, maxY, crs); // top-left
  const c10 = warpPoint(maxX, maxY, crs); // top-right
  const c01 = warpPoint(minX, minY, crs); // bottom-left
  const c11 = warpPoint(maxX, minY, crs); // bottom-right
  const eTop = warpPoint(midX, maxY, crs);
  const eBottom = warpPoint(midX, minY, crs);
  const eLeft = warpPoint(minX, midY, crs);
  const eRight = warpPoint(maxX, midY, crs);
  const center = warpPoint(midX, midY, crs);
  const dev = (p: number[], a: number[], b: number[]): number =>
    Math.hypot(p[0] - (a[0] + b[0]) / 2, p[1] - (a[1] + b[1]) / 2);
  const d1 = Math.max(
    dev(eTop, c00, c10),
    dev(eBottom, c01, c11),
    dev(eLeft, c00, c01),
    dev(eRight, c10, c11),
    // center vs the bilinear average of the four corners
    Math.hypot(
      center[0] - (c00[0] + c10[0] + c01[0] + c11[0]) / 4,
      center[1] - (c00[1] + c10[1] + c01[1] + c11[1]) / 4
    )
  );
  for (const n of WARP_GRID_SIZES) {
    // The midpoint-deviation estimate slightly under-reads the cell's true max interpolation
    // error (the extremum is rarely exactly at the midpoint, and curvature varies across the
    // tile). A safety factor keeps the ACTUAL worst-case error under budget, not just the
    // estimate — verified against the exact transform in the tests.
    if ((d1 / (n * n)) * pixelsPerCommonUnit * WARP_ERROR_SAFETY <= WARP_ERROR_BUDGET_PX) {
      return n;
    }
  }
  return WARP_GRID_SIZES[WARP_GRID_SIZES.length - 1];
}

export type WarpedTileMesh = {
  /** Tile top-left vertex in common space (float64) — use as the instance position */
  origin: [number, number, number];
  attributes: {
    /** Vertex positions relative to `origin`, row-major from the image top-left */
    positions: {value: Float32Array; size: 3};
    /** Texture coordinates; v = 0 at the image top */
    texCoords: {value: Float32Array; size: 2};
  };
  indices: {value: Uint32Array; size: 1};
};

/** Options for {@link buildWarpedTileMesh}. */
export type BuildWarpedTileMeshOptions = {
  /** Source tile texture width in texels (e.g. 256/512). When set, mesh UVs are inset by half a
   * texel — the [0,1] range is remapped to [0.5/w, 1 - 0.5/w] — so a mesh triangle can never
   * sample past its tile's border texels under the GPU's linear filter. Tradeoff: the outermost
   * half-texel ring of each tile image is cropped, in exchange for eliminating the hairline seams
   * that edge-texel bleed produces between adjacent warped tiles. Omit (or 0) to keep full [0,1]
   * UVs (no inset). */
  tileSize?: number;
};

/** Build the warped grid mesh for one Mercator tile: an N x N cell grid whose vertices are
 * transformed Mercator world -> lnglat -> target CRS -> common space with the exact injected
 * transform (not the shader linearization). Positions are stored float32 relative to the
 * tile's top-left vertex (`origin`, computed in float64) so precision holds at any zoom. */
export function buildWarpedTileMesh(
  boundsWorld: [number, number, number, number],
  crs: WarpTargetCRS,
  resolution: number,
  options: BuildWarpedTileMeshOptions = {}
): WarpedTileMesh {
  const n = Math.max(1, Math.round(resolution));
  const rows = n + 1;
  const [minX, minY, maxX, maxY] = boundsWorld;
  const {transform, extent, commonUnitsPerCRSUnit} = crs;

  // Half-texel UV inset (gutter clamp). With w texels across, texel centers span
  // [0.5/w, 1 - 0.5/w]; mapping the mesh's [0,1] UV range onto that keeps every sample at or
  // inside a texel center, so linear filtering never reaches a neighbor tile's border texel.
  const w = options.tileSize && options.tileSize > 0 ? options.tileSize : 0;
  const uvScale = w > 0 ? (w - 1) / w : 1;
  const uvBias = w > 0 ? 0.5 / w : 0;

  // Exact vertex positions in common space, float64
  const common = new Float64Array(rows * rows * 2);
  for (let j = 0; j <= n; j++) {
    // Row 0 is the image top = world maxY
    const wy = maxY + ((minY - maxY) * j) / n;
    for (let i = 0; i <= n; i++) {
      const wx = minX + ((maxX - minX) * i) / n;
      const [lng, lat] = worldToLngLat([wx, wy]);
      const xy = transform.forward([lng, lat]);
      const k = (j * rows + i) * 2;
      common[k] = (xy[0] - extent[0]) * commonUnitsPerCRSUnit;
      common[k + 1] = (xy[1] - extent[1]) * commonUnitsPerCRSUnit;
    }
  }

  const origin: [number, number, number] = [common[0], common[1], 0];
  const positions = new Float32Array(rows * rows * 3);
  const texCoords = new Float32Array(rows * rows * 2);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const v = j * rows + i;
      positions[v * 3] = common[v * 2] - origin[0];
      positions[v * 3 + 1] = common[v * 2 + 1] - origin[1];
      positions[v * 3 + 2] = 0;
      texCoords[v * 2] = uvBias + (i / n) * uvScale;
      texCoords[v * 2 + 1] = uvBias + (j / n) * uvScale;
    }
  }

  const indices = new Uint32Array(n * n * 6);
  let c = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const topLeft = j * rows + i;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + rows;
      const bottomRight = bottomLeft + 1;
      // CCW in y-up common space (row j is above row j+1)
      indices[c++] = topLeft;
      indices[c++] = bottomLeft;
      indices[c++] = topRight;
      indices[c++] = topRight;
      indices[c++] = bottomLeft;
      indices[c++] = bottomRight;
    }
  }

  return {
    origin,
    attributes: {
      positions: {value: positions, size: 3},
      texCoords: {value: texCoords, size: 2}
    },
    indices: {value: indices, size: 1}
  };
}
