// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import log from '../utils/log';

/** Width of the common-space world at zoom 0. Matches Web Mercator's world size. */
export const CRS_WORLD_SIZE = 512;

/** Meters per degree of latitude (Earth circumference / 360). Matches @math.gl/web-mercator. */
const METERS_PER_DEGREE = 4.003e7 / 360;

/** Finite-difference step for Jacobian estimation, in degrees (~1 meter) */
const JACOBIAN_STEP = 1e-5;

/** Finite-difference step for Hessian (second derivative) estimation, in degrees.
 * Second differences divide by h^2 and so amplify floating-point rounding error
 * much more than the first-order Jacobian's h: with double precision (~1e-16 relative
 * error) and h = JACOBIAN_STEP (1e-5), the h^2 term in the denominator (1e-10) would
 * amplify rounding noise in `lngLatToCommon` (itself built from several floating-point
 * operations, e.g. a full proj4 transform) to ~1e-6 absolute in the second derivative -
 * comparable to or larger than the quadratic term we're trying to resolve at
 * continental extents. A larger step (5e-3 degrees, ~500 m) keeps the rounding
 * contribution negligible while still being small relative to the length scale over
 * which the curvature of common projections varies (see crs-utils.node.spec.ts for the
 * numerical validation of this choice, and its effect on the second-order error bound). */
const HESSIAN_STEP = 5e-3;

export type CRSTransform = {
  /** Project [longitude, latitude] in WGS84 degrees to [x, y] in CRS units */
  forward: (lnglat: [number, number]) => [number, number];
  /** Unproject [x, y] in CRS units to [longitude, latitude] in WGS84 degrees */
  inverse: (xy: [number, number]) => [number, number];
};

export type CRSDefinition = {
  /** Identifier, e.g. 'EPSG:32618'. Used for viewport equality checks and debugging. */
  code: string;
  transform: CRSTransform;
  /** [minX, minY, maxX, maxY] valid bounds in CRS units. Defines the common-space world scale.
   * Exactly one of `extent`/`extentGeographic` must be provided; if both are given, `extent`
   * is used and `extentGeographic` is ignored. */
  extent?: [number, number, number, number];
  /** [west, south, east, north] valid bounds in WGS84 degrees - a convenience for CRSs (e.g. a
   * single UTM zone) where a geographic bbox is at hand but the projected `extent` is not.
   * Derived into a projected extent by densifying the boundary (~8 samples per edge) through
   * `transform.forward` and taking the bounding box of the finite results. This is an
   * approximation of the true (possibly curved) projected boundary - most accurate for the
   * roughly-rectangular boundaries typical of UTM-class zones, and not a substitute for an
   * exact `extent` when one is available. Ignored if `extent` is also provided. */
  extentGeographic?: [number, number, number, number];
  /** CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default 'meters'. */
  units?: 'meters' | 'degrees';
};

/** CRSDefinition with `units` defaulted (no longer optional), `extent` resolved (no longer
 * optional, and no longer alongside `extentGeographic`), and its derived world scale. */
export type NormalizedCRS = CRSDefinition & {
  /** [minX, minY, maxX, maxY] valid bounds in CRS units - explicit, or derived from
   * `extentGeographic` by `normalizeCRS`. */
  extent: [number, number, number, number];
  units: 'meters' | 'degrees';
  /** Common units per CRS unit: CRS_WORLD_SIZE / extent width */
  commonUnitsPerCRSUnit: number;
};

/** Samples per boundary edge when deriving a projected extent from `extentGeographic`.
 * Dense enough to bound the curvature of typical projections without materially over- or
 * under-shooting the true curved boundary for UTM-class zones (see crs-utils.node.spec.ts
 * for the ~1% tolerance this achieves against a known UTM 18N extent). */
const EXTENT_GEOGRAPHIC_SAMPLES = 8;

/** Sample points along the four edges of a WGS84 [west, south, east, north] bbox, at
 * `EXTENT_GEOGRAPHIC_SAMPLES` points per edge. */
