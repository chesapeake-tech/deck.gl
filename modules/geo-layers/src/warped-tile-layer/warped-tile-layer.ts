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

const defaultProps: DefaultProps<WarpedTileLayerProps> = {
  TilesetClass: MercatorCRSTileset2D,
  tileSize: 256,
  maxZoom: 19,
  _meshResolution: 16
};

/** Props added by WarpedTileLayer. `minZoom`/`maxZoom` are SOURCE (OSM) levels. */
export type WarpedTileLayerProps<DataT = unknown> = TileLayerProps<DataT> & {
  /** Warp grid cells per tile edge. Higher is more accurate for strongly curved CRSs.
   * The default is sub-pixel for UTM-class CRSs at any usable zoom. @default 16 */
  _meshResolution?: number;
};

/** Renders a Web-Mercator raster XYZ pyramid (OSM, Esri World Imagery, ...) inside a
 * non-Mercator CRS MapView by warping each tile's image over an exactly reprojected
 * vertex grid (client-side, no reprojecting server). Experimental. */
export default class WarpedTileLayer<DataT = any, ExtraPropsT extends {} = {}> extends TileLayer<
  DataT,
  ExtraPropsT & Required<{_meshResolution?: number}>
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
    return new SimpleMeshLayer(props as any, {
      id: `${props.id}-warped`,
      data: [0],
      mesh: {attributes: mesh.attributes, indices: mesh.indices},
      texture: props.data as any,
      textureParameters: {addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'},
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      // Instanced positioning: the fp64-split instance position carries the tile's
      // common-space origin; fp32 mesh positions stay origin-relative and tiny.
      // (Deliberately not TerrainLayer's `_instanced: false`, which would store
      // absolute fp32 positions and lose precision at high zoom.)
      getPosition: () => mesh.origin,
      getColor: [255, 255, 255],
      pickable: false
    });
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
