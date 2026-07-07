// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Column-major 2x2 Jacobian of a CRS's lnglat->common transform:
 * [dX/dLng, dY/dLng, dX/dLat, dY/dLat] in common units per degree.
 * Matches `CRSViewport#getCRSJacobianAtOrigin`'s return shape (crs-utils.ts). */
export type CRSJacobian4 = [number, number, number, number];

/** Second-order (quadratic) coefficients of a CRS's lnglat->common transform, per
 * output component: `[d2/dLng2, d2/dLng*dLat, d2/dLat2]` in common units per degree^2.
 * Matches `CRSViewport#getCRSHessianAtOrigin`'s return shape (crs-utils.ts). */
export type CRSHessian3 = {x: [number, number, number]; y: [number, number, number]};

/**
 * Builds a cheap local affine + quadratic approximation of a CRS's lnglat->common
 * transform around a fixed `origin`, for use as `PolygonTesselator`'s `preproject` in
 * CRS views (see `SolidPolygonLayer#initializeState`).
 *
 * This is *the same* approximation `project.glsl.ts`'s
 * `PROJECTION_MODE_CRS`/`COORDINATE_SYSTEM_LNGLAT` branch uses to render vertex
 * positions on the GPU: `commonXY = J * (xy - origin) + 0.5 * H(xy - origin)` (see
 * `crs-utils.ts#getCRSJacobian`/`getCRSHessian` and that shader block for the reference
 * math this mirrors).
 *
 * Why this is correct for triangulation: `getSurfaceIndices` only needs a projection
 * that preserves each polygon's local winding/monotonicity so earcut produces
 * non-degenerate, non-self-intersecting triangles - not metric exactness against the
 * true (proj-wasm) transform. And the actual rendered shape is already only ever this
 * same affine+quadratic approximation - the vertex shader never calls proj-wasm per
 * vertex - so tesselating with it too makes triangulation topology *more* consistent
 * with what gets rendered than the previous exact-transform tesselation was.
 *
 * Cost: zero proj-wasm calls per vertex. The Jacobian/Hessian at `origin` are computed
 * once by the caller (typically already memoized by (crs, origin) in crs-utils.ts and
 * shared with the current frame's shader uniforms), replacing what was previously one
 * `crs.transform.forward` (proj-wasm) call per polygon vertex.
 *
 * Caveat: like the shader's own approximation, error grows (quadratically, then
 * beyond) with distance from `origin`. This is negligible for tile-clipped
 * basemap/vector polygons (bounded to a small extent near the view they were requested
 * for - the profiled hot path) but a polygon whose vertices span very far (thousands of
 * km, e.g. a hand-authored continental outline) from `origin` could see more curvature
 * error in its *triangulation* than the previous exact-per-vertex-transform gave it
 * (independent of *rendering*, which was already only ever approximated the same way).
 */
/** Duck-typed shape of a `_CRSViewport` sufficient to build the affine+quadratic
 * tesselation preproject function below, without a hard dependency on `_CRSViewport`
 * (matching the convention used elsewhere for CRS-viewport-shaped duck types, e.g.
 * `modules/geo-layers/src/wms-layer/utils.ts`'s `WMSCRSViewportLike`). Mirrors exactly
 * what `getUniformsFromViewport` (viewport-uniforms.ts) duck-types to compute the same
 * shader uniforms. */
export type CRSViewportLike = {
  longitude: number;
  latitude: number;
  getCRSJacobianAtOrigin: (origin: number[]) => CRSJacobian4;
  getCRSHessianAtOrigin: (origin: number[]) => CRSHessian3;
};

/**
 * Chooses the polygon-tesselation `preproject` function for a given viewport/coordinate
 * system, matching `SolidPolygonLayer#initializeState`'s prior behavior for every case
 * except plain (non-`full3d`) LNGLAT polygons in a CRS view:
 *  - `coordinateSystem !== 'lnglat'`: no preprojection (`undefined`), unchanged.
 *  - `full3d`: `viewport.projectPosition`, unchanged (exact, all projection modes).
 *  - CRS view, not full3d: the cheap affine+quadratic approximation (see
 *    {@link createCRSAffinePreproject}) instead of `viewport.projectFlat` (which would
 *    call proj-wasm once per vertex).
 *  - Every other case (Web Mercator, Globe, Identity/Orthographic): `viewport.projectFlat`,
 *    byte-identical to before - those viewports' `projectFlat` is already a cheap
 *    closed-form function, not proj-wasm, so there is nothing to optimize and no
 *    behavior change here.
 */
export function getPolygonTesselatorPreproject(
  viewport: {
    projectionMode: number;
    projectFlat: (xyz: number[]) => number[];
    projectPosition: (xyz: number[]) => number[];
  },
  coordinateSystem: string,
  full3d: boolean,
  /** `PROJECTION_MODE.CRS`, passed in to avoid importing `@deck.gl/core` from this leaf
   * module's test target; `SolidPolygonLayer` passes the real constant. */
  crsProjectionMode: number
): ((xy: number[]) => number[]) | undefined {
  if (coordinateSystem !== 'lnglat') {
    return undefined;
  }
  if (full3d) {
    return viewport.projectPosition.bind(viewport);
  }
  if (viewport.projectionMode === crsProjectionMode) {
    const crsViewport = viewport as unknown as CRSViewportLike;
    const origin: [number, number] = [crsViewport.longitude, crsViewport.latitude];
    return createCRSAffinePreproject(
      crsViewport.getCRSJacobianAtOrigin(origin),
      crsViewport.getCRSHessianAtOrigin(origin),
      origin
    );
  }
  return viewport.projectFlat.bind(viewport);
}

export function createCRSAffinePreproject(
  jacobian: CRSJacobian4,
  hessian: CRSHessian3,
  origin: readonly [number, number]
): (xy: number[]) => number[] {
  const [a, b, c, d] = jacobian;
  const [hx0, hx1, hx2] = hessian.x;
  const [hy0, hy1, hy2] = hessian.y;
  const [originLng, originLat] = origin;

  return (xy: number[]): number[] => {
    const dLng = xy[0] - originLng;
    const dLat = xy[1] - originLat;

    const qLngLng = 0.5 * dLng * dLng;
    const qLngLat = dLng * dLat;
    const qLatLat = 0.5 * dLat * dLat;

    const x = a * dLng + c * dLat + (hx0 * qLngLng + hx1 * qLngLat + hx2 * qLatLat);
    const y = b * dLng + d * dLat + (hy0 * qLngLng + hy1 * qLngLat + hy2 * qLatLat);

    return xy.length > 2 ? [x, y, xy[2]] : [x, y];
  };
}