function densifyGeographicBoundary(
  extentGeographic: [number, number, number, number]
): [number, number][] {
  const [west, south, east, north] = extentGeographic;
  const n = EXTENT_GEOGRAPHIC_SAMPLES;
  const boundary: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const lng = west + t * (east - west);
    const lat = south + t * (north - south);
    boundary.push([lng, north]); // top edge
    boundary.push([lng, south]); // bottom edge
    boundary.push([west, lat]); // left edge
    boundary.push([east, lat]); // right edge
  }
  return boundary;
}

/** Bounding box of the finite `transform.forward` results over a set of lnglat samples,
 * plus how many of them were finite. */
function boundingBoxOfFiniteProjections(
  boundary: [number, number][],
  transform: CRSTransform
): {minX: number; minY: number; maxX: number; maxY: number; finiteCount: number} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let finiteCount = 0;
  for (const lnglat of boundary) {
    const xy = transform.forward(lnglat);
    if (isFinite2(xy)) {
      finiteCount++;
      minX = Math.min(minX, xy[0]);
      minY = Math.min(minY, xy[1]);
      maxX = Math.max(maxX, xy[0]);
      maxY = Math.max(maxY, xy[1]);
    }
  }
  return {minX, minY, maxX, maxY, finiteCount};
}

/** Derive a projected [minX, minY, maxX, maxY] extent from a WGS84 [west, south, east, north]
 * bbox: densify the boundary and take the bbox of the finite `transform.forward` results.
 * Throws if fewer than 4 samples are finite (the CRS's domain likely doesn't cover this
 * geographic bbox) or if the resulting bbox is degenerate. */
function deriveExtentFromGeographic(
  code: string,
  transform: CRSTransform,
  extentGeographic: [number, number, number, number]
): [number, number, number, number] {
  const boundary = densifyGeographicBoundary(extentGeographic);
  const {minX, minY, maxX, maxY, finiteCount} = boundingBoxOfFiniteProjections(boundary, transform);
  if (finiteCount < 4) {
    throw new Error(
      `CRS ${code}: extentGeographic [${extentGeographic}] produced fewer than 4 finite samples ` +
        `when transformed with transform.forward - the CRS's domain likely does not cover this ` +
        `geographic bbox`
    );
  }
  if (!(maxX > minX) || !(maxY > minY)) {
    throw new Error(
      `CRS ${code}: extentGeographic [${extentGeographic}] produced a degenerate projected extent ` +
        `[${minX}, ${minY}, ${maxX}, ${maxY}]`
    );
  }
  return [minX, minY, maxX, maxY];
}

const EPSG_4326: CRSDefinition = {
  code: 'EPSG:4326',
  transform: {
    forward: lnglat => [lnglat[0], lnglat[1]],
    inverse: xy => [xy[0], xy[1]]
  },
  extent: [-180, -90, 180, 90],
  units: 'degrees'
};

export function normalizeCRS(crs: CRSDefinition | string): NormalizedCRS {
  let definition: CRSDefinition;
  if (typeof crs === 'string') {
    if (crs === 'EPSG:4326') {
      definition = EPSG_4326;
    } else {
      throw new Error(
        `Unknown CRS: ${crs}. Only 'EPSG:4326' is built in; pass a CRSDefinition with a transform for other CRSs.`
      );
    }
  } else {
    definition = crs;
  }

  const {code, transform, extent: explicitExtent, extentGeographic, units = 'meters'} = definition;
  if (explicitExtent && extentGeographic) {
    log.warn(
      `CRS ${code}: both extent and extentGeographic were provided; extent takes precedence`
    )();
  }
  const extent =
    explicitExtent ??
    (extentGeographic && deriveExtentFromGeographic(code, transform, extentGeographic));
  if (!extent || !(extent[2] > extent[0]) || !(extent[3] > extent[1])) {
    throw new Error(`CRS ${code}: extent must be [minX, minY, maxX, maxY] with positive size`);
  }

  const commonUnitsPerCRSUnit = CRS_WORLD_SIZE / (extent[2] - extent[0]);
  const normalized: NormalizedCRS = {code, transform, extent, units, commonUnitsPerCRSUnit};

  // Validate that the transform round-trips at the extent center
  const centerLngLat = transform.inverse([
    (extent[0] + extent[2]) / 2,
    (extent[1] + extent[3]) / 2
  ]);
  const centerXY = transform.forward(centerLngLat);
  if (!Number.isFinite(centerLngLat[0] + centerLngLat[1] + centerXY[0] + centerXY[1])) {
    throw new Error(`CRS ${code}: transform failed to round-trip the extent center`);
  }

  return normalized;
}

