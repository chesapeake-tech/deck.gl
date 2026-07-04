// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import Viewport from './viewport';
import type {ViewportOptions, Padding, DistanceScales} from './viewport';
import {PROJECTION_MODE} from '../lib/constants';
import {
  pixelsToWorld,
  getViewMatrix,
  getProjectionParameters,
  altitudeToFovy,
  fovyToAltitude
} from '@math.gl/web-mercator';
import {vec2} from '@math.gl/core';
import {
  normalizeCRS,
  lngLatToCommon,
  commonToLngLat,
  getCRSJacobian,
  getCRSDistanceScales,
  clampLngLatToCRSExtent
} from './crs-utils';
import type {CRSDefinition, NormalizedCRS} from './crs-utils';

export type CRSViewportOptions = {
  /** Coordinate reference system to render in */
  crs: CRSDefinition | string;
  /** Name of the viewport */
  id?: string;
  /** Left offset from the canvas edge, in pixels */
  x?: number;
  /** Top offset from the canvas edge, in pixels */
  y?: number;
  /** Viewport width in pixels */
  width?: number;
  /** Viewport height in pixels */
  height?: number;
  /** Longitude of the view center, in degrees */
  longitude?: number;
  /** Latitude of the view center, in degrees */
  latitude?: number;
  /** Tilt of the camera in degrees */
  pitch?: number;
  /** Heading of the camera in degrees. `0` is CRS grid-north up */
  bearing?: number;
  /** Camera altitude relative to the viewport height, used to control the FOV. Default `1.5` */
  altitude?: number;
  /** Camera fovy in degrees. If provided, overrides `altitude` */
  fovy?: number;
  /** Viewport center offsets from lng, lat, in meters */
  position?: number[];
  /** Zoom level */
  zoom?: number;
  /** Padding around the viewport, in pixels */
  padding?: Padding | null;
  /** Whether to create an orthographic or perspective projection matrix. Default `false` */
  orthographic?: boolean;
  /** Scaler for the near plane, 1 unit equals to the height of the viewport. Default `0.1` */
  nearZMultiplier?: number;
  /** Scaler for the far plane, 1 unit equals to the distance from the camera to the edge of the screen. Default `1.01` */
  farZMultiplier?: number;
  /** Optionally override the near plane position */
  nearZ?: number;
  /** Optionally override the far plane position */
  farZ?: number;
};

/**
 * Renders a geospatial view in an arbitrary projected CRS.
 * Common space is the CRS plane, offset by the extent min and normalized so that
 * the extent width maps to the 512-unit world (Mercator-compatible zoom semantics).
 */
export default class CRSViewport extends Viewport {
  static displayName = 'CRSViewport';

  longitude: number;
  latitude: number;
  pitch: number;
  bearing: number;
  altitude: number;
  fovy: number;
  orthographic: boolean;
  crs!: NormalizedCRS;

  constructor(opts: CRSViewportOptions) {
    const {
      zoom = 0,
      pitch = 0,
      bearing = 0,
      nearZMultiplier = 0.1,
      farZMultiplier = 1.01,
      orthographic = false
    } = opts;

    let {width, height, altitude = 1.5} = opts;
    const scale = Math.pow(2, zoom);
    width = width || 1;
    height = height || 1;

    let fovy = opts.fovy;
    if (fovy) {
      altitude = fovyToAltitude(fovy);
    } else {
      fovy = altitudeToFovy(altitude);
    }

    const crs = normalizeCRS(opts.crs);
    // Keep the view center inside the CRS domain — an out-of-domain center can
    // produce non-finite transforms (e.g. panning a UTM zone past its extent)
    const [longitude, latitude] = clampLngLatToCRSExtent(crs, [
      opts.longitude ?? 0,
      opts.latitude ?? 0
    ]);
    const distanceScales = getCRSDistanceScales(crs, [longitude, latitude]) as DistanceScales;

    // Same camera math as WebMercatorViewport: these utilities operate in
    // common-space units and are not Mercator-specific.
    const viewMatrixUncentered = getViewMatrix({height, pitch, bearing, scale, altitude});

    const projectionParameters = getProjectionParameters({
      width,
      height,
      scale,
      pitch,
      fovy,
      nearZMultiplier,
      farZMultiplier
    });
    if (Number.isFinite(opts.nearZ)) {
      projectionParameters.near = opts.nearZ as number;
    }
    if (Number.isFinite(opts.farZ)) {
      projectionParameters.far = opts.farZ as number;
    }

    const viewportOpts: ViewportOptions = {
      ...opts,
      width,
      height,
      viewMatrix: viewMatrixUncentered,
      longitude,
      latitude,
      zoom,
      distanceScales,
      ...projectionParameters,
      fovy,
      focalDistance: altitude
    };

    super(viewportOpts);

    this.crs = crs;
    this.latitude = latitude;
    this.longitude = longitude;
    this.zoom = zoom;
    this.pitch = pitch;
    this.bearing = bearing;
    this.altitude = altitude;
    this.fovy = fovy;
    this.orthographic = orthographic;

    // The base constructor computed `center` (and the matrices derived from it)
    // before `this.crs` was assigned, using the projectFlat fallback below.
    // Re-run initialization with the real transform.
    this._initProps(viewportOpts);
    this._initMatrices(viewportOpts);

    Object.freeze(this);
  }

