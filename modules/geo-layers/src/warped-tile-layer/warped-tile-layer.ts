// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {COORDINATE_SYSTEM, DefaultProps, Layer, LayersList} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import type {TileLayerProps} from '../tile-layer/tile-layer';
import TileLayer from '../tile-layer/tile-layer';
import type {Tile2DHeader} from '../tileset-2d/index';
import type {TileMatrixSet} from '../tileset-2d/tile-matrix-set';
import {MercatorCRSTileset2D} from './mercator-crs-tileset-2d';
import {buildWarpedTileMesh, estimateWarpMeshResolution, resolveWarpSource} from './warp-mesh';
import type {WarpTargetCRS, WarpedTileMesh, WarpSourceCrs, ResolvedWarpSource} from './warp-mesh';

/** Props `renderSubLayers` receives: the usual `TileLayer` sublayer props (including `tile`,
 * whose `bbox`/`boundsWorld` metadata describe the tile's footprint) plus the mesh this layer
 * builds for that tile — reprojected exactly on the CPU — and its common-space `origin`.
 *
 * `TileLayerProps`'s own `renderSubLayers` field is omitted here (rather than inherited via a
 * plain intersection) because it's typed to receive the *base* `TileLayer` sublayer props. Left
 * in place, that field would conflict with `WarpedTileLayerProps.renderSubLayers` below — which
 * must accept this narrower, mesh/origin-carrying props type — since function properties are
 * checked contravariantly on their parameter types. Compare `_MVTLayerProps`/`MVTLayerProps` in
 * `mvt-layer.ts`, which uses the same `Omit<TileLayerProps<...>, '...'> & {...}` split to
 * override a base `TileLayer` prop's type without hitting that conflict. */
export type WarpedTileLayerRenderSubLayersProps<DataT = unknown> = Omit<
  TileLayerProps<DataT>,
  'renderSubLayers'
> & {
  id: string;
  data: DataT;
  _offset: number;
  tile: Tile2DHeader<DataT>;
  /** The tile's warped mesh (memoized per tile/CRS/`_meshResolution`) */
  mesh: {attributes: WarpedTileMesh['attributes']; indices: WarpedTileMesh['indices']};
  /** Mesh vertex positions are relative to this common-space point (float64); feed it to
   * `getPosition` — see the default `renderSubLayers` for the intended usage. */
  origin: [number, number, number];
};

