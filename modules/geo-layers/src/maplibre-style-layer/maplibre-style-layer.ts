// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, Layer, LayersList, log} from '@deck.gl/core';
import {binaryToGeojson} from '@loaders.gl/gis';
import type {Feature} from 'geojson';

import MVTLayer from '../mvt-layer/mvt-layer';
import {
  mapBackgroundLayer,
  mapFillLayer,
  mapLineLayer,
  mapFillExtrusionLayer
} from './style-layer-mappers';
import type {StyleLayer} from './style-layer-mappers';
import {mapSymbolIconLayer, mapSymbolTextLayer} from './symbol-mappers';
import type {MapLibreStyleLayerProps} from './types';

const SUPPORTED_TYPES = new Set(['fill', 'line', 'fill-extrusion', 'symbol']);
const warnedUnsupportedIds = new Set<string>();
const warnedLinePlacementIds = new Set<string>();

function warnUnsupportedOnce(styleLayer: StyleLayer): void {
  if (warnedUnsupportedIds.has(styleLayer.id)) return;
  warnedUnsupportedIds.add(styleLayer.id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${styleLayer.id}" has unsupported type "${styleLayer.type}" ` +
      '(raster/hillshade/heatmap are not implemented in v1) — skipped.'
  )();
}

function warnLinePlacementOnce(id: string): void {
  if (warnedLinePlacementIds.has(id)) return;
  warnedLinePlacementIds.add(id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${id}" uses symbol-placement:'line' — approximated as a ` +
      'single horizontal label at the line midpoint (no curved along-line placement in v1).'
  )();
}

/** In a classic Mercator `MapView` (`usesFeatureRoute` false, `mvt-layer.ts`), `MVTLayer`'s own
 * `renderSubLayers` sets `modelMatrix`/`coordinateOrigin`/`coordinateSystem`/`extensions`
 * (the power-of-two tile transform + `ClipExtension`) onto the props object handed to
 * `this.props.renderSubLayers` (i.e. this module's tile-render callback) *before* calling it —
 * see `mvt-layer.ts`'s `renderSubLayers`, `super.renderSubLayers(props)` region. Style-layer
 * mapper functions (Tasks 10/11) build fresh layers with their own (lnglat) coordinate
 * defaults and know nothing about that transform, so it must be re-applied here to every mapped
 * sublayer for the Mercator case — otherwise Mercator-mode content renders at the wrong
 * position/scale (only the CRS/Globe feature-route case, where content already arrives as
 * plain lnglat, needs no adjustment). Deviation from the plan's Task 12 sketch, which did not
 * carry these tile-positioning props through to the mapped layers; caught before commit by
 * reasoning through `MVTLayer.renderSubLayers`'s actual prop-mutation behavior, and pinned by
 * this file's `maplibre-style-layer.spec.ts` Mercator-positioning test. */
export function applyTilePositioning(
  layer: Layer,
  tileProps: {
    modelMatrix?: unknown;
    coordinateOrigin?: unknown;
    coordinateSystem?: unknown;
    extensions?: unknown[];
  }
): Layer {
  if (tileProps.modelMatrix === undefined) {
    return layer;
  }
  return layer.clone({
    modelMatrix: tileProps.modelMatrix,
    coordinateOrigin: tileProps.coordinateOrigin,
    coordinateSystem: tileProps.coordinateSystem,
    extensions: [...((layer.props.extensions as unknown[]) ?? []), ...(tileProps.extensions ?? [])]
  } as never) as Layer;
}

function mapOneStyleLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleLayerProps['evaluator'],
  zoom: number,
  spriteAtlas: MapLibreStyleLayerProps['spriteAtlas']
): Layer | null {
  switch (styleLayer.type) {
    case 'fill':
      return mapFillLayer(styleLayer, features, evaluator, zoom);
    case 'line':
      return mapLineLayer(styleLayer, features, evaluator, zoom);
    case 'fill-extrusion':
      return mapFillExtrusionLayer(styleLayer, features, evaluator, zoom);
    case 'symbol':
      if (
        (styleLayer as {layout?: {'icon-image'?: unknown}}).layout?.['icon-image'] &&
        spriteAtlas
      ) {
        return mapSymbolIconLayer(styleLayer, features, evaluator, zoom, spriteAtlas);
      }
      return mapSymbolTextLayer(styleLayer, features, evaluator, zoom, warnLinePlacementOnce);
    default:
      return null;
  }
}

function toFeatureArray(tileData: unknown): Feature[] {
  if (Array.isArray(tileData)) return tileData as Feature[];
  // Binary-shape tile content (classic Mercator route, `binary: true`): reuse the loader's own
  // conversion so style-layer mappers always see a plain Feature[] regardless of MVTLayer's
  // internal coordinate/shape mode.
  if (tileData) {
    return (binaryToGeojson(tileData as never) as {features: Feature[]}).features ?? [];
  }
  return [];
}

/** Experimental: converts a MapLibre GL style JSON plus a vector tile source into styled
 * deck.gl layers — one deck.gl layer per style layer, per tile, in style order. Works in both
 * classic Mercator `MapView`s and CRS `MapView`s (Stage 1); `source.tileMatrixSet` follows the
 * same convention as `MVTLayer`/`TileLayer` (optional — unset is the common, Mercator-pyramid
 * case, auto-routed through `_MercatorCRSTileset2D` in a CRS view, not a fallback). See
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md, Stage 2. */
export class MapLibreStyleLayer extends CompositeLayer<MapLibreStyleLayerProps> {
  static layerName = 'MapLibreStyleLayer';

  renderLayers(): LayersList {
    const {style, source, evaluator, spriteAtlas} = this.props;
    const zoom = this.context.viewport.zoom;
    const layers: LayersList = [];

    const allStyleLayers = style.layers as StyleLayer[];
    const backgroundStyleLayer = allStyleLayers.find(l => l.type === 'background');
    if (backgroundStyleLayer) {
      const backgroundLayer = mapBackgroundLayer(backgroundStyleLayer, evaluator, zoom);
      if (backgroundLayer) layers.push(backgroundLayer);
    }

    const featureStyleLayers = allStyleLayers.filter(l => l.type !== 'background');

    layers.push(
      new MVTLayer(this.getSubLayerProps({id: 'source'}), {
        data: source.data,
        tileMatrixSet: source.tileMatrixSet,
        // Style-layer mappers (Tasks 10/11) consume plain GeoJSON Feature[] (`f.properties`,
        // `f.geometry`) and fan each tile out into a *list* of mapped layers, one per matching
        // style layer — not the single-GeoJsonLayer-per-tile shape MVTLayer's `binary: true`
        // fast path expects (its own renderSubLayers logs a warning otherwise: "must return
        // GeoJsonLayer when using binary:true"). Force `binary: false` so tile content always
        // arrives pre-parsed as Feature[] (`toFeatureArray`'s binary-fallback branch below is
        // then purely defensive, not the common path) and the warning does not fire on every
        // render in classic Mercator MapViews. Deviation: the plan's Task 12 sketch did not set
        // this and would warn continuously in the Mercator regression case (Task 13).
        binary: false,
        renderSubLayers: (tileProps: {data: unknown; tile: unknown; [key: string]: unknown}) => {
          const features = toFeatureArray(tileProps.data);
          const sublayers: LayersList = [];
          for (const styleLayer of featureStyleLayers) {
            if (!SUPPORTED_TYPES.has(styleLayer.type)) {
              warnUnsupportedOnce(styleLayer);
              continue;
            }
            const mapped = mapOneStyleLayer(styleLayer, features, evaluator, zoom, spriteAtlas);
            if (mapped) {
              sublayers.push(applyTilePositioning(mapped, tileProps));
            }
          }
          return sublayers;
        }
      })
    );

    return layers;
  }
}

export default MapLibreStyleLayer;
