// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {selectTileMatrix, getTileIndicesInBounds, getTileBoundsCRS} from './tile-matrix-set';
import type {NormalizedTileMatrixSet} from './tile-matrix-set';
import type {Bounds} from './types';

/** A tile index in tileset-array-level terms (`z` = position in `tms.tileMatrices`). */
type BandTileIndex = {x: number; y: number; z: number};

/** Just the viewport surface the banded traversal needs (duck-typed so it works for both
 * `CRSViewport` and any viewport exposing `pitch`/`unproject`). */
type PitchedLODViewport = {
  width: number;
  height: number;
  pitch: number;
  unproject: (pixel: number[]) => number[];
};

export type PitchedLODOptions = {
  viewport: PitchedLODViewport;
  tms: NormalizedTileMatrixSet;
  /** lnglat -> the tileset's indexing space (CRS units for `CRSTileset2D`, 512-unit Mercator
   * world units for `MercatorCRSTileset2D`). The caller applies any domain clamp; return a
   * non-finite coordinate to mark a sample invalid (e.g. past the projection domain). */
  forward: (lnglat: [number, number]) => [number, number];
  /** Coarsest level index a far band may select (guards against a minZoom flood).
   * Clamped to `maxLevel` internally, so an out-of-range minZoom (deeper than the TMS)
   * can never index past the end of `tms.tileMatrices`. */
  minLevel: number;
  /** Finest level index any band may select — the caller's single-level (view-center)
   * choice, so the near field is never fetched finer than the unpitched path would. */
  maxLevel: number;
  /** The tileset's `zoomOffset` option: shifts each band's level by this many levels
   * (positive = finer), the same way both callers fold it into their view-center level
   * (`2^-(zoom+zoomOffset)` / `round(z + zoomOffset)`). @default 0 */
  zoomOffset?: number;
  /** Optional clip rect in the indexing space (the caller's extent-intersected view bounds).
   * Each band's footprint is intersected with it before tiles are collected. */
  clipBounds?: Bounds;
};

/** Screen rows above this far/near ground-resolution ratio warrant a coarser far band.
 * Below it the whole view resolves to essentially one level, so the single-level path
 * (which this helper defers to by returning `null`) is already optimal — and, critically,
 * identical to the pre-change behavior. */
const RATIO_THRESHOLD = 1.5;
/** Cap on the number of distance bands. 6 bands span log2 ratios up to ~32x (5 levels),
 * beyond which the extra bands add tiles for diminishing accuracy. */
const MAX_BANDS = 6;

/**
 * Per-region level selection for a pitched view. Both `CRSTileset2D` (CRS-grid space) and
 * `MercatorCRSTileset2D` (Mercator world space) currently pick one level for the whole view
 * and fill its AABB — a documented over-fetch at high pitch, where the far field is drawn at
 * a fraction of the near field's resolution yet fetched at the same fine level.
 *
 * This splits the screen into near->far distance bands, picks each band's level from the
 * ground resolution measured at that band's depth, fills each band's own footprint, and dedups
 * across bands (a coarse far tile is dropped where a finer near band already covers it). It is
 * a small self-contained traversal core, deliberately shared: both tilesets reduce their level
 * choice to `selectTileMatrix(tms, targetUnitsPerPixel)` (proven equivalent to the OSM/Mercator
 * ground-resolution rule for the Mercator source — the WebMercatorQuad TMS's `cellSize` *is*
 * world-units-per-pixel), so the only per-space difference is the injected `forward`.
 *
 * The OSM quadtree BVH-vs-frustum traversal (`getOSMTileIndices`) solves the same problem more
 * precisely, but only for a *quadtree* source: it is NOT reused here because `CRSTileset2D`'s
 * TMS is not a quadtree (matrix dimensions grow irregularly, e.g. GIBS 2->3->5->10; parents are
 * geometric, not `x>>1`), so its per-node refinement and `x>>1` child walk do not apply. A band
 * split needs only per-level `getTileIndicesInBounds`, which every TMS supports.
 *
 * Returns `null` when the view is unpitched, barely pitched (ratio below threshold), or has any
 * non-finite sample. In every such case the caller MUST fall back to its existing single-level
 * path — that is what guarantees the unpitched/near-unpitched case, and the non-finite fallback,
 * are byte-for-byte unchanged.
 *
 * Non-finite samples in practice: `CRSViewport.unproject` always returns FINITE lnglats — screen
 * points above the horizon extrapolate to mirrored/behind-camera ground positions rather than
 * NaN — so the only non-finite trigger is the injected `forward` leaving its projection domain
 * (e.g. a UTM transform past its zone, or a fussy custom CRS). This helper is therefore NOT an
 * above-horizon guard; it relies on the horizon staying off-screen. With deck's default camera
 * (altitude 1.5 -> fovy ~36.9deg) the horizon enters the frame around pitch ~71.5deg, and
 * `MapView`'s default `maxPitch` of 60 keeps well clear of it. Geometric above-horizon detection
 * (ray-vs-ground-plane sign test per sample) is future work if steeper pitches are needed.
 */
