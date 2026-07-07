// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

// deck.gl, MIT license
// Attributions:
// Copyright 2022 Foursquare Labs, Inc.

/* eslint-disable camelcase */ // Some WMS parameters are not in camel case
/* global setTimeout, clearTimeout */

import {
  Layer,
  CompositeLayer,
  CompositeLayerProps,
  UpdateParameters,
  DefaultProps,
  Viewport,
  CoordinateSystem,
  COORDINATE_SYSTEM,
  log,
  _deepEqual as deepEqual
} from '@deck.gl/core';
import {BitmapLayer} from '@deck.gl/layers';
import type {GetImageParameters, ImageSourceMetadata, ImageType} from '@loaders.gl/loader-utils';
import {createDataSource} from '@loaders.gl/core';
import {ImageSource, WMSSource} from '@loaders.gl/wms';
import {WGS84ToPseudoMercator, getCRSViewBoundsInCRSUnits, crsUnitsToCommonBounds} from './utils';
import type {WMSCRSViewportLike} from './utils';

/** All props supported by the TileLayer */
export type WMSLayerProps = CompositeLayerProps & _WMSLayerProps;

/** A viewport with CRS information (duck-typed to avoid a hard dependency on `_CRSViewport`,
 * matching the convention in `crs-tileset-2d.ts`/`mercator-crs-tileset-2d.ts`). */
type CRSViewportLike = Viewport & WMSCRSViewportLike;

/** Props added by the TileLayer */
type _WMSLayerProps = {
  data: string | ImageSource;
  serviceType?: 'wms' | 'auto';
  layers?: string[];
  /**
   * The CRS/SRS to request from the WMS server, and the coordinate system its
   * `GetMap` bbox is expressed in.
   *
   * Must be a CRS the WMS service advertises in its `GetCapabilities` (this is not
   * validated). In a CRS view (`MapView({crs})`), this should also match the view's
   * `crs.code` — the layer positions the returned image as an exact rectangle in the
   * view's CRS, so a mismatch means the server projects the image into a *different*
   * CRS than the one the view renders, which this layer cannot position exactly. When a
   * mismatch is detected, the layer falls back to a request bbox in lnglat degrees (as it
   * always did for Mercator/4326 views). That fallback bbox is only correctly expressed
   * for a mismatched `srs` of `'EPSG:4326'` or `'EPSG:3857'` — for either, a warning is
   * logged once and the image is positioned via its (approximate) LNGLAT bounds. Any
   * OTHER mismatched `srs` gets a distinct "unsupported combination" warning instead: the
   * fallback bbox is still lnglat degrees, but tagged with that unrelated `srs`, which
   * most WMS servers will reject or misinterpret (see wms-layer.md for the full
   * breakdown).
   *
   * `'auto'` (default) resolves to `'EPSG:4326'`/`'EPSG:3857'` outside a CRS view (as
   * before), and to the view's `crs.code` inside one.
   *
   * @default 'auto'
   */
  srs?: string;
  onMetadataLoad?: (metadata: ImageSourceMetadata) => void;
  onMetadataLoadError?: (error: Error) => void;
  onImageLoadStart?: (requestId: unknown) => void;
  onImageLoad?: (requestId: unknown) => void;
  onImageLoadError?: (requestId: unknown, error: Error) => void;
};

const defaultProps: DefaultProps<WMSLayerProps> = {
  id: 'imagery-layer',
  data: '',
  serviceType: 'auto',
  srs: 'auto',
  layers: {type: 'array', compare: true, value: []},
  onMetadataLoad: {type: 'function', value: () => {}},
  // eslint-disable-next-line
  onMetadataLoadError: {type: 'function', value: console.error},
  onImageLoadStart: {type: 'function', value: () => {}},
  onImageLoad: {type: 'function', value: () => {}},
  onImageLoadError: {
    type: 'function',
    compare: false,
    // eslint-disable-next-line
    value: (requestId: unknown, error: Error) => console.error(error, requestId)
  }
};

/**
 * The layer is used in Hex Tile layer in order to properly discard invisible elements during animation
 */
export class WMSLayer<ExtraPropsT extends {} = {}> extends CompositeLayer<
  ExtraPropsT & Required<_WMSLayerProps>
