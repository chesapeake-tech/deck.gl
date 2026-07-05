// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {worldToLngLat, lngLatToWorld} from '@math.gl/web-mercator';
import {normalizeTileMatrixSet, selectTileMatrix} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet, TileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {CRSDefinition} from '@deck.gl/core';

/** Width of deck's Mercator common-space world, and of the world expressed here */
const MERCATOR_WORLD_SIZE = 512;
/** Earth circumference at the equator, meters (matches @math.gl/web-mercator) */
const EARTH_CIRCUMFERENCE = 40075016.686;
/** Latitude bound of the square Web Mercator world */
export const MAX_MERCATOR_LATITUDE = 85.051129;
/** OGC scaleDenominator -> CRS units conversion for degree-based source CRSs. */
const METERS_PER_DEGREE = 111319.49079327358;
/** Source Web-Mercator pyramid levels built for the default source (indices 0..22). */
export const MAX_MERCATOR_SOURCE_LEVELS = 23;

/** Default source->lnglat: the built-in Web-Mercator 512-unit world. */
const mercatorToLngLat = (xy: [number, number]): [number, number] => worldToLngLat(xy);

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

/** Which CRS a warp source's tile pyramid is described in.
 * - omitted / null: the built-in Web-Mercator source (deck's 512-unit world), today's behavior;
 * - `'EPSG:4326'`: a lat/long source (e.g. NASA GIBS WorldCRS84Quad) — source coords ARE lnglat;
 * - a `CRSDefinition`: any source whose `transform` inverts source coords to lnglat (and back). */
export type WarpSourceCrs = CRSDefinition | 'EPSG:4326' | null;

/** A source tile pyramid resolved into everything the warp pipeline needs: the grid (a
 * normalized TMS in the source CRS's units) and the source-coords <-> lnglat pair used to warp
 * each tile into the view CRS and to index the pyramid from the view. */
export type ResolvedWarpSource = {
  tms: NormalizedTileMatrixSet;
  /** source-CRS coordinates -> [lng, lat] degrees */
  toLngLat: (xy: [number, number]) => [number, number];
  /** [lng, lat] degrees -> source-CRS coordinates (applies any source-domain clamp) */
  fromLngLat: (lnglat: [number, number]) => [number, number];
  /** True only for the built-in Web-Mercator source — lets callers preserve its exact
   * (byte-identical) level-selection and quadtree-parent fast paths. */
  isMercator: boolean;
  /** [minX, minY, maxX, maxY] of the whole level-0 grid, in source units — the whole-source
   * fallback bounds when a steep-pitch view has too few finite corners to bound the fetch. */
  sourceBounds: [number, number, number, number];
};

/** The [minX, minY, maxX, maxY] source-unit extent of a TMS's level-0 grid. */
function tmsLevel0Bounds(tms: NormalizedTileMatrixSet): [number, number, number, number] {
  const tm = tms.tileMatrices[0];
  const minX = tm.pointOfOrigin[0];
  const maxX = minX + tm.matrixWidth * tm.tileSpanX;
  if (tm.cornerOfOrigin === 'bottomLeft') {
    const minY = tm.pointOfOrigin[1];
    return [minX, minY, maxX, minY + tm.matrixHeight * tm.tileSpanY];
  }
  const maxY = tm.pointOfOrigin[1];
  return [minX, maxY - tm.matrixHeight * tm.tileSpanY, maxX, maxY];
}

/**
 * Resolve the `sourceTileMatrixSet` / `sourceCrs` props into a {@link ResolvedWarpSource}.
 *
 * Scope is deliberately minimal (see the design's "non-Mercator warp sources" contract): a source
 * is either the built-in Web-Mercator pyramid (default), an EPSG:4326 lat/long pyramid whose tile
 * coordinates are lnglat directly (the identity case — e.g. GIBS WorldCRS84Quad), or a caller-
 * supplied `CRSDefinition` that already carries the exact `transform.inverse` (source coords ->
 * lnglat). We do NOT build a general inverse-projection framework: any non-4326 source must bring
 * its own inverse via `sourceCrs`, because inverting an arbitrary projection is exactly the
 * server-side reprojection this layer exists to avoid.
 */