  get projectionMode(): number {
    return PROJECTION_MODE.CRS;
  }

  projectFlat(xyz: number[]): [number, number] {
    if (!this.crs) {
      // Called from the base constructor before `this.crs` is assigned; the
      // constructor re-runs _initProps/_initMatrices with the real transform.
      return [0, 0];
    }
    return lngLatToCommon(this.crs, xyz);
  }

  unprojectFlat(xyz: number[]): [number, number] {
    return commonToLngLat(this.crs, xyz);
  }

  getDistanceScales(coordinateOrigin?: number[]): DistanceScales {
    if (coordinateOrigin) {
      return getCRSDistanceScales(this.crs, coordinateOrigin) as DistanceScales;
    }
    return this.distanceScales;
  }

  /** Column-major 2x2 Jacobian of the lnglat->common transform at the given origin,
   * in common units per degree. Uploaded as a shader uniform for the local affine
   * approximation of this CRS. */
  getCRSJacobianAtOrigin(origin: number[]): [number, number, number, number] {
    return getCRSJacobian(this.crs, origin);
  }

  panByPosition(coords: number[], pixel: number[]): Partial<CRSViewportOptions> {
    const fromLocation = pixelsToWorld(pixel, this.pixelUnprojectionMatrix);
    const toLocation = this.projectFlat(coords);

    const translate = vec2.add([], toLocation, vec2.negate([], fromLocation));
    const newCenter = vec2.add([], this.center, translate);

    const [longitude, latitude] = this.unprojectFlat(newCenter);
    return {longitude, latitude};
  }

  /** Returns a new viewport that fits around the given lnglat bounds.
   * Only supports non-perspective mode. */
  fitBounds(
    /** [[west, south], [east, north]] in degrees */
    bounds: [[number, number], [number, number]],
    options: {padding?: number} = {}
  ): CRSViewport {
    const [[west, south], [east, north]] = bounds;
    const corner0 = lngLatToCommon(this.crs, [west, south]);
    const corner1 = lngLatToCommon(this.crs, [east, north]);
    const padding = options.padding || 0;

    const sizeX = Math.max(Math.abs(corner1[0] - corner0[0]), Number.EPSILON);
    const sizeY = Math.max(Math.abs(corner1[1] - corner0[1]), Number.EPSILON);
    // pixels per common unit = 2^zoom
    const scaleX = (this.width - padding * 2) / sizeX;
    const scaleY = (this.height - padding * 2) / sizeY;
    const zoom = Math.log2(Math.max(Math.min(scaleX, scaleY), Number.EPSILON));

    const [longitude, latitude] = commonToLngLat(this.crs, [
      (corner0[0] + corner1[0]) / 2,
      (corner0[1] + corner1[1]) / 2
    ]);

    return new CRSViewport({
      crs: this.crs,
      width: this.width,
      height: this.height,
      longitude,
      latitude,
      zoom
    });
  }

  equals(viewport: Viewport): boolean {
    if (!(viewport instanceof CRSViewport) || viewport.crs.code !== this.crs.code) {
      return false;
    }
    return super.equals(viewport);
  }
}
