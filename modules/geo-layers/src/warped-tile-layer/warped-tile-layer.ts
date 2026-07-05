// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {COORDINATE_SYSTEM, DefaultProps, Layer, LayersList} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import type {TileLayerProps} from '../tile-layer/tile-layer';
import TileLayer from '../tile-layer/tile-layer';
import type {Tile2DHeader} from '../tileset-2d/index';
import {MercatorCRSTileset2D} from './mercator-crs-tileset-2d';
import {buildWarpedTileMesh} from './warp-mesh';
import type {WarpTargetCRS, WarpedTileMesh} from './warp-mesh';

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
  _meshResolution: 16,
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
  /** Warp grid cells per tile edge. Higher is more accurate for strongly curved CRSs.
   * The default is sub-pixel for UTM-class CRSs at any usable zoom. @default 16 */
  _meshResolution?: number;
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
      _meshResolution?: number;
      renderSubLayers?: (
        props: WarpedTileLayerRenderSubLayersProps<DataT>
      ) => Layer | null | LayersList;
    }>
> {
  static layerName = 'WarpedTileLayer';
  static defaultProps = defaultProps;

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
    const resolution = this.props._meshResolution;
    const mesh = this._getWarpedMesh(tile, crs, resolution);
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

  private _getWarpedMesh(
    tile: Tile2DHeader<DataT>,
    crs: WarpTargetCRS,
    resolution: number
  ): WarpedTileMesh {
    const key = `${crs.code}/${resolution}`;
    tile.userData = tile.userData || {};
    const cached = tile.userData.warpedMesh as {key: string; mesh: WarpedTileMesh} | undefined;
    if (cached && cached.key === key) {
      return cached.mesh;
    }
    const mesh = buildWarpedTileMesh(
      (tile as any).boundsWorld as [number, number, number, number],
      crs,
      resolution
    );
    tile.userData.warpedMesh = {key, mesh};
    return mesh;
  }
}