/** Project [lng, lat] to common space: CRS units offset by extent min, scaled to the 512 world */
export function lngLatToCommon(crs: NormalizedCRS, lnglat: number[]): [number, number] {
  const [x, y] = crs.transform.forward([lnglat[0], lnglat[1]]);
  return [
    (x - crs.extent[0]) * crs.commonUnitsPerCRSUnit,
    (y - crs.extent[1]) * crs.commonUnitsPerCRSUnit
  ];
}

export function commonToLngLat(crs: NormalizedCRS, xy: number[]): [number, number] {
  return crs.transform.inverse([
    xy[0] / crs.commonUnitsPerCRSUnit + crs.extent[0],
    xy[1] / crs.commonUnitsPerCRSUnit + crs.extent[1]
  ]);
}

function isFinite2(xy: number[]): boolean {
  return Number.isFinite(xy[0]) && Number.isFinite(xy[1]);
}

/** Max cached (lng, lat) origins per CRS, per memoized function, before the oldest
 * (least-recently-used) entries are evicted. `getCRSJacobianAtOrigin`/`getCRSHessianAtOrigin`/
 * `getCRSMetersJacobianAtOrigin` are pure functions of (crs, origin) - independent of
 * zoom/pan/viewMatrix - but are invoked once per sublayer origin, every frame
 * (see viewport-uniforms.ts's `getUniformsFromViewport`). Memoizing them turns a
 * multi-million-call-per-zoom-sweep proj-wasm hot path into O(distinct origins). Origins
 * recur across frames (view center, per-tile origins) but a long pan/zoom session could in
 * principle produce unbounded distinct origins, so each per-CRS cache is bounded to this
 * many entries with LRU eviction. */
const MAX_ORIGIN_CACHE_ENTRIES_PER_CRS = 1024;

/** Per-(crs, origin) memoization cache. Keyed on the `NormalizedCRS` object identity via a
 * `WeakMap` (rather than `crs.code`, since two different `CRSDefinition`/`NormalizedCRS`
 * instances could share a code) so a new crs object always gets a fresh cache and is
 * automatically released when the crs object itself is garbage collected. Nested `Map` is
 * keyed on the exact numeric (lng, lat) - stable and collision-free since JS's default
 * number-to-string conversion round-trips any double - with LRU eviction bounded by
 * {@link MAX_ORIGIN_CACHE_ENTRIES_PER_CRS}. */
function memoizedByOrigin<T>(
  cache: WeakMap<NormalizedCRS, Map<string, T>>,
  crs: NormalizedCRS,
  lnglat: number[],
  compute: () => T
): T {
  let perCRS = cache.get(crs);
  if (!perCRS) {
    perCRS = new Map();
    cache.set(crs, perCRS);
  }
  const key = `${lnglat[0]},${lnglat[1]}`;
  if (perCRS.has(key)) {
    const cached = perCRS.get(key) as T;
    // Re-inserting moves the key to the end of Map's iteration order, marking it
    // most-recently-used for the LRU eviction below.
    perCRS.delete(key);
    perCRS.set(key, cached);
    return cached;
  }
  const result = compute();
  if (perCRS.size >= MAX_ORIGIN_CACHE_ENTRIES_PER_CRS) {
    const oldestKey = perCRS.keys().next().value;
    if (oldestKey !== undefined) {
      perCRS.delete(oldestKey);
    }
  }
  perCRS.set(key, result);
  return result;
}

