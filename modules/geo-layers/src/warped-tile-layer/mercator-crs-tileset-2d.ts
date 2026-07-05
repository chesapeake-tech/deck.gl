// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log, Viewport} from '@deck.gl/core';
import {lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {Tileset2D, Tileset2DProps} from '../tileset-2d/tileset-2d';
import {getTileBoundsCRS, getTileIndicesInBounds} from '../tileset-2d/tile-matrix-set';
import type {NormalizedTileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {Bounds, TileIndex} from '../tileset-2d/types';
import {selectPitchedBandTiles} from '../tileset-2d/pitched-lod';
import {makeWebMercatorQuadTms, selectMercatorSourceZoom, MAX_MERCATOR_LATITUDE} from './warp-mesh';
import type {WarpTargetCRS} from './warp-mesh';

type CRSViewportLike = Viewport & {crs: WarpTargetCRS};

/** Number of source Web-Mercator pyramid levels to build (indices 0..22) — 22 is OSM's
 * deepest commonly served level, so 23 levels covers it. */
const MAX_SOURCE_LEVELS = 23;

/** Fallback z cap when fewer than 2 view corners unproject finitely (e.g. the camera points
 * near/above the horizon at a steep pitch). With no reliable corner bbox to bound the fetch,
 * `_getViewBoundsWorld` widens to the whole Mercator world, so z must stay shallow here: 4^z
 * tiles is 65536 at level 8, versus up to 4^19 if an unclamped deep z were kept. */
const MAX_FALLBACK_SOURCE_ZOOM = 8;

/** Indexes a Web-Mercator XYZ pyramid (OSM, Esri, ...) from a CRS view
 * (a `MapView` with a non-Mercator `crs`). Used by `_WarpedTileLayer`. */
export class MercatorCRSTileset2D extends Tileset2D {
  private _tms: NormalizedTileMatrixSet | null = null;
  private _tmsTileSize: number | null = null;
  private _crsCode: string | null = null;
  private _warnedUnboundedFallback = false;

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
    }
    this._crsCode = crsViewport.crs.code;

    const {tileSize, zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }
    if (!this._tms || this._tmsTileSize !== tileSize) {
      // The source Web-Mercator pyramid only depends on tileSize, not on the view's CRS
      // (that's what makes this tileset able to warp the same pyramid into any CRS view),
      // so a CRS swap above deliberately does not reset `_tms`.
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

    const boundsResult = this._getViewBoundsWorld(crsViewport, (extent as Bounds | null) || null);
    if (!boundsResult) {
      return [];
    }
    if (boundsResult.unbounded) {
      // Fewer than 2 corners unprojected finitely: bounds is the whole-world safety net,
      // so cap z or getTileIndicesInBounds could be asked to fill up to 4^z tiles
      z = Math.min(z, MAX_FALLBACK_SOURCE_ZOOM);
      if (!this._warnedUnboundedFallback) {
        this._warnedUnboundedFallback = true;
        log.warn(
          '_WarpedTileLayer: fewer than 2 view corners unprojected to a finite lnglat (camera ' +
            `likely pointed near/above the horizon) — falling back to a bounded z (${MAX_FALLBACK_SOURCE_ZOOM}) ` +
            'instead of the whole-world bounds at the view-matched level'
        )();
      }
    }
    if (!boundsResult.unbounded) {
      // Pitched view: fetch far tiles coarser and near tiles finer instead of filling the
      // whole view AABB at the single view-center level `z`. Only the finite-corner case is
      // banded; the unbounded fallback above keeps its whole-world + capped-z behavior.
      // `forward` clamps lnglat into the Mercator domain exactly as `_getViewBoundsWorld` does,
      // so band footprints and the single-level bounds are computed the same way.
      const banded = selectPitchedBandTiles({
        viewport: crsViewport,
        tms: this._tms,
        forward: (lnglat: [number, number]) =>
          lngLatToWorld([
            Math.min(Math.max(lnglat[0], -180), 180),
            Math.min(Math.max(lnglat[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
          ]),
        // Never finer than the view-center level (near band is closer, but fetching finer than
        // the unpitched path would defeats the point); far bands clamp to the flood-guard floor.
        minLevel: Math.max(0, Number.isFinite(minZoom as number) ? (minZoom as number) : 0),
        maxLevel: z,
        clipBounds: boundsResult.bounds
      });
      if (banded) {
        return banded;
      }
    }

    return getTileIndicesInBounds(this._tms.tileMatrices[z], boundsResult.bounds).map(({x, y}) => ({
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
   * Mercator domain. When at least 2 corners unproject finitely, their bbox is used as-is;
   * with fewer, there's no reliable bbox, so bounds fall back to the whole world and
   * `unbounded: true` tells the caller to also clamp z (see `MAX_FALLBACK_SOURCE_ZOOM`). */
  private _getViewBoundsWorld(
    viewport: CRSViewportLike,
    extentLngLat: Bounds | null
  ): {bounds: Bounds; unbounded: boolean} | null {
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
    let finiteCorners = 0;
    for (const lnglat of corners) {
      if (Number.isFinite(lnglat[0]) && Number.isFinite(lnglat[1])) {
        finiteCorners++;
        const [wx, wy] = lngLatToWorld([
          Math.min(Math.max(lnglat[0], -180), 180),
          Math.min(Math.max(lnglat[1], -MAX_MERCATOR_LATITUDE), MAX_MERCATOR_LATITUDE)
        ]);
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
      }
    }
    const unbounded = finiteCorners < 2;
    if (unbounded) {
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
    return {bounds: [minX, minY, maxX, maxY], unbounded};
  }
}
