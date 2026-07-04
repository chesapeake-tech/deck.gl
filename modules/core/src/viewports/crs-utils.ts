// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Width of the common-space world at zoom 0. Matches Web Mercator's world size. */
export const CRS_WORLD_SIZE = 512;

/** Meters per degree of latitude (Earth circumference / 360). Matches @math.gl/web-mercator. */
const METERS_PER_DEGREE = 4.003e7 / 360;

/** Finite-difference step for Jacobian estimation, in degrees (~1 meter) */
const JACOBIAN_STEP = 1e-5;

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
  /** [minX, minY, maxX, maxY] valid bounds in CRS units. Defines the common-space world scale. */
  extent: [number, number, number, number];
  /** CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default 'meters'. */
  units?: 'meters' | 'degrees';
};

/** CRSDefinition with `units` defaulted (no longer optional) and its derived world scale. */
export type NormalizedCRS = CRSDefinition & {
  units: 'meters' | 'degrees';
  /** Common units per CRS unit: CRS_WORLD_SIZE / extent width */
  commonUnitsPerCRSUnit: number;
};

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

  const {code, transform, extent, units = 'meters'} = definition;
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
  const dLng = partialDerivative(crs, lnglat, 0);
  const dLat = partialDerivative(crs, lnglat, 1);
  return [dLng[0], dLng[1], dLat[0], dLat[1]];
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