const jacobianCache = new WeakMap<NormalizedCRS, Map<string, [number, number, number, number]>>();
const metersJacobianCache = new WeakMap<
  NormalizedCRS,
  Map<string, [number, number, number, number]>
>();
const hessianCache = new WeakMap<NormalizedCRS, Map<string, CRSHessian>>();

/** d(common) / d(degrees) along one lnglat axis, by finite differences.
 * Falls back to one-sided differences at the edge of the CRS domain. */
function partialDerivative(crs: NormalizedCRS, lnglat: number[], axis: 0 | 1): [number, number] {
  const hi: number[] = [lnglat[0], lnglat[1]];
  const lo: number[] = [lnglat[0], lnglat[1]];
  hi[axis] += JACOBIAN_STEP;
  lo[axis] -= JACOBIAN_STEP;

  let p1 = lngLatToCommon(crs, hi);
  let p0 = lngLatToCommon(crs, lo);
  let h = 2 * JACOBIAN_STEP;
  if (!isFinite2(p1)) {
    p1 = lngLatToCommon(crs, lnglat);
    h = JACOBIAN_STEP;
  } else if (!isFinite2(p0)) {
    p0 = lngLatToCommon(crs, lnglat);
    h = JACOBIAN_STEP;
  }
  if (!isFinite2(p0) || !isFinite2(p1)) {
    throw new Error(`CRS ${crs.code}: transform is not differentiable at [${lnglat}]`);
  }
  return [(p1[0] - p0[0]) / h, (p1[1] - p0[1]) / h];
}

/** Column-major 2x2 Jacobian of the lnglat->common transform at the given position:
 * [dX/dlng, dY/dlng, dX/dlat, dY/dlat] in common units per degree */
export function getCRSJacobian(
  crs: NormalizedCRS,
  lnglat: number[]
): [number, number, number, number] {
  return memoizedByOrigin(jacobianCache, crs, lnglat, () => {
    const dLng = partialDerivative(crs, lnglat, 0);
    const dLat = partialDerivative(crs, lnglat, 1);
    return [dLng[0], dLng[1], dLat[0], dLat[1]];
  });
}

/** Column-major 2x2 Jacobian of the lnglat->common transform, expressed in common units
 * per METER (east, north) rather than per degree (lng, lat), at the given position:
 * `[dX/dMeterEast, dY/dMeterEast, dX/dMeterNorth, dY/dMeterNorth]`.
 *
 * Derived from {@link getCRSJacobian} via the chain rule - `J_meters = J_degrees * D`,
 * where `D` is the local degrees-per-meter diagonal (`1 / (METERS_PER_DEGREE * cos(lat))`
 * for east, `1 / METERS_PER_DEGREE` for north, both using the same spherical-Earth
 * `METERS_PER_DEGREE` constant `lngLatToCommon`'s siblings already rely on). This reuses
 * the validated finite-difference machinery of `getCRSJacobian` rather than
 * re-differentiating `lngLatToCommon` directly with meter-scale steps: a from-scratch
 * finite difference would still need this same degrees-per-meter conversion to choose a
 * step size in degrees, plus introduce a second free step-size to tune and validate
 * independently of `JACOBIAN_STEP` (see the comment above `HESSIAN_STEP` for how
 * sensitive that kind of choice is) - for no accuracy benefit, since the chain rule is
 * exact wherever the first-order Jacobian itself is a valid local approximation.
 *
 * Used to project `COORDINATE_SYSTEM.METER_OFFSETS` data relative to a
 * `coordinateOrigin` that may be far from the view center: grid convergence at that
 * origin - not just its diagonal (isotropic) scale - must be applied to offsets from it,
 * the same way {@link getCRSJacobian} applies it to absolute `LNGLAT` positions relative
 * to the view center. See crs-viewport.md's Limitations section for the remaining
 * caveat (curvature error accumulates for offsets spanning >~100km from their origin). */
