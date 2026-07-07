// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Layer, project32, picking, gouraudMaterial, PROJECTION_MODE} from '@deck.gl/core';
import {Model, Geometry} from '@luma.gl/engine';

// Polygon geometry generation is managed by the polygon tesselator
import PolygonTesselator from './polygon-tesselator';
import {getPolygonTesselatorPreproject} from './crs-affine-preproject';

import {solidPolygonUniforms, SolidPolygonProps} from './solid-polygon-layer-uniforms';
import vsTop from './solid-polygon-layer-vertex-top.glsl';
import vsSide from './solid-polygon-layer-vertex-side.glsl';
import fs from './solid-polygon-layer-fragment.glsl';

import type {
  LayerProps,
  LayerDataSource,
  Color,
  Material,
  Accessor,
  AccessorFunction,
  UpdateParameters,
  GetPickingInfoParams,
  PickingInfo,
  DefaultProps
} from '@deck.gl/core';
import type {PolygonGeometry} from './polygon';

type _SolidPolygonLayerProps<DataT> = {
  data: LayerDataSource<DataT>;
  /** Whether to fill the polygons
   * @default true
   */
  filled?: boolean;
  /** Whether to extrude the polygons
   * @default false
   */
  extruded?: boolean;
  /** Whether to generate a line wireframe of the polygon.
   * @default false
   */
  wireframe?: boolean;
  /**
   * (Experimental) If `false`, will skip normalizing the coordinates returned by `getPolygon`.
   * @default true
   */
  _normalize?: boolean;
  /**
   * (Experimental) This prop is only effective with `_normalize: false`.
   * It specifies the winding order of rings in the polygon data, one of 'CW' (clockwise) and 'CCW' (counter-clockwise)
   */
  _windingOrder?: 'CW' | 'CCW';

  /**
   * (Experimental) This prop is only effective with `XYZ` data.
   * When true, polygon tesselation will be performed on the plane with the largest area, instead of the xy plane.
   * @default false
   */
  _full3d?: boolean;

  /** Elevation multiplier.
   * @default 1
   */
  elevationScale?: number;

  /** Polygon geometry accessor. */
  getPolygon?: AccessorFunction<DataT, PolygonGeometry>;
  /** Extrusion height accessor.
   * @default 1000
   */
  getElevation?: Accessor<DataT, number>;
  /** Fill color accessor.
   * @default [0, 0, 0, 255]
   */
  getFillColor?: Accessor<DataT, Color>;
  /** Stroke color accessor.
   * @default [0, 0, 0, 255]
   */
  getLineColor?: Accessor<DataT, Color>;

  /**
   * Material settings for lighting effect. Applies if `extruded: true`
   *
   * @default true
   * @see https://deck.gl/docs/developer-guide/using-lighting
   */
  material?: Material;
};

/** Render filled and/or extruded polygons. */
export type SolidPolygonLayerProps<DataT = unknown> = _SolidPolygonLayerProps<DataT> & LayerProps;

const DEFAULT_COLOR = [0, 0, 0, 255] as const;

const defaultProps: DefaultProps<SolidPolygonLayerProps> = {
  filled: true,
  extruded: false,
  wireframe: false,
  _normalize: true,
  _windingOrder: 'CW',
  _full3d: false,

  elevationScale: {type: 'number', min: 0, value: 1},

  getPolygon: {type: 'accessor', value: (f: any) => f.polygon},
  getElevation: {type: 'accessor', value: 1000},
  getFillColor: {type: 'accessor', value: DEFAULT_COLOR},
  getLineColor: {type: 'accessor', value: DEFAULT_COLOR},

  material: true
};

const ATTRIBUTE_TRANSITION = {
  enter: (value, chunk) => {
    return chunk.length ? chunk.subarray(chunk.length - value.length) : value;
  }
};

export default class SolidPolygonLayer<DataT = any, ExtraPropsT extends {} = {}> extends Layer<
  ExtraPropsT & Required<_SolidPolygonLayerProps<DataT>>