const defaultProps: DefaultProps<WarpedTileLayerProps> = {
  TilesetClass: MercatorCRSTileset2D,
  tileSize: 256,
  maxZoom: 19,
  _meshResolution: 'auto',
  sourceTileMatrixSet: {type: 'object', optional: true, value: null, compare: 2},
  sourceCrs: {type: 'object', optional: true, value: null, compare: 1},
  renderSubLayers: {
    type: 'function',
    value: (props: WarpedTileLayerRenderSubLayersProps) => {
      const {mesh, origin} = props;
      return new SimpleMeshLayer(props as any, {
        id: `${props.id}-warped`,
        data: [0],
        mesh,
        texture: props.data as any,
        textureParameters: {addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'},
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        // Instanced positioning: the fp64-split instance position carries the tile's
        // common-space origin; fp32 mesh positions stay origin-relative and tiny.
        // (Deliberately not TerrainLayer's `_instanced: false`, which would store
        // absolute fp32 positions and lose precision at high zoom.)
        getPosition: () => origin,
        getColor: [255, 255, 255],
        pickable: false
      });
    }
  }
};

/** Props added by WarpedTileLayer. `minZoom`/`maxZoom` are SOURCE (OSM) levels. */
export type WarpedTileLayerProps<DataT = unknown> = Omit<
  TileLayerProps<DataT>,
  'renderSubLayers'
> & {
  /** Warp grid cells per tile edge. A fixed number forces that resolution; `'auto'` (the
   * default) picks one per tile from its measured distortion, holding a ≤0.15 px interpolation
   * bound (from {4, 8, 16, 32}). Set a number only to override the adaptive choice. @default 'auto' */
  _meshResolution?: number | 'auto';
  /** OGC TileMatrixSet describing the SOURCE tile pyramid, in `sourceCrs` units. Unset, the
   * source is the built-in WebMercatorQuad pyramid (OSM/Esri XYZ) — zero behavior change.
   * Required when `sourceCrs` is set. @default WebMercatorQuad */
  sourceTileMatrixSet?: TileMatrixSet | null;
  /** CRS the source pyramid is described in: unset/`null` = Web Mercator (default); `'EPSG:4326'`
   * = a lat/long source whose tile coordinates ARE lnglat (e.g. GIBS WorldCRS84Quad); or a
   * `CRSDefinition` carrying the exact inverse for any other source. Only these are supported —
   * the layer does not build a general reprojection framework. @default Web Mercator */
  sourceCrs?: WarpSourceCrs;
  /**
   * Renders one or an array of Layer instances for a tile. Receives the tile's warped
   * mesh and common-space origin in addition to the usual `TileLayer` sublayer props
   * (`tile.bbox`/`tile.boundsWorld` describe the tile's lnglat/world footprint).
   * @default renders a textured `SimpleMeshLayer`
   */
  renderSubLayers?: (
    props: WarpedTileLayerRenderSubLayersProps<DataT>
  ) => Layer | null | LayersList;
};

/** Renders a Web-Mercator raster XYZ pyramid (OSM, Esri World Imagery, ...) inside a
 * non-Mercator CRS MapView by warping each tile's image over an exactly reprojected
 * vertex grid (client-side, no reprojecting server). Experimental. */
export default class WarpedTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends TileLayer<
  DataT,
  ExtraPropsT &
    Required<{
      _meshResolution?: number | 'auto';
      renderSubLayers?: (
        props: WarpedTileLayerRenderSubLayersProps<DataT>
      ) => Layer | null | LayersList;
    }>
> {
  static layerName = 'WarpedTileLayer';
  static defaultProps = defaultProps;

  private _warpSource: ResolvedWarpSource | null = null;
  private _warpSourceRefs: {tileSize: unknown; tms: unknown; crs: unknown} | null = null;

  /** Forward the source-pyramid props to the tileset (the base `_getTilesetOptions` only passes a
   * fixed prop set, so `sourceTileMatrixSet`/`sourceCrs` must be added here). */
  _getTilesetOptions() {
    return {
      ...super._getTilesetOptions(),
      sourceTileMatrixSet: this.props.sourceTileMatrixSet,
      sourceCrs: this.props.sourceCrs
    };
  }

  /** Resolve (and memoize on prop identity) the source pyramid used to warp each tile. Kept in
   * sync with the tileset by resolving from the same three props. */
  private _getWarpSource(): ResolvedWarpSource {
    const {tileSize, sourceTileMatrixSet, sourceCrs} = this.props;
    const refs = this._warpSourceRefs;
    if (
      !this._warpSource ||
      !refs ||
      refs.tileSize !== tileSize ||
      refs.tms !== sourceTileMatrixSet ||
      refs.crs !== sourceCrs
    ) {
      this._warpSource = resolveWarpSource({tileSize, sourceTileMatrixSet, sourceCrs});
      this._warpSourceRefs = {tileSize, tms: sourceTileMatrixSet, crs: sourceCrs};
    }
    return this._warpSource;
  }

  renderSubLayers(
    props: WarpedTileLayerProps<DataT> & {
      id: string;
      data: DataT;
      _offset: number;
      tile: Tile2DHeader<DataT>;
    }
  ): Layer | null | LayersList {
    const crs = (this.context.viewport as any).crs as WarpTargetCRS | undefined;
    if (!crs) {
      return null;
    }
    const {tile} = props;
    const mesh = this._getWarpedMesh(tile, crs);
    const propsWithMesh: WarpedTileLayerRenderSubLayersProps<DataT> = {
      ...props,
      mesh: {attributes: mesh.attributes, indices: mesh.indices},
      origin: mesh.origin
    };
    // Delegate to the (possibly user-supplied) `renderSubLayers` prop so a custom
    // implementation can replace the default `SimpleMeshLayer` rendering while still
    // receiving the memoized mesh built above.
    return this.props.renderSubLayers(propsWithMesh);
  }

  private _getWarpedMesh(tile: Tile2DHeader<DataT>, crs: WarpTargetCRS): WarpedTileMesh {
    // `boundsWorld` is the tile rect in the SOURCE pyramid's units; `sourceToLngLat` maps it to
    // lnglat before the view-CRS warp (identity/worldToLngLat/etc. per the resolved source).
    const boundsWorld = (tile as any).boundsWorld as [number, number, number, number];
    const {tileSize} = this.props;
    const source = this._getWarpSource();
    const {toLngLat} = source;
    // Resolve the grid size: an explicit `_meshResolution` number forces it; `'auto'` picks it
    // from this tile's distortion at the current view scale (pixels per common unit = 2^zoom).
    const requested = this.props._meshResolution;
    const resolution =
      typeof requested === 'number'
        ? requested
        : estimateWarpMeshResolution(boundsWorld, crs, this.context.viewport.scale, toLngLat);

    // Cache key covers every input the mesh geometry/UVs depend on: view CRS (flushes on a CRS
    // swap), the resolved grid size (data-dependent under 'auto' — two tiles or two zooms that
    // resolve to different N must not share a mesh), the source tileSize (UV inset width), and a
    // source marker (a non-Mercator source warps the same tile rect differently). The tile's own
    // geometry is fixed by its identity, so it needn't be in the key.
    const sourceMarker = source.isMercator ? 'm' : 'x';
    const key = `${crs.code}/${resolution}/${tileSize}/${sourceMarker}`;
    tile.userData = tile.userData || {};
    const cached = tile.userData.warpedMesh as {key: string; mesh: WarpedTileMesh} | undefined;
    if (cached && cached.key === key) {
      return cached.mesh;
    }
    const mesh = buildWarpedTileMesh(boundsWorld, crs, resolution, {
      tileSize,
      sourceToLngLat: toLngLat
    });
    tile.userData.warpedMesh = {key, mesh};
    return mesh;
  }
}