export function resolveWarpSource(options: {
  tileSize: number;
  sourceTileMatrixSet?: TileMatrixSet | null;
  sourceCrs?: WarpSourceCrs;
}): ResolvedWarpSource {
  const {tileSize, sourceTileMatrixSet, sourceCrs} = options;

  if (!sourceCrs) {
    // Built-in Web-Mercator source over deck's 512-unit world (today's hardcoded behavior).
    const tms = sourceTileMatrixSet
      ? normalizeTileMatrixSet(sourceTileMatrixSet, {metersPerUnit: 1})
      : makeWebMercatorQuadTms(tileSize, MAX_MERCATOR_SOURCE_LEVELS);
    return {
      tms,
      toLngLat: mercatorToLngLat,
      fromLngLat: lnglat =>
        lngLatToWorld([
          Math.min(Math.max(lnglat[0], -180), 180),
          Math.min(Math.max(lnglat[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
        ]),
      isMercator: true,
      sourceBounds: tmsLevel0Bounds(tms)
    };
  }

  if (!sourceTileMatrixSet) {
    throw new Error('_WarpedTileLayer: sourceTileMatrixSet is required when sourceCrs is set');
  }

  if (sourceCrs === 'EPSG:4326') {
    // Source tile coordinates are lnglat degrees; the source<->lnglat transform is the identity.
    const tms = normalizeTileMatrixSet(sourceTileMatrixSet, {metersPerUnit: METERS_PER_DEGREE});
    return {
      tms,
      toLngLat: xy => [xy[0], xy[1]],
      fromLngLat: lnglat => [lnglat[0], lnglat[1]],
      isMercator: false,
      sourceBounds: tmsLevel0Bounds(tms)
    };
  }

  // A caller-supplied CRSDefinition: use its exact forward/inverse.
  const units = sourceCrs.units ?? 'meters';
  const metersPerUnit = units === 'degrees' ? METERS_PER_DEGREE : 1;
  const tms = normalizeTileMatrixSet(sourceTileMatrixSet, {metersPerUnit});
  return {
    tms,
    toLngLat: xy => sourceCrs.transform.inverse(xy),
    fromLngLat: lnglat => sourceCrs.transform.forward(lnglat),
    isMercator: false,
    sourceBounds: tmsLevel0Bounds(tms)
  };
}

/** Source pyramid level whose ground resolution at the view center best matches the view.
 * For the built-in Web-Mercator source this delegates to {@link selectMercatorSourceZoom} (so the
 * default path is byte-identical). For any other source it measures source-CRS units per screen
 * pixel at the view center — one pixel step unprojected to lnglat, mapped through the source
 * transform — and picks the matching TMS level with {@link selectTileMatrix}, reusing the same
 * pure index/resolution math as `CRSTileset2D`. */
export function selectWarpSourceZoom(
  viewport: {
    zoom: number;
    latitude?: number;
    width: number;
    height: number;
    distanceScales: {metersPerUnit: number[]};
    unproject: (pixel: number[]) => number[];
  },
  source: ResolvedWarpSource,
  tileSizePx: number,
  zoomOffset: number = 0
): number {
  if (source.isMercator) {
    return selectMercatorSourceZoom(viewport, tileSizePx, zoomOffset);
  }
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const a = viewport.unproject([cx, cy]);
  const b = viewport.unproject([cx + 1, cy]);
  const pa = source.fromLngLat([a[0], a[1]]);
  const pb = source.fromLngLat([b[0], b[1]]);
  const sourceUnitsPerPixel = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
  return selectTileMatrix(source.tms, sourceUnitsPerPixel) + zoomOffset;
}

/** Candidate warp-grid sizes (cells per edge), coarse to fine. */
export const WARP_GRID_SIZES = [4, 8, 16, 32] as const;
/** Target worst-case interpolation error between mesh vertices, in screen pixels.
 * Matches the design's N=16 UTM budget; the adaptive selector holds it as a runtime bound. */
export const WARP_ERROR_BUDGET_PX = 0.15;
/** Multiplier applied to the midpoint-deviation estimate so the actual (not just estimated)
 * worst-case error stays within {@link WARP_ERROR_BUDGET_PX}. */
const WARP_ERROR_SAFETY = 2;

/** Exact source-coords -> lnglat -> target-CRS common-space transform of one point. */
function warpPoint(
  sx: number,
  sy: number,
  crs: WarpTargetCRS,
  sourceToLngLat: (xy: [number, number]) => [number, number]
): [number, number] {
  const [lng, lat] = sourceToLngLat([sx, sy]);
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
  pixelsPerCommonUnit: number,
  sourceToLngLat: (xy: [number, number]) => [number, number] = mercatorToLngLat
): number {
  const [minX, minY, maxX, maxY] = boundsWorld;
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const c00 = warpPoint(minX, maxY, crs, sourceToLngLat); // top-left
  const c10 = warpPoint(maxX, maxY, crs, sourceToLngLat); // top-right
  const c01 = warpPoint(minX, minY, crs, sourceToLngLat); // bottom-left
  const c11 = warpPoint(maxX, minY, crs, sourceToLngLat); // bottom-right
  const eTop = warpPoint(midX, maxY, crs, sourceToLngLat);
  const eBottom = warpPoint(midX, minY, crs, sourceToLngLat);
  const eLeft = warpPoint(minX, midY, crs, sourceToLngLat);
  const eRight = warpPoint(maxX, midY, crs, sourceToLngLat);
  const center = warpPoint(midX, midY, crs, sourceToLngLat);
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
  /** Source-CRS coordinates -> [lng, lat] degrees. Defaults to the built-in Web-Mercator
   * 512-unit world (`worldToLngLat`); pass a source's own inverse to warp a non-Mercator
   * pyramid (see {@link resolveWarpSource}). `boundsWorld` is then in that source's units. */
  sourceToLngLat?: (xy: [number, number]) => [number, number];
};

/** Build the warped grid mesh for one source tile: an N x N cell grid whose vertices are
 * transformed source-coords -> lnglat -> target CRS -> common space with the exact injected
 * transform (not the shader linearization). Positions are stored float32 relative to the
 * tile's top-left vertex (`origin`, computed in float64) so precision holds at any zoom.
 * `boundsWorld` is in the source pyramid's own units (512-unit Mercator world by default). */
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
  const sourceToLngLat = options.sourceToLngLat ?? mercatorToLngLat;

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
      const [lng, lat] = sourceToLngLat([wx, wy]);
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