export function getCRSMetersJacobian(
  crs: NormalizedCRS,
  lnglat: number[]
): [number, number, number, number] {
  return memoizedByOrigin(metersJacobianCache, crs, lnglat, () => {
    // Reuses getCRSJacobian's own (crs, origin) memoization - a cache hit here costs no
    // extra proj-wasm calls even on a cache miss for this function.
    const [dXdLng, dYdLng, dXdLat, dYdLat] = getCRSJacobian(crs, lnglat);
    const degLngPerMeterEast = 1 / (METERS_PER_DEGREE * Math.cos((lnglat[1] * Math.PI) / 180));
    const degLatPerMeterNorth = 1 / METERS_PER_DEGREE;
    return [
      dXdLng * degLngPerMeterEast,
      dYdLng * degLngPerMeterEast,
      dXdLat * degLatPerMeterNorth,
      dYdLat * degLatPerMeterNorth
    ];
  });
}

/** Second-order (quadratic) coefficients of the lnglat->common transform at the given
 * position, per output component: `[d2/dlng2, d2/dlng*dlat, d2/dlat2]` in common units
 * per degree^2. Used to extend the first-order Jacobian approximation with a
 * `+ 0.5 * H(delta)` quadratic correction term, reducing the shader's local
 * linearization error from quadratic to cubic in distance from the origin.
 *
 * Estimated via second-order central finite differences (see HESSIAN_STEP for the
 * step-size rationale). Falls back to all-zero coefficients (structurally a no-op,
 * degrading gracefully to the first-order-only approximation) if any sample needed
 * for the stencil is non-finite (e.g. near the domain edge of the CRS transform) -
 * this function must never return NaN. */
export type CRSHessian = {
  x: [number, number, number];
  y: [number, number, number];
};

const ZERO_HESSIAN: CRSHessian = {x: [0, 0, 0], y: [0, 0, 0]};

export function getCRSHessian(crs: NormalizedCRS, lnglat: number[]): CRSHessian {
  return memoizedByOrigin(hessianCache, crs, lnglat, () => {
    const h = HESSIAN_STEP;
    const [lng, lat] = lnglat;

    const center = lngLatToCommon(crs, [lng, lat]);
    const pLngHi = lngLatToCommon(crs, [lng + h, lat]);
    const pLngLo = lngLatToCommon(crs, [lng - h, lat]);
    const pLatHi = lngLatToCommon(crs, [lng, lat + h]);
    const pLatLo = lngLatToCommon(crs, [lng, lat - h]);
    const pPP = lngLatToCommon(crs, [lng + h, lat + h]);
    const pPM = lngLatToCommon(crs, [lng + h, lat - h]);
    const pMP = lngLatToCommon(crs, [lng - h, lat + h]);
    const pMM = lngLatToCommon(crs, [lng - h, lat - h]);

    const samples = [center, pLngHi, pLngLo, pLatHi, pLatLo, pPP, pPM, pMP, pMM];
    if (!samples.every(isFinite2)) {
      return ZERO_HESSIAN;
    }

    const h2 = h * h;
    const dLngLng: [number, number] = [
      (pLngHi[0] - 2 * center[0] + pLngLo[0]) / h2,
      (pLngHi[1] - 2 * center[1] + pLngLo[1]) / h2
    ];
    const dLatLat: [number, number] = [
      (pLatHi[0] - 2 * center[0] + pLatLo[0]) / h2,
      (pLatHi[1] - 2 * center[1] + pLatLo[1]) / h2
    ];
    const dLngLat: [number, number] = [
      (pPP[0] - pPM[0] - pMP[0] + pMM[0]) / (4 * h2),
      (pPP[1] - pPM[1] - pMP[1] + pMM[1]) / (4 * h2)
    ];

    const hessian: CRSHessian = {
      x: [dLngLng[0], dLngLat[0], dLatLat[0]],
      y: [dLngLng[1], dLngLat[1], dLatLat[1]]
    };
    if (![...hessian.x, ...hessian.y].every(Number.isFinite)) {
      return ZERO_HESSIAN;
    }
    return hessian;
  });
}

