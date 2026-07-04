// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log, Viewport} from '@deck.gl/core';
import {Tileset2D, Tileset2DProps} from './tileset-2d';
import {
  normalizeTileMatrixSet,
  selectTileMatrix,
  getTileBoundsCRS,
  getTileIndicesInBounds,
  getTileIndexAtPoint
} from './tile-matrix-set';
import type {TileMatrixSet, NormalizedTileMatrixSet} from './tile-matrix-set';
import type {Bounds, TileIndex} from './types';

/** A viewport with Phase 1 CRS information (duck-typed to avoid a hard dependency on _CRSViewport) */
type CRSViewportLike = Viewport & {
  crs: {
    code: string;
    units: 'meters' | 'degrees';
    extent: [number, number, number, number];
    commonUnitsPerCRSUnit: number;
    transform: {
      forward: (lnglat: [number, number]) => [number, number];
      inverse: (xy: [number, number]) => [number, number];
    };
  };
};

export type CRSTileset2DProps = Tileset2DProps & {
  /** OGC TileMatrixSet describing the tile grid, in the view's CRS */
  tileMatrixSet: TileMatrixSet;
};

/** `z` is the array position in `tileMatrices`; `tm` is the TMS level id (for URL templates) */
export type CRSTileIndex = TileIndex & {tm: string};

/** Matches the OGC scaleDenominator convention for degree-based CRSs */
const METERS_PER_DEGREE = 111319.49079327358;

/** Tileset that indexes tiles from an OGC TileMatrixSet against a CRS view
 * (a `MapView` with a non-Mercator `crs`). */
export class CRSTileset2D extends Tileset2D {
  private _tms: NormalizedTileMatrixSet | null = null;
  private _rawTms: TileMatrixSet | null = null;
  private _crsViewport: CRSViewportLike | null = null;
  private _crsCode: string | null = null;

  constructor(opts: CRSTileset2DProps) {
    super(opts);
    if (!opts.tileMatrixSet) {
      throw new Error('CRSTileset2D: tileMatrixSet is required');
    }
  }

