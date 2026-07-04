// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Viewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {Tileset2D, Tileset2DProps} from '../tileset-2d/tileset-2d';
import {getTileBoundsCRS, getTileIndicesInBounds} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {Bounds, TileIndex} from '../tileset-2d/types';
import {makeWebMercatorQuadTms, selectMercatorSourceZoom, MAX_MERCATOR_LATITUDE} from './warp-mesh';
import type {WarpTargetCRS} from './warp-mesh';

type CRSViewportLike = Viewport & {crs: WarpTargetCRS};

/** OSM's deepest commonly served level */
const MAX_SOURCE_LEVELS = 23;

/** Indexes a Web-Mercator XYZ pyramid (OSM, Esri, ...) from a CRS view
 * (a `MapView` with a non-Mercator `crs`). Used by `_WarpedTileLayer`. */
export class MercatorCRSTileset2D extends Tileset2D {
  private _tms: NormalizedTileMatrixSet | null = null;
  private _tmsTileSize: number | null = null;
  private _crsViewport: CRSViewportLike | null = null;
  private _crsCode: string | null = null;

  setOptions(opts: Tileset2DProps): void {
    // Same loop-safety policy as CRSTileset2D: getParentIndex returns the root
    // index unchanged at z 0, so the ancestor walk must never see a negative floor
    if (typeof opts.minZoom === 'number' && opts.minZoom < 0) {
      opts = {...opts, minZoom: 0};
    }
    super.setOptions(opts);
  }

  getTileIndices({
    viewport,
    maxZoom,
    minZoom
  }: Parameters<Tileset2D['getTileIndices']>[0]): TileIndex[] {
    const crsViewport = viewport as CRSViewportLike;
    if (!crsViewport.crs) {
      throw new Error(
        '_WarpedTileLayer requires a CRS view — set the `crs` prop on MapView (use TileLayer in Web Mercator views)'
      );
    }
    // Flush tiles whose metadata/meshes were computed under a different CRS.
    // Note: finalize() drops tiles without firing onTileUnload (same caveat as CRSTileset2D)
    if (this._crsCode !== null && this._crsCode !== crsViewport.crs.code) {
      this.finalize();
      this._tms = null;
    }
    this._crsViewport = crsViewport;
    this._crsCode = crsViewport.crs.code;

    const {tileSize, zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }
    if (!this._tms || this._tmsTileSize !== tileSize) {
      this._tms = makeWebMercatorQuadTms(tileSize, MAX_SOURCE_LEVELS);
      this._tmsTileSize = tileSize;
    }

    let z = selectMercatorSourceZoom(crsViewport, tileSize, zoomOffset);
    if (typeof minZoom === 'number' && Number.isFinite(minZoom) && z < minZoom) {
      // Same policy as the OSM path and CRSTileset2D: without an extent to bound
      // the area, fetching far-below-view minZoom tiles could request the world
      if (!extent) {
        return [];
      }
      z = minZoom;
    }
    if (typeof maxZoom === 'number' && Number.isFinite(maxZoom) && z > maxZoom) {
      z = maxZoom;
    }
    z = Math.max(0, Math.min(z, this._tms.tileMatrices.length - 1));

    const bounds = this._getViewBoundsWorld(crsViewport, (extent as Bounds | null) || null);
    if (!bounds) {
      return [];
    }
    return getTileIndicesInBounds(this._tms.tileMatrices[z], bounds).map(({x, y}) => ({
      x,
      y,
      z
    }));
  }

  getTileMetadata(index: TileIndex): Record<string, any> {
    const tms = this._tms;
    if (!tms) {
      return {};
    }
    const boundsWorld = getTileBoundsCRS(tms.tileMatrices[index.z], index.x, index.y);
    const [west, north] = worldToLngLat([boundsWorld[0], boundsWorld[3]]);
    const [east, south] = worldToLngLat([boundsWorld[2], boundsWorld[1]]);
    return {
      bbox: {west, north, east, south},
      boundsWorld
    };
  }

  getParentIndex(index: TileIndex): TileIndex {
    if (index.z <= 0) {
      return index;
    }
    return {x: index.x >> 1, y: index.y >> 1, z: index.z - 1};
  }

  /** View bounds in 512-unit Mercator world coordinates. Latitudes are clamped to the
   * Mercator domain; non-finite unprojections fall back to the world bounds. */
  private _getViewBoundsWorld(
    viewport: CRSViewportLike,
    extentLngLat: Bounds | null
  ): Bounds | null {
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
      if (Number.isFinite(lnglat[0]) && Number.isFinite(lnglat[1])) {
        const [wx, wy] = lngLatToWorld([
          Math.min(Math.max(lnglat[0], -180), 180),
          Math.min(Math.max(lnglat[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
        ]);
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
      } else {
        hadNonFiniteCorner = true;
      }
    }
    if (hadNonFiniteCorner) {
      minX = Math.min(minX, 0);
      minY = Math.min(minY, 0);
      maxX = Math.max(maxX, 512);
      maxY = Math.max(maxY, 512);
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    if (extentLngLat) {
      const [west, south, east, north] = extentLngLat;
      const [eMinX, eMinY] = lngLatToWorld([
        Math.min(Math.max(west, -180), 180),
        Math.min(Math.max(south, -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
      ]);
      const [eMaxX, eMaxY] = lngLatToWorld([
        Math.min(Math.max(east, -180), 180),
        Math.min(Math.max(north, -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
      ]);
      minX = Math.max(minX, eMinX);
      minY = Math.max(minY, eMinY);
      maxX = Math.min(maxX, eMaxX);
      maxY = Math.min(maxY, eMaxY);
      if (!(minX < maxX) || !(minY < maxY)) {
        return null;
      }
    }
    return [minX, minY, maxX, maxY];
  }
}
