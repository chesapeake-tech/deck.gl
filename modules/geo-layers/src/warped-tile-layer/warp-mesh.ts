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

/** Build the warped grid mesh for one Mercator tile: an N x N cell grid whose vertices are
 * transformed Mercator world -> lnglat -> target CRS -> common space with the exact injected
 * transform (not the shader linearization). Positions are stored float32 relative to the
 * tile's top-left vertex (`origin`, computed in float64) so precision holds at any zoom. */
export function buildWarpedTileMesh(
  boundsWorld: [number, number, number, number],
  crs: WarpTargetCRS,
  resolution: number
): WarpedTileMesh {
  const n = Math.max(1, Math.round(resolution));
  const rows = n + 1;
  const [minX, minY, maxX, maxY] = boundsWorld;
  const {transform, extent, commonUnitsPerCRSUnit} = crs;

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
      texCoords[v * 2] = i / n;
      texCoords[v * 2 + 1] = j / n;
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