/** Standard surveying grid convergence angle (γ), in degrees, at the given lnglat position.
 *
 * Sign convention (matches the surveying-standard `True Azimuth = Grid Azimuth + γ`, e.g.
 * Snyder's UTM convergence formula and the National Geodetic Survey's definition of
 * convergence as "from true meridian to grid meridian"): **positive γ means grid north lies
 * clockwise (east) of true north; equivalently, true north lies counterclockwise (west) of
 * grid north.** For example, east of a UTM zone's central meridian in the Northern
 * Hemisphere, meridians lean toward the central meridian as latitude increases, so true
 * north (the local meridian tangent) points slightly west of grid north (the zone's
 * constant-easting grid line) there - a positive γ, matching the classic
 * `γ ≈ Δlng * sin(lat)` small-angle formula (positive when east of the central meridian in
 * the Northern Hemisphere).
 *
 * Derived from {@link getCRSJacobian}'s "east" column (∂common/∂lng), which - because the
 * Jacobian is, to first order, a conformal (rotation + isotropic scale) map - has rotated
 * away from the common-space +X axis by exactly the same angle grid north's own +Y axis has
 * rotated away from true north, under this sign convention. So
 * `atan2(dY/dlng, dX/dlng)` (the east column's angle from +X, standard counterclockwise-
 * positive convention) equals γ directly, with no extra sign flip - verified against the
 * known UTM 18N answer in crs-utils.node.spec.ts.
 */
export function getCRSConvergence(crs: NormalizedCRS, lnglat: number[]): number {
  const jacobian = getCRSJacobian(crs, lnglat);
  return (Math.atan2(jacobian[1], jacobian[0]) * 180) / Math.PI;
}

/** Common units per meter of elevation, derived from the meridional scale at the position.
 * For a meters-based CRS this is ~commonUnitsPerCRSUnit; for a degrees CRS it accounts
 * for the degree/meter ratio. */
function getUnitsPerMeter(jacobian: [number, number, number, number]): number {
  return Math.hypot(jacobian[2], jacobian[3]) / METERS_PER_DEGREE;
}

/** Clamp a lnglat position so that its projection lies inside the CRS extent.
 * Works in CRS space: project, clamp XY to the extent, unproject. If the forward
 * transform is not finite at the input, falls back to the extent center. */
export function clampLngLatToCRSExtent(
  crs: NormalizedCRS,
  lnglat: [number, number]
): [number, number] {
  const [minX, minY, maxX, maxY] = crs.extent;
  let xy = crs.transform.forward(lnglat);
  if (!isFinite2(xy)) {
    xy = [(minX + maxX) / 2, (minY + maxY) / 2];
  }
  const clampedX = Math.min(Math.max(xy[0], minX), maxX);
  const clampedY = Math.min(Math.max(xy[1], minY), maxY);
  if (clampedX === xy[0] && clampedY === xy[1]) {
    return lnglat;
  }
  return crs.transform.inverse([clampedX, clampedY]);
}

/** A proj4-style converter: proj4's own `Converter` (`.forward`/`.inverse`) or
 * `@math.gl/proj4`'s `Proj4Projection` (`.project`/`.unproject`). Either naming is accepted
 * by `createProj4CRS`, so callers can pass whichever they already have on hand without
 * writing an adapter. */
export type Proj4LikeConverter =
  | {
      forward: (lnglat: [number, number]) => [number, number];
      inverse: (xy: [number, number]) => [number, number];
    }
  | {
      project: (lnglat: number[]) => number[];
      unproject: (xy: number[]) => number[];
    };