> {
  static defaultProps = defaultProps;
  static layerName = 'SolidPolygonLayer';

  state!: {
    topModel?: Model;
    sideModel?: Model;
    wireframeModel?: Model;
    models?: Model[];
    numInstances: number;
    polygonTesselator: PolygonTesselator;
  };

  getShaders(type) {
    return super.getShaders({
      vs: type === 'top' ? vsTop : vsSide,
      fs,
      defines: {
        RING_WINDING_ORDER_CW: !this.props._normalize && this.props._windingOrder === 'CCW' ? 0 : 1
      },
      modules: [project32, gouraudMaterial, picking, solidPolygonUniforms]
    });
  }

  get wrapLongitude(): boolean {
    return false;
  }

  getBounds(): [number[], number[]] | null {
    return this.getAttributeManager()?.getBounds(['vertexPositions']);
  }

  initializeState() {
    const {viewport} = this.context;
    let {coordinateSystem} = this.props;
    const {_full3d} = this.props;
    if (viewport.isGeospatial && coordinateSystem === 'default') {
      coordinateSystem = 'lnglat';
    }

    // In a CRS view, `viewport.projectFlat` calls `crs.transform.forward` (proj-wasm) -
    // calling it once per polygon vertex during triangulation is the dominant CRS-view
    // CPU cost for fill/polygon basemap layers. Triangulation
    // only needs a projection that preserves each polygon's local winding/monotonicity,
    // not metric exactness, and the vertex shader only ever renders CRS LNGLAT
    // positions via the same local affine+quadratic (Jacobian/Hessian) approximation
    // anyway (project.glsl.ts) - so `getPolygonTesselatorPreproject` uses that
    // approximation here too (evaluated once at the view center) instead of calling
    // proj-wasm per vertex, for every other case (Web Mercator, Globe, full3d) it
    // returns exactly what this used to inline here. See crs-affine-preproject.ts for
    // the full correctness rationale and its caveat for very large (near-continental)
    // polygons.
    const preproject = getPolygonTesselatorPreproject(
      viewport,
      coordinateSystem,
      Boolean(_full3d),
      PROJECTION_MODE.CRS
    );

    this.setState({
      numInstances: 0,
      polygonTesselator: new PolygonTesselator({
        // Lnglat coordinates are usually projected non-linearly, which affects tesselation results
        // Provide a preproject function if the coordinates are in lnglat
        preproject,
        fp64: this.use64bitPositions(),
        IndexType: Uint32Array
      })
    });

    const attributeManager = this.getAttributeManager()!;
    const noAlloc = true;

    /* eslint-disable max-len */
    attributeManager.add({
      indices: {
        size: 1,
        isIndexed: true,
        // eslint-disable-next-line @typescript-eslint/unbound-method
        update: this.calculateIndices,
        noAlloc
      },
      vertexPositions: {
        size: 3,
        type: 'float64',
        stepMode: 'dynamic',
        fp64: this.use64bitPositions(),
        transition: ATTRIBUTE_TRANSITION,
        accessor: 'getPolygon',
        // eslint-disable-next-line @typescript-eslint/unbound-method
        update: this.calculatePositions,
        noAlloc,
        shaderAttributes: {
          nextVertexPositions: {
            vertexOffset: 1
          }
        }
      },
      instanceVertexValid: {
        size: 1,
        type: 'uint16',
        stepMode: 'instance',
        // eslint-disable-next-line @typescript-eslint/unbound-method
        update: this.calculateVertexValid,
        noAlloc
      },
      elevations: {
        size: 1,
        stepMode: 'dynamic',
        transition: ATTRIBUTE_TRANSITION,
        accessor: 'getElevation'
      },
      fillColors: {
        size: this.props.colorFormat.length,
        type: 'unorm8',
        stepMode: 'dynamic',
        transition: ATTRIBUTE_TRANSITION,
        accessor: 'getFillColor',
        defaultValue: DEFAULT_COLOR
      },
      lineColors: {
        size: this.props.colorFormat.length,
        type: 'unorm8',
        stepMode: 'dynamic',
        transition: ATTRIBUTE_TRANSITION,
        accessor: 'getLineColor',
        defaultValue: DEFAULT_COLOR
      },
      /** Source polygon row, including __source.index for composite data. */
      rowIndexes: {
        size: 1,
        type: 'uint32',
        stepMode: 'dynamic',
        accessor: (object, {index}) => (object && object.__source ? object.__source.index : index)
      }
    });
    /* eslint-enable max-len */
  }

  getPickingInfo(params: GetPickingInfoParams): PickingInfo {
    const info = super.getPickingInfo(params);
    const {index} = info;
    const data = this.props.data as any[];

    // Check if data comes from a composite layer, wrapped with getSubLayerRow
    if (data[0] && data[0].__source) {
      // index decoded from picking color refers to the source index
      info.object = data.find(d => d.__source.index === index);
    }
    return info;
  }

  disablePickingIndex(objectIndex: number) {
    const data = this.props.data as any[];

    // Check if data comes from a composite layer, wrapped with getSubLayerRow
    if (data[0] && data[0].__source) {
      // index decoded from picking color refers to the source index
      for (let i = 0; i < data.length; i++) {
        if (data[i].__source.index === objectIndex) {
          this._disablePickingIndex(i);
        }
      }
    } else {
      super.disablePickingIndex(objectIndex);
    }
  }

  draw({uniforms}) {
    const {extruded, filled, wireframe, elevationScale} = this.props;
    const {topModel, sideModel, wireframeModel, polygonTesselator} = this.state;

    const renderUniforms: SolidPolygonProps = {
      extruded: Boolean(extruded),
      elevationScale,
      isWireframe: false
    };

    // Note - the order is important
    if (wireframeModel && wireframe) {
      wireframeModel.setInstanceCount(polygonTesselator.instanceCount - 1);
      wireframeModel.shaderInputs.setProps({solidPolygon: {...renderUniforms, isWireframe: true}});
      wireframeModel.draw(this.context.renderPass);
    }

    if (sideModel && filled) {
      sideModel.setInstanceCount(polygonTesselator.instanceCount - 1);
      sideModel.shaderInputs.setProps({solidPolygon: renderUniforms});
      sideModel.draw(this.context.renderPass);
    }

    if (topModel && filled) {
      topModel.setVertexCount(polygonTesselator.vertexCount);
      topModel.shaderInputs.setProps({solidPolygon: renderUniforms});
      topModel.draw(this.context.renderPass);
    }
  }

  updateState(updateParams: UpdateParameters<this>) {
    super.updateState(updateParams);

    this.updateGeometry(updateParams);

    const {props, oldProps, changeFlags} = updateParams;
    const attributeManager = this.getAttributeManager();

    const regenerateModels =
      changeFlags.extensionsChanged ||
      props.filled !== oldProps.filled ||
      props.extruded !== oldProps.extruded;

    if (regenerateModels) {
      this.state.models?.forEach(model => model.destroy());

      this.setState(this._getModels());
      attributeManager!.invalidateAll();
    }
  }

  protected updateGeometry({props, oldProps, changeFlags}: UpdateParameters<this>) {
    const geometryConfigChanged =
      changeFlags.dataChanged ||
      (changeFlags.updateTriggersChanged &&
        (changeFlags.updateTriggersChanged.all || changeFlags.updateTriggersChanged.getPolygon));

    // When the geometry config  or the data is changed,
    // tessellator needs to be invoked
    if (geometryConfigChanged) {
      const {polygonTesselator} = this.state;
      const buffers = (props.data as any).attributes || {};
      const {viewport} = this.context;

      // `initializeState` builds the CRS affine tesselation
      // `preproject` ONCE, closing over whatever the view center was at mount time (see
      // `crs-affine-preproject.ts#getPolygonTesselatorPreproject`'s `origin` argument). A
      // re-tesselation triggered here (this `geometryConfigChanged` branch) can happen long
      // after the camera has panned away from that original center — reusing the stale origin
      // would tesselate against an affine approximation that's no longer a good local fit for
      // where the polygon's vertices actually are. Resolving `preproject` fresh from the
      // CURRENT viewport at every re-tesselation (rather than only once in `initializeState`)
      // keeps the origin current; `Tesselator#updateGeometry` merges this into `this.opts` via
      // `Object.assign`, so the new function replaces the old one on `polygonTesselator.opts`.
      // Mercator/Globe/full3d/non-lnglat paths are unaffected: `getPolygonTesselatorPreproject`
      // already returns byte-identical closures for those cases on every call (a cheap
      // `.bind()`, not a proj-wasm evaluation), and `PROJECTION_MODE.CRS`-view CRS Jacobian/
      // Hessian lookups are themselves memoized per (crs, origin) (crs-utils.ts), so this adds
      // no proj-wasm calls on the common (camera-didn't-move-relative-to-crs) path.
      let {coordinateSystem} = props;
      if (viewport.isGeospatial && coordinateSystem === 'default') {
        coordinateSystem = 'lnglat';
      }
      const preproject = getPolygonTesselatorPreproject(
        viewport,
        coordinateSystem,
        Boolean(props._full3d),
        PROJECTION_MODE.CRS
      );

      polygonTesselator.updateGeometry({
        data: props.data,
        normalize: props._normalize,
        geometryBuffer: buffers.getPolygon,
        buffers,
        getGeometry: props.getPolygon,
        positionFormat: props.positionFormat,
        wrapLongitude: props.wrapLongitude,
        // TODO - move the flag out of the viewport
        resolution: viewport.resolution,
        fp64: this.use64bitPositions(),
        dataChanged: changeFlags.dataChanged,
        full3d: props._full3d,
        preproject
      });

      this.setState({
        numInstances: polygonTesselator.instanceCount,
        startIndices: polygonTesselator.vertexStarts
      });

      if (!changeFlags.dataChanged) {
        // Base `layer.updateState` only invalidates all attributes on data change
        // Cover the rest of the scenarios here
        this.getAttributeManager()!.invalidateAll();
      }
    }
  }

  protected _getModels() {
    const {id, filled, extruded} = this.props;

    let topModel;
    let sideModel;
    let wireframeModel;

    if (filled) {
      const shaders = this.getShaders('top');
      shaders.defines.NON_INSTANCED_MODEL = 1;
      const bufferLayout = this.getAttributeManager()!.getBufferLayouts({isInstanced: false});

      topModel = new Model(this.context.device, {
        ...shaders,
        id: `${id}-top`,
        topology: 'triangle-list',
        bufferLayout,
        isIndexed: true,
        userData: {
          excludeAttributes: {instanceVertexValid: true}
        }
      });
    }
    if (extruded) {
      const bufferLayout = this.getAttributeManager()!.getBufferLayouts({isInstanced: true});

      sideModel = new Model(this.context.device, {
        ...this.getShaders('side'),
        id: `${id}-side`,
        bufferLayout,
        geometry: new Geometry({
          topology: 'triangle-strip',
          attributes: {
            // top right - top left - bottom right - bottom left
            positions: {
              size: 2,
              value: new Float32Array([1, 0, 0, 0, 1, 1, 0, 1])
            }
          }
        }),
        isInstanced: true,
        userData: {
          excludeAttributes: {indices: true}
        }
      });

      wireframeModel = new Model(this.context.device, {
        ...this.getShaders('side'),
        id: `${id}-wireframe`,
        bufferLayout,
        geometry: new Geometry({
          topology: 'line-strip',
          attributes: {
            // top right - top left - bottom left - bottom right
            positions: {
              size: 2,
              value: new Float32Array([1, 0, 0, 0, 0, 1, 1, 1])
            }
          }
        }),
        isInstanced: true,
        userData: {
          excludeAttributes: {indices: true}
        }
      });
    }

    return {
      models: [sideModel, wireframeModel, topModel].filter(Boolean),
      topModel,
      sideModel,
      wireframeModel
    };
  }

  protected calculateIndices(attribute) {
    const {polygonTesselator} = this.state;
    attribute.startIndices = polygonTesselator.indexStarts;
    attribute.value = polygonTesselator.get('indices');
  }

  protected calculatePositions(attribute) {
    const {polygonTesselator} = this.state;
    attribute.startIndices = polygonTesselator.vertexStarts;
    attribute.value = polygonTesselator.get('positions');
  }

  protected calculateVertexValid(attribute) {
    attribute.value = this.state.polygonTesselator.get('vertexValid');
  }
}
