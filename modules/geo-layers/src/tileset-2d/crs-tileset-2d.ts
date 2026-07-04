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
  private _crsWarned = false;

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
    const corners = [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY]
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
    const z = index.z - 1;
    const parentTm = tms.tileMatrices[z];
    const tm = tms.tileMatrices[index.z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(tm, index.x, index.y);
    const parent = getTileIndexAtPoint(parentTm, [(minX + maxX) / 2, (minY + maxY) / 2]);
    if (!parent) {
      return {x: 0, y: 0, z, tm: parentTm.id};
    }
    return {x: parent.x, y: parent.y, z, tm: parentTm.id};
  }

  private _getTms(viewport: CRSViewportLike): NormalizedTileMatrixSet {
    const raw = (this.opts as CRSTileset2DProps).tileMatrixSet;
    if (!this._tms || raw !== this._rawTms) {
      const metersPerUnit = viewport.crs.units === 'degrees' ? METERS_PER_DEGREE : 1;
      this._tms = normalizeTileMatrixSet(raw, {metersPerUnit});
      this._rawTms = raw;
      if (raw.crs && !this._crsWarned) {
        // Accept both 'EPSG:32618' and OGC URIs like 'http://www.opengis.net/def/crs/EPSG/0/32618'
        const code = raw.crs.includes('/') ? `EPSG:${raw.crs.split('/').pop()}` : raw.crs;
        if (code !== viewport.crs.code) {
          log.warn(
            `tileMatrixSet CRS (${raw.crs}) does not match the view CRS (${viewport.crs.code})`
          )();
          this._crsWarned = true;
        }
      }
    }
    return this._tms;
  }

  /** View bounds in CRS units: forward-project the unprojected screen corners.
   * Returns null when no corner projects to a finite position. */
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
    for (const lnglat of corners) {
      const xy = viewport.crs.transform.forward([lnglat[0], lnglat[1]]);
      if (Number.isFinite(xy[0]) && Number.isFinite(xy[1])) {
        minX = Math.min(minX, xy[0]);
        minY = Math.min(minY, xy[1]);
        maxX = Math.max(maxX, xy[0]);
        maxY = Math.max(maxY, xy[1]);
      }
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