> {
  static layerName = 'WMSLayer';
  static defaultProps: DefaultProps = defaultProps;

  state!: {
    imageSource: ImageSource;
    image: ImageType;
    bounds: [number, number, number, number];
    /** Set when `bounds` is an exact CRS-unit rectangle in common space (a CRS view whose
     * `srs` matches `viewport.crs.code`); passed through as the sublayer's own
     * `coordinateSystem` so its geometry bypasses the LNGLAT projection pipeline. Left
     * `undefined` for the pre-existing Mercator/4326 behavior (bounds in LNGLAT). */
    boundsCoordinateSystem?: CoordinateSystem;
    lastRequestParameters: GetImageParameters;
    lastRequestId: number;
    _nextRequestId: number;
    /** TODO: Change any => setTimeout return type. Different between Node and browser... */
    _timeoutId: any;
    loadCounter: number;
    /** Last `srs`/view-crs mismatch combo warned about, so panning/zooming a CRS view
     * with a deliberately-mismatched `srs` doesn't spam a warning on every frame. */
    _lastSrsMismatchWarned?: string;
  };

  /** Returns true if all async resources are loaded */
  get isLoaded(): boolean {
    // Track the explicit loading done by this layer
    return this.state?.loadCounter === 0 && super.isLoaded;
  }

  /** Lets deck.gl know that we want viewport change events */
  override shouldUpdateState(): boolean {
    return true;
  }

  override initializeState(): void {
    // intentionally empty, initialization is done in updateState
    this.state._nextRequestId = 0;
    this.state.lastRequestId = -1;
    this.state.loadCounter = 0;
  }

  override updateState({changeFlags, props, oldProps}: UpdateParameters<this>): void {
    const {viewport} = this.context;

    // Check if data source has changed
    if (changeFlags.dataChanged || props.serviceType !== oldProps.serviceType) {
      this.state.imageSource = this._createImageSource(props);
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      this._loadMetadata();
      this.debounce(() => this.loadImage(viewport, 'image source changed'), 0);
    } else if (!deepEqual(props.layers, oldProps.layers, 1)) {
      this.debounce(() => this.loadImage(viewport, 'layers changed'), 0);
    } else if (changeFlags.viewportChanged) {
      this.debounce(() => this.loadImage(viewport, 'viewport changed'));
    }
  }

  override finalizeState(): void {
    // TODO - we could cancel outstanding requests
  }

  override renderLayers(): Layer {
    // TODO - which bitmap layer is rendered should depend on the current viewport
    // Currently Studio only uses one viewport
    const {bounds, image, lastRequestParameters, boundsCoordinateSystem} = this.state;

    return (
      image &&
      new BitmapLayer({
        ...this.getSubLayerProps({id: 'bitmap'}),
        // Preserved exactly as before for the Mercator/4326 path (`bounds` in LNGLAT).
        // `boundsCoordinateSystem !== undefined` marks the CRS exact-bounds path
        // (`useExactCRSBounds` in `_getRequestBounds`): there, `bounds` is already an exact
        // CRS-unit rectangle in COMMON SPACE (see `crsUnitsToCommonBounds`), not lnglat
        // degrees -- this holds even when the view CRS's own code happens to be the string
        // 'EPSG:4326' (a geographic CRS view), where `lastRequestParameters.crs` also reads
        // 'EPSG:4326' but does NOT mean "lnglat-degrees bounds". Gating on
        // `boundsCoordinateSystem` (the same condition that produced CARTESIAN bounds)
        // rather than re-deriving from `lastRequestParameters.crs` keeps the two conditions
        // from being able to disagree. Bug found by review: the crs-code check alone took the
        // LNGLAT branch in exactly this case, which made BitmapLayer's lnglat-in-cartesian
        // branch run `mercator_to_lnglat()` on common-space coordinates -- scrambled UVs.
        _imageCoordinateSystem:
          boundsCoordinateSystem === undefined && lastRequestParameters.crs === 'EPSG:4326'
            ? COORDINATE_SYSTEM.LNGLAT
            : COORDINATE_SYSTEM.CARTESIAN,
        // Only set in the CRS path; otherwise inherit the default (LNGLAT for a
        // geospatial viewport), matching pre-existing behavior exactly.
        ...(boundsCoordinateSystem !== undefined ? {coordinateSystem: boundsCoordinateSystem} : {}),
        bounds,
        image
      })
    );
  }

  async getFeatureInfoText(x: number, y: number): Promise<string | null> {
    const {lastRequestParameters} = this.state;
    if (lastRequestParameters) {
      // @ts-expect-error Undocumented method
      const featureInfo = await this.state.imageSource.getFeatureInfoText?.({
        ...lastRequestParameters,
        query_layers: lastRequestParameters.layers,
        x,
        y,
        info_format: 'application/vnd.ogc.gml'
      });
      return featureInfo;
    }
    return '';
  }

  _createImageSource(props: WMSLayerProps): ImageSource {
    if (props.data instanceof ImageSource) {
      return props.data;
    }

    if (typeof props.data === 'string') {
      return createDataSource(props.data, [WMSSource], {
        core: {
          type: props.serviceType,
          loadOptions: props.loadOptions
        }
      }) as ImageSource;
    }

    throw new Error('invalid image source in props.data');
  }

  /** Run a getMetadata on the image service */
  async _loadMetadata(): Promise<void> {
    const {imageSource} = this.state;
    try {
      this.state.loadCounter++;
      const metadata = await imageSource.getMetadata();

      // If a request takes a long time, it may no longer be expected
      if (this.state.imageSource === imageSource) {
        this.getCurrentLayer()?.props.onMetadataLoad(metadata);
      }
    } catch (error) {
      this.getCurrentLayer()?.props.onMetadataLoadError(error as Error);
    } finally {
      this.state.loadCounter--;
    }
  }

  /** Load an image */
  async loadImage(viewport: Viewport, reason: string): Promise<void> {
    const {layers, serviceType} = this.props;

    // TODO - move to ImageSource?
    if (serviceType === 'wms' && layers.length === 0) {
      return;
    }

    const {width, height} = viewport;
    const requestId = this.getRequestId();
    const crsViewport = viewport as CRSViewportLike;
    const isCRSView = Boolean(crsViewport.crs);

    const srs = this._resolveSrs(viewport, crsViewport, isCRSView);
    const {bounds, boundingBox, boundsCoordinateSystem} = this._getRequestBounds(
      viewport,
      crsViewport,
      isCRSView && srs === crsViewport.crs?.code,
      srs
    );

    const requestParams: GetImageParameters = {
      width,
      height,
      boundingBox,
      layers,
      crs: srs
    };

    try {
      this.state.loadCounter++;
      this.props.onImageLoadStart(requestId);

      const image = await this.state.imageSource.getImage(requestParams);

      // If a request takes a long time, later requests may have already loaded.
      if (this.state.lastRequestId < requestId) {
        this.getCurrentLayer()?.props.onImageLoad(requestId);
        // Not type safe...
        this.setState({
          image,
          bounds,
          boundsCoordinateSystem,
          lastRequestParameters: requestParams,
          lastRequestId: requestId
        });
      }
    } catch (error) {
      this.raiseError(error as Error, 'Load image');
      this.getCurrentLayer()?.props.onImageLoadError(requestId, error as Error);
    } finally {
      this.state.loadCounter--;
    }
  }

  // HELPERS

  /** Resolves `props.srs` against the current viewport: `'auto'` picks a sensible default
   * (the view CRS inside a CRS view, EPSG:3857/4326 otherwise); an explicit `srs` that
   * doesn't match a CRS view's `crs.code` is passed through unchanged, with a one-time
   * warning (see `useExactCRSBounds` in `_getRequestBounds`). */
  private _resolveSrs(
    viewport: Viewport,
    crsViewport: CRSViewportLike,
    isCRSView: boolean
  ): string {
    const {srs} = this.props;
    if (!isCRSView) {
      // BitmapLayer only supports LNGLAT or CARTESIAN (Web-Mercator)
      return srs === 'auto' ? (viewport.resolution ? 'EPSG:4326' : 'EPSG:3857') : srs;
    }
    if (srs === 'auto') {
      return crsViewport.crs.code;
    }
    if (srs !== crsViewport.crs.code) {
      const mismatchKey = `${srs}|${crsViewport.crs.code}`;
      if (this.state._lastSrsMismatchWarned !== mismatchKey) {
        this.state._lastSrsMismatchWarned = mismatchKey;
        // `_getRequestBounds`'s non-exact fallback only builds a request bbox that actually
        // matches the declared `crs`/`srs` for two cases: EPSG:4326 (raw lnglat degrees, which
        // ARE EPSG:4326) and EPSG:3857 (converted via WGS84ToPseudoMercator). For any OTHER
        // mismatched srs, the fallback still sends lnglat-degree bounds but tags them with that
        // arbitrary srs code -- the WMS server would interpret those degree values as being in
        // its (likely projected/meters) units, an unsupported/nonsensical combination, not
        // merely an "approximate" positioning -- so it gets a distinct, more pointed warning
        // rather than the (accurate only for 4326/3857) approximate-LNGLAT-bounds message.
        if (srs === 'EPSG:4326' || srs === 'EPSG:3857') {
          log.warn(
            `WMSLayer: srs "${srs}" does not match the view CRS "${crsViewport.crs.code}". ` +
              'The WMS server will project the requested image into a different CRS than ' +
              'the view renders, so it cannot be positioned as an exact rectangle; falling ' +
              'back to its (approximate) LNGLAT bounds.'
          )();
        } else {
          log.warn(
            `WMSLayer: srs "${srs}" is unsupported here -- it matches neither the view CRS ` +
              `"${crsViewport.crs.code}" (which would request exact CRS-unit bounds) nor ` +
              'EPSG:4326/EPSG:3857 (the only srs codes the fallback bbox can correctly express). ' +
              'The request bbox will be sent as lnglat degrees mislabeled with this srs, which ' +
              'most WMS servers will reject or misinterpret.'
          )();
        }
      }
    }
    return srs;
  }

  /**
   * WMS is the best-case CRS citizen: `GetMap` accepts an arbitrary CRS and a bbox in that
   * CRS's units, with the server doing the reprojection — so when `useExactCRSBounds` (a
   * CRS view whose resolved `srs` matches the view CRS), request the bbox in CRS units and
   * position the resulting image as an exact CRS-unit rectangle in common space, the same
   * way Phase 2/3 position tile/mesh content (see `boundsCommon` in `crs-tileset-2d.ts`).
   * Otherwise, preserves the pre-existing LNGLAT/pseudo-Mercator bounds behavior exactly.
   */
  private _getRequestBounds(
    viewport: Viewport,
    crsViewport: CRSViewportLike,
    useExactCRSBounds: boolean,
    srs: string
  ): {
    bounds: [number, number, number, number];
    boundingBox: GetImageParameters['boundingBox'];
    boundsCoordinateSystem: CoordinateSystem | undefined;
  } {
    if (useExactCRSBounds) {
      const boundsCRS = getCRSViewBoundsInCRSUnits(crsViewport);
      return {
        bounds: crsUnitsToCommonBounds(boundsCRS, crsViewport.crs),
        boundingBox: [
          [boundsCRS[0], boundsCRS[1]],
          [boundsCRS[2], boundsCRS[3]]
        ],
        boundsCoordinateSystem: COORDINATE_SYSTEM.CARTESIAN
      };
    }

    const lngLatBounds = viewport.getBounds();
    let boundingBox: GetImageParameters['boundingBox'] = [
      [lngLatBounds[0], lngLatBounds[1]],
      [lngLatBounds[2], lngLatBounds[3]]
    ];
    if (srs === 'EPSG:3857') {
      const min = WGS84ToPseudoMercator([lngLatBounds[0], lngLatBounds[1]]);
      const max = WGS84ToPseudoMercator([lngLatBounds[2], lngLatBounds[3]]);
      boundingBox = [min, max];
    }
    return {bounds: lngLatBounds, boundingBox, boundsCoordinateSystem: undefined};
  }

  /** Global counter for issuing unique request ids */
  private getRequestId(): number {
    return this.state._nextRequestId++;
  }

  /** Runs an action in the future, cancels it if the new action is issued before it executes */
  private debounce(fn: Function, ms = 500): void {
    clearTimeout(this.state._timeoutId);
    this.state._timeoutId = setTimeout(() => fn(), ms);
  }
}