/** Options for `createProj4CRS`. Exactly one of `extent`/`extentGeographic` is required,
 * mirroring `CRSDefinition`'s own contract. */
export type CreateProj4CRSOptions = {
  /** Identifier, e.g. 'EPSG:32618'. Used for viewport equality checks and debugging. */
  code: string;
  /** A proj4 (or `@math.gl/proj4`) converter transforming WGS84 degrees to/from this CRS's
   * units. Not bundled by deck.gl - construct it with whichever projection library the app
   * already depends on, e.g. `proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m')`
   * or `new Proj4Projection({from: 'EPSG:4326', to: ...})`. */
  converter: Proj4LikeConverter;
  /** CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default 'meters'. */
  units?: 'meters' | 'degrees';
} & (
  | {
      /** [minX, minY, maxX, maxY] valid bounds in CRS units. Defines the common-space world
       * scale. Prefer this over `extentGeographic` when the projected extent is known exactly. */
      extent: [number, number, number, number];
      extentGeographic?: undefined;
    }
  | {
      extent?: undefined;
      /** [west, south, east, north] valid bounds in WGS84 degrees - a convenience for CRSs
       * (e.g. a single UTM zone) where a geographic bbox is at hand but the projected extent
       * is not. See `CRSDefinition#extentGeographic` for how this is turned into an extent. */
      extentGeographic: [number, number, number, number];
    }
);

/** Builds a `CRSDefinition` from a proj4-style converter, so apps don't have to hand-write
 * the `{forward, inverse}` adapter around it. Takes the converter as an argument rather than
 * depending on a projection library directly - this module (and `@deck.gl/core`) stays free
 * of a runtime dependency on proj4; bring whichever converter your app already constructed
 * (proj4's own `Converter`, or `@math.gl/proj4`'s `Proj4Projection`) and this normalizes
 * either naming convention (`forward`/`inverse` or `project`/`unproject`) to the
 * `CRSTransform` shape `CRSDefinition`/`CRSViewport` expect. */
export function createProj4CRS(options: CreateProj4CRSOptions): CRSDefinition {
  const {code, converter, extent, extentGeographic, units} = options;
  const transform: CRSTransform =
    'forward' in converter && 'inverse' in converter
      ? {forward: converter.forward, inverse: converter.inverse}
      : {
          forward: (lnglat: [number, number]) => converter.project(lnglat) as [number, number],
          inverse: (xy: [number, number]) => converter.unproject(xy) as [number, number]
        };

  return {
    code,
    transform,
    ...(extent !== undefined ? {extent} : {}),
    ...(extentGeographic !== undefined ? {extentGeographic} : {}),
    ...(units !== undefined ? {units} : {})
  };
}

/** DistanceScales in the shape viewport-uniforms.ts expects from getDistanceScales(origin) */
export function getCRSDistanceScales(crs: NormalizedCRS, lnglat: number[]) {
  const jacobian = getCRSJacobian(crs, lnglat);
  const unitsPerMeter = getUnitsPerMeter(jacobian);
  const unitsPerDegreeX = Math.hypot(jacobian[0], jacobian[1]);
  const unitsPerDegreeY = Math.hypot(jacobian[2], jacobian[3]);
  return {
    unitsPerMeter: [unitsPerMeter, unitsPerMeter, unitsPerMeter],
    metersPerUnit: [1 / unitsPerMeter, 1 / unitsPerMeter, 1 / unitsPerMeter],
    unitsPerMeter2: [0, 0, 0],
    unitsPerDegree: [unitsPerDegreeX, unitsPerDegreeY, unitsPerMeter],
    degreesPerUnit: [1 / unitsPerDegreeX, 1 / unitsPerDegreeY, 1 / unitsPerMeter],
    unitsPerDegree2: [0, 0, 0]
  };
}
