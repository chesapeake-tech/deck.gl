// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {log, Viewport} from '@deck.gl/core';
import {Tileset2D, Tileset2DProps} from '../tileset-2d/tileset-2d';
import {
  getTileBoundsCRS,
  getTileIndicesInBounds,
  getTileIndexAtPoint
} from '../tileset-2d/tile-matrix-set';
import type {TileMatrixSet} from '../tileset-2d/tile-matrix-set';
import type {Bounds, TileIndex} from '../tileset-2d/types';
import {selectPitchedBandTiles} from '../tileset-2d/pitched-lod';
import {resolveWarpSource, selectWarpSourceZoom} from './warp-mesh';
import type {WarpTargetCRS, WarpSourceCrs, ResolvedWarpSource} from './warp-mesh';

type CRSViewportLike = Viewport & {crs: WarpTargetCRS};

/** Options this tileset reads beyond the base `Tileset2DProps` — the source pyramid description
 * forwarded by `_WarpedTileLayer`. Both default to the built-in Web-Mercator source. */
export type MercatorCRSTileset2DProps = Tileset2DProps & {
  sourceTileMatrixSet?: TileMatrixSet | null;
  sourceCrs?: WarpSourceCrs;
};

/** Fallback z cap when fewer than 2 view corners unproject finitely (e.g. the camera points
 * near/above the horizon at a steep pitch). With no reliable corner bbox to bound the fetch,
 * `_getViewBoundsWorld` widens to the whole source grid, so z must stay shallow here: 4^z
 * tiles is 65536 at level 8, versus up to 4^19 if an unclamped deep z were kept. */
const MAX_FALLBACK_SOURCE_ZOOM = 8;

/** Indexes a source raster tile pyramid (a Web-Mercator OSM/Esri pyramid by default, or any TMS
 * source via `sourceTileMatrixSet`/`sourceCrs`) from a CRS view (a `MapView` with a non-Mercator
 * `crs`), for warping by `_WarpedTileLayer`. */
export class MercatorCRSTileset2D extends Tileset2D {
  private _source: ResolvedWarpSource | null = null;
  private _sourceTileSize: number | null = null;
  private _sourceTmsRef: TileMatrixSet | null | undefined = undefined;
  private _sourceCrsRef: WarpSourceCrs | undefined = undefined;
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

    const source = this._getSource();
    const {zoomOffset, visibleMinZoom, visibleMaxZoom, extent} = this.opts;
    if (visibleMinZoom != null && viewport.zoom < visibleMinZoom) {
      return [];
    }
    if (visibleMaxZoom != null && viewport.zoom > visibleMaxZoom) {
      return [];
    }

    let z = selectWarpSourceZoom(crsViewport, source, this.opts.tileSize ?? 256, zoomOffset);
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
    z = Math.max(0, Math.min(z, source.tms.tileMatrices.length - 1));

    const boundsResult = this._getViewBoundsWorld(crsViewport, (extent as Bounds | null) || null);
    if (!boundsResult) {
      return [];
    }
    if (boundsResult.unbounded) {
      // Fewer than 2 corners survived (non-finite unprojection, or out of the source
      // projection's domain): bounds is the whole-source safety net, so cap z or
      // getTileIndicesInBounds could be asked to fill up to 4^z tiles. Note that
      // CRSViewport.unproject itself always returns finite lnglats (even above the horizon —
      // see the pitch envelope note in pitched-lod.ts), so in practice this fires for
      // non-CRSViewport viewports or a source/view domain mismatch.
      z = Math.min(z, MAX_FALLBACK_SOURCE_ZOOM);
      if (!this._warnedUnboundedFallback) {
        this._warnedUnboundedFallback = true;
        log.warn(
          '_WarpedTileLayer: fewer than 2 view corners mapped to a finite source coordinate ' +
            '(unprojection non-finite, or outside the source projection domain) — falling back ' +
            `to a bounded z (${MAX_FALLBACK_SOURCE_ZOOM}) instead of the whole-source bounds ` +
            'at the view-matched level'
        )();
      }
    }
    if (!boundsResult.unbounded) {
      // Pitched view: fetch far tiles coarser and near tiles finer instead of filling the
      // whole view AABB at the single view-center level `z`. Only the finite-corner case is
      // banded; the unbounded fallback above keeps its whole-source + capped-z behavior.
      // `forward` is the source's own lnglat->source-units map (with any domain clamp), exactly
      // as `_getViewBoundsWorld` uses it, so band footprints and single-level bounds agree.
      const banded = selectPitchedBandTiles({
        viewport: crsViewport,
        tms: source.tms,
        forward: source.fromLngLat,
        // Never finer than the view-center level (near band is closer, but fetching finer than
        // the unpitched path would defeats the point); far bands clamp to the flood-guard floor,
        // itself clamped to `z` so an out-of-range minZoom can't index past the TMS. zoomOffset
        // is folded into `z` and passed through so each band applies the same shift.
        minLevel: Math.min(
          Math.max(0, Number.isFinite(minZoom as number) ? (minZoom as number) : 0),
          z
        ),
        maxLevel: z,
        zoomOffset,
        clipBounds: boundsResult.bounds
      });
      if (banded) {
        return banded;
      }
    }