export function selectPitchedBandTiles(opts: PitchedLODOptions): BandTileIndex[] | null {
  const {viewport, tms, forward, maxLevel, clipBounds, zoomOffset = 0} = opts;
  // An out-of-range minZoom (deeper than the TMS) must not index past tileMatrices: the
  // caller clamps its own single level to the array, so clamp the band floor the same way.
  const minLevel = Math.min(opts.minLevel, maxLevel);
  const {width, height, pitch} = viewport;

  // Unpitched: near and far are equidistant, so one level is exactly right — defer to the
  // single-level path so its output is bit-identical to the pre-change behavior.
  if (!pitch) {
    return null;
  }

  const sample = (px: number, py: number): [number, number] | null => {
    const lnglat = viewport.unproject([px, py]);
    if (!Number.isFinite(lnglat[0]) || !Number.isFinite(lnglat[1])) {
      return null;
    }
    const xy = forward([lnglat[0], lnglat[1]]);
    if (!Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) {
      return null;
    }
    return [xy[0], xy[1]];
  };

  // Target units per screen pixel at row `y`, measured over a 1px horizontal step at the
  // horizontal center (least distorted there).
  const resAt = (y: number): number | null => {
    const a = sample(width / 2, y);
    const b = sample(width / 2 + 1, y);
    if (!a || !b) {
      return null;
    }
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  };

  const nearRes = resAt(height - 0.5); // bottom row is nearest the camera
  const farRes = resAt(0.5); // top row is farthest
  if (nearRes === null || farRes === null || nearRes <= 0) {
    return null;
  }
  const ratio = farRes / nearRes;
  if (!(ratio > RATIO_THRESHOLD)) {
    return null;
  }

  const nBands = Math.max(2, Math.min(MAX_BANDS, Math.round(Math.log2(ratio)) + 1));

  type Band = {level: number; bounds: Bounds};
  const bands: Band[] = [];
  for (let b = 0; b < nBands; b++) {
    const y0 = (b / nBands) * height;
    const y1 = ((b + 1) / nBands) * height;
    const midRes = resAt((y0 + y1) / 2);
    if (midRes === null || midRes <= 0) {
      return null;
    }
    // zoomOffset shifts the band's target resolution by 2^-zoomOffset — for a dyadic pyramid
    // this moves the selected level by exactly +zoomOffset, matching the callers' view-center
    // formulas (which fold zoomOffset into `maxLevel`), so near bands land on the same level
    // the single-level path would pick.
    const level = Math.max(
      minLevel,
      Math.min(maxLevel, selectTileMatrix(tms, midRes * Math.pow(2, -zoomOffset)))
    );
    // Band footprint AABB from its corners, edge midpoints, and center-edge midpoints — the
    // extra samples keep the hull tight where a curved CRS bows the band's edges.
    const pts = [
      sample(0, y0),
      sample(width, y0),
      sample(0, y1),
      sample(width, y1),
      sample(width / 2, y0),
      sample(width / 2, y1),
      sample(0, (y0 + y1) / 2),
      sample(width, (y0 + y1) / 2)
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      if (!p) {
        return null;
      }
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    let bounds: Bounds = [minX, minY, maxX, maxY];
    if (clipBounds) {
      bounds = [
        Math.max(minX, clipBounds[0]),
        Math.max(minY, clipBounds[1]),
        Math.min(maxX, clipBounds[2]),
        Math.min(maxY, clipBounds[3])
      ];
      if (!(bounds[0] < bounds[2]) || !(bounds[1] < bounds[3])) {
        continue; // band lies entirely outside the extent
      }
    }
    bands.push({level, bounds});
  }
  if (bands.length === 0) {
    return null;
  }

  // Dedup finest->coarsest by CENTER-IN-COVER test: a coarse tile is dropped when its center
  // falls inside the accumulated AABB cover of STRICTLY finer bands (which fill their full AABB
  // rects). Invariant: no holes — a dropped coarse tile's center region is genuinely covered by
  // a finer rect (probes show 0% holes at pitch <= 65). NOT an exact-overlap dedup: a coarse
  // tile STRADDLING a band seam (center outside the finer cover, body partly inside) is kept
  // and double-drawn under the finer tiles — measured ~6-26% of screen pixels double-covered at
  // pitch 65. Accepted: over-draw is visually benign (finer tiles render on top) versus a hole,
  // and exact polygon coverage would cost more than it saves. Tightening (e.g. per-edge cover
  // rects or fractional-overlap tests) is future work. Equal-level bands never cover each
  // other, so cover accumulation is deferred until a whole level is processed.
  const levels = [...new Set(bands.map(band => band.level))].sort((a, c) => c - a);
  const seen = new Set<string>();
  const result: BandTileIndex[] = [];
  let coverMinX = Infinity;
  let coverMinY = Infinity;
  let coverMaxX = -Infinity;
  let coverMaxY = -Infinity;
  const covered = (cx: number, cy: number): boolean =>
    cx >= coverMinX && cx <= coverMaxX && cy >= coverMinY && cy <= coverMaxY;

  for (const level of levels) {
    const tm = tms.tileMatrices[level];
    const groupBounds: Bounds[] = [];
    for (const band of bands) {
      if (band.level !== level) {
        continue;
      }
      groupBounds.push(band.bounds);
      for (const {x, y} of getTileIndicesInBounds(tm, band.bounds)) {
        const key = `${x}/${y}/${level}`;
        if (seen.has(key)) {
          continue;
        }
        const [tMinX, tMinY, tMaxX, tMaxY] = getTileBoundsCRS(tm, x, y);
        if (covered((tMinX + tMaxX) / 2, (tMinY + tMaxY) / 2)) {
          continue; // a finer band already covers this tile's ground
        }
        seen.add(key);
        result.push({x, y, z: level});
      }
    }
    // Now that this whole (finer, for the next iterations) level is placed, grow the cover rect.
    for (const [minX, minY, maxX, maxY] of groupBounds) {
      coverMinX = Math.min(coverMinX, minX);
      coverMinY = Math.min(coverMinY, minY);
      coverMaxX = Math.max(coverMaxX, maxX);
      coverMaxY = Math.max(coverMaxY, maxY);
    }
  }
  return result;
}