  getTileIndices({
    viewport,
    maxZoom,
    minZoom
  }: Parameters<Tileset2D['getTileIndices']>[0]): CRSTileIndex[] {
    const crsViewport = viewport as CRSViewportLike;
    if (!crsViewport.crs) {
      throw new Error(
        'CRSTileset2D requires a CRS view — set the `crs` prop on MapView, or remove `tileMatrixSet`'
      );
    }
    this._crsViewport = crsViewport;
    const {zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }

    const tms = this._getTms(crsViewport);
    const crsUnitsPerPixel =
      Math.pow(2, -(viewport.zoom + zoomOffset)) / crsViewport.crs.commonUnitsPerCRSUnit;
    let z = selectTileMatrix(tms, crsUnitsPerPixel);
    if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
      // Mirror the OSM path (utils.ts getTileIndices): fetching minZoom tiles for a view
      // far above them can request the entire grid — only do it when `extent` bounds the area
      if (!extent) {
        return [];
      }
      z = minZoom;
    }
    if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
      z = maxZoom;
    }
    z = Math.max(0, Math.min(z, tms.tileMatrices.length - 1));

    const bounds = this._getViewBoundsCRS(crsViewport, (extent as Bounds | null) || null);
    if (!bounds) {
      return [];
    }
    const tm = tms.tileMatrices[z];
    return getTileIndicesInBounds(tm, bounds).map(({x, y}) => ({x, y, z, tm: tm.id}));
  }

  getTileMetadata(index: TileIndex): Record<string, any> {
    const viewport = this._crsViewport;
    const tms = this._tms;
    if (!viewport || !tms) {
      return {};
    }
    const tm = tms.tileMatrices[index.z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tm, index.x, index.y);
    const {transform, extent, commonUnitsPerCRSUnit} = viewport.crs;
    // Tile grids may overflow the CRS extent (e.g. GIBS rows past the poles); clamp the
    // corners into the transform's domain so `inverse` cannot produce non-finite lnglat
    const cx = (v: number) => Math.min(Math.max(v, extent[0]), extent[2]);
    const cy = (v: number) => Math.min(Math.max(v, extent[1]), extent[3]);
    const corners = [
      [cx(minX), cy(minY)],
      [cx(maxX), cy(minY)],
      [cx(minX), cy(maxY)],
      [cx(maxX), cy(maxY)]
    ].map(xy => transform.inverse(xy as [number, number]));
    const lngs = corners.map(c => c[0]);
    const lats = corners.map(c => c[1]);
    return {
      bbox: {
        west: Math.min(...lngs),
        south: Math.min(...lats),
        east: Math.max(...lngs),
        north: Math.max(...lats)
      },
      boundsCRS: [minX, minY, maxX, maxY],
      boundsCommon: [
        (minX - extent[0]) * commonUnitsPerCRSUnit,
        (minY - extent[1]) * commonUnitsPerCRSUnit,
        (maxX - extent[0]) * commonUnitsPerCRSUnit,
        (maxY - extent[1]) * commonUnitsPerCRSUnit
      ]
    };
  }

  getParentIndex(index: TileIndex): CRSTileIndex {
    const tms = this._tms!;
    if (index.z <= 0) {
      // Root level has no parent; callers guard on getTileZoom(index) > minZoom,
      // so return the index unchanged rather than indexing tileMatrices[-1]
      return index as CRSTileIndex;
    }
    const z = index.z - 1;
    const parentTm = tms.tileMatrices[z];
    const tm = tms.tileMatrices[index.z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tm, index.x, index.y);
    // Clamp: grids may overflow the CRS extent unevenly between levels, so a child
    // center can fall just outside the parent matrix — use the nearest valid parent
    const parent = getTileIndexAtPoint(parentTm, [(minX + maxX) / 2, (minY + maxY) / 2], {
      clamp: true
    })!;
    return {x: parent.x, y: parent.y, z, tm: parentTm.id};
  }

  private _getTms(viewport: CRSViewportLike): NormalizedTileMatrixSet {
    const raw = (this.opts as CRSTileset2DProps).tileMatrixSet;
    const code = viewport.crs.code;
    if (!this._tms || raw !== this._rawTms || code !== this._crsCode) {
      // Flush tiles whose metadata (bbox/boundsCommon) and cellSize normalization were
      // computed under a different CRS — they are meaningless after a MapView.crs swap
      if (this._tms && code !== this._crsCode) {
        this.finalize();
      }
      const metersPerUnit = viewport.crs.units === 'degrees' ? METERS_PER_DEGREE : 1;
      this._tms = normalizeTileMatrixSet(raw, {metersPerUnit});
      this._rawTms = raw;
      this._crsCode = code;
      if (raw.crs) {
        // Accept both 'EPSG:32618' and OGC URIs like 'http://www.opengis.net/def/crs/EPSG/0/32618'
        const tmsCode = raw.crs.includes('/') ? `EPSG:${raw.crs.split('/').pop()}` : raw.crs;
        if (tmsCode !== code) {
          // Fires once per (tileMatrixSet, view CRS) combination
          log.warn(`tileMatrixSet CRS (${raw.crs}) does not match the view CRS (${code})`)();
        }
      }
    }
    return this._tms;
  }

  /** View bounds in CRS units: forward-project the unprojected screen corners.
   * A screen corner can unproject outside the transform's domain (e.g. past the horizon
   * at high pitch); such corners fall back to the CRS extent rather than silently
   * shrinking the fetch area — matrix dimensions still bound the tile count.
   * Returns null when the result is empty. */
  private _getViewBoundsCRS(viewport: CRSViewportLike, extentLngLat: Bounds | null): Bounds | null {
    const {width, height} = viewport;
    const corners = [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height]
    ].map(pixel => viewport.unproject(pixel));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hadNonFiniteCorner = false;
    for (const lnglat of corners) {
      const xy = viewport.crs.transform.forward([lnglat[0], lnglat[1]]);
      if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
        minX = Math.min(minX, xy[0]);
        minY = Math.min(minY, xy[1]);
        maxX = Math.max(maxX, xy[0]);
        maxY = Math.max(maxY, xy[1]);
      } else {
        hadNonFiniteCorner = true;
      }
    }
    if (hadNonFiniteCorner) {
      const [eMinX, eMinY, eMaxX, eMaxY] = viewport.crs.extent;
      minX = Math.min(minX, eMinX);
      minY = Math.min(minY, eMinY);
      maxX = Math.max(maxX, eMaxX);
      maxY = Math.max(maxY, eMaxY);
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    if (extentLngLat) {
      // extent option is [west, south, east, north] in lnglat, matching the base class
      const [west, south, east, north] = extentLngLat;
      const projected = [
        [west, south],
        [east, south],
        [west, north],
        [east, north]
      ].map(c => viewport.crs.transform.forward(c as [number, number]));
      minX = Math.max(minX, Math.min(...projected.map(p => p[0])));
      minY = Math.max(minY, Math.min(...projected.map(p => p[1])));
      maxX = Math.min(maxX, Math.max(...projected.map(p => p[0])));
      maxY = Math.min(maxY, Math.max(...projected.map(p => p[1])));
      if (!(minX < maxX) || !(minY < maxY)) {
        return null;
      }
    }
    return [minX, minY, maxX, maxY];
  }
}