    return getTileIndicesInBounds(source.tms.tileMatrices[z], boundsResult.bounds).map(
      ({x, y}) => ({
        x,
        y,
        z
      })
    );
  }

  getTileMetadata(index: TileIndex): Record<string, any> {
    const source = this._source;
    if (!source) {
      return {};
    }
    // `boundsWorld` keeps its name for the mesh/layer, but now holds the tile rect in the
    // SOURCE pyramid's units (512-unit Mercator world by default, degrees for a 4326 source).
    const boundsWorld = getTileBoundsCRS(source.tms.tileMatrices[index.z], index.x, index.y);
    const [west, north] = source.toLngLat([boundsWorld[0], boundsWorld[3]]);
    const [east, south] = source.toLngLat([boundsWorld[2], boundsWorld[1]]);
    return {
      bbox: {west, north, east, south},
      boundsWorld
    };
  }

  getParentIndex(index: TileIndex): TileIndex {
    if (index.z <= 0) {
      return index;
    }
    const source = this._source;
    // The built-in Web-Mercator source is a strict quadtree — trivial `x>>1` parent (unchanged).
    if (!source || source.isMercator) {
      return {x: index.x >> 1, y: index.y >> 1, z: index.z - 1};
    }
    // A general source TMS need not be a quadtree (e.g. GIBS grows 2->3->5->10), so the parent is
    // the level-(z-1) tile containing this tile's center, mirroring CRSTileset2D.getParentIndex.
    const z = index.z - 1;
    const parentTm = source.tms.tileMatrices[z];
    const [minX, minY, maxX, maxY] = getTileBoundsCRS(
      source.tms.tileMatrices[index.z],
      index.x,
      index.y
    );
    const parent = getTileIndexAtPoint(parentTm, [(minX + maxX) / 2, (minY + maxY) / 2], {
      clamp: true
    })!;
    return {x: parent.x, y: parent.y, z};
  }

  /** Resolve (and memoize) the source pyramid from tileSize/sourceTileMatrixSet/sourceCrs. The
   * source depends only on those props, NOT on the view CRS — that is what lets one tileset warp
   * the same source into any CRS view, so a CRS swap deliberately does not reset it. A change of
   * the source props themselves DOES flush cached tiles (mirroring the `_crsCode` flush in
   * `getTileIndices`): cached indices/`boundsWorld`/meshes were computed against the old source
   * grid and are meaningless under the new one. Same `finalize()` caveat: tiles are dropped
   * without firing `onTileUnload`. */
  private _getSource(): ResolvedWarpSource {
    const {sourceTileMatrixSet, sourceCrs} = this.opts as MercatorCRSTileset2DProps;
    const tileSize = this.opts.tileSize ?? 256;
    if (
      !this._source ||
      this._sourceTileSize !== tileSize ||
      this._sourceTmsRef !== (sourceTileMatrixSet ?? null) ||
      this._sourceCrsRef !== (sourceCrs ?? null)
    ) {
      if (this._source) {
        this.finalize();
      }
      this._source = resolveWarpSource({tileSize, sourceTileMatrixSet, sourceCrs});
      this._sourceTileSize = tileSize;
      this._sourceTmsRef = sourceTileMatrixSet ?? null;
      this._sourceCrsRef = sourceCrs ?? null;
    }
    return this._source;
  }

  /** View bounds in source-pyramid units. lnglat corners are mapped through the source's own
   * `fromLngLat`; a corner only counts as finite when BOTH the unprojection and the source
   * projection are finite. `sourceCrs.transform.forward` SHOULD clamp out-of-domain input to
   * its domain edge (like the built-in Mercator source does with its latitude clamp) so the
   * fetch area stays tight — but a forward that returns NaN outside its domain is tolerated:
   * the poisoned corner is skipped instead of nulling the whole bounds (which would silently
   * select ZERO tiles whenever any view corner leaves the source domain). When at least 2
   * corners survive, their bbox is used as-is; with fewer, there's no reliable bbox, so bounds
   * fall back to the whole source grid and `unbounded: true` tells the caller to also clamp z
   * (see `MAX_FALLBACK_SOURCE_ZOOM`). */
  private _getViewBoundsWorld(
    viewport: CRSViewportLike,
    extentLngLat: Bounds | null
  ): {bounds: Bounds; unbounded: boolean} | null {
    const source = this._getSource();
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
      if (!Number.isFinite(lnglat[0]) || !Number.isFinite(lnglat[1])) {
        continue;
      }
      const [wx, wy] = source.fromLngLat([lnglat[0], lnglat[1]]);
      if (!Number.isFinite(wx) || !Number.isFinite(wy)) {
        // Out of the source projection's domain — skip like a non-finite corner
        continue;
      }
      finiteCorners++;
      minX = Math.min(minX, wx);
      minY = Math.min(minY, wy);
      maxX = Math.max(maxX, wx);
      maxY = Math.max(maxY, wy);
    }
    const unbounded = finiteCorners < 2;
    if (unbounded) {
      const [sMinX, sMinY, sMaxX, sMaxY] = source.sourceBounds;
      minX = Math.min(minX, sMinX);
      minY = Math.min(minY, sMinY);
      maxX = Math.max(maxX, sMaxX);
      maxY = Math.max(maxY, sMaxY);
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    if (extentLngLat) {
      const [west, south, east, north] = extentLngLat;
      const [eMinX, eMinY] = source.fromLngLat([west, south]);
      const [eMaxX, eMaxY] = source.fromLngLat([east, north]);
      // Same domain tolerance as the corners: only intersect with the extent when both of its
      // projections are finite; otherwise skip the clamp (bounds stay corner-derived).
      if (
        Number.isFinite(eMinX) &&
        Number.isFinite(eMinY) &&
        Number.isFinite(eMaxX) &&
        Number.isFinite(eMaxY)
      ) {
        minX = Math.max(minX, Math.min(eMinX, eMaxX));
        minY = Math.max(minY, Math.min(eMinY, eMaxY));
        maxX = Math.min(maxX, Math.max(eMinX, eMaxX));
        maxY = Math.min(maxY, Math.max(eMinY, eMaxY));
        if (!(minX < maxX) || !(minY < maxY)) {
          return null;
        }
      }
    }
    return {bounds: [minX, minY, maxX, maxY], unbounded};
  }
}
