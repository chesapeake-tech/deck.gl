// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Layer} from '@deck.gl/core';
import {GeoJsonLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileFilter} from './compile-filter';
import {compileExpression, zoomBucket} from './compile-expression';
import type {CompileCache} from './compile-expression';
import type {MapLibreStyleEvaluator} from './types';

export type StyleLayer = {
  id: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  minzoom?: number;
  maxzoom?: number;
  'source-layer'?: string;
};

/** Review fix (I5): `layout.visibility: 'none'` (a style-layer-level on/off switch, independent
 * of `filter`) — a real style commonly ships a layer with `visibility: 'none'` to mean "defined
 * but not currently shown" (e.g. toggled by a style-switcher UI outside the adapter's scope).
 * Unhandled, such a layer rendered exactly as if it were visible. */
export function isStyleLayerVisible(styleLayer: StyleLayer): boolean {
  return styleLayer.layout?.visibility !== 'none';
}

/** Review fix (I5): `minzoom`/`maxzoom` (style-layer-level, MapLibre semantics: rendered when
 * `minzoom <= zoom < maxzoom`) — a real style relies on these to swap layer styling by zoom
 * band (e.g. a coarse `fill` layer below z10, a detailed one above); unhandled, every style
 * layer rendered at every zoom regardless of its declared range. */
export function isStyleLayerInZoomRange(styleLayer: StyleLayer, zoom: number): boolean {
  const {minzoom, maxzoom} = styleLayer;
  if (minzoom !== undefined && zoom < minzoom) return false;
  if (maxzoom !== undefined && zoom >= maxzoom) return false;
  return true;
}

/** Review fix (I5): `source-layer` scopes a style layer to one named layer inside the vector
 * tile (matched against the MVT loader's own `feature.properties.layerName`,
 * `modules/geo-layers/src/mvt-layer/mvt-layer.ts`'s `getFeatureLayerName` — confirmed against
 * `@loaders.gl/mvt`'s `parse-mvt.js`, which injects the tile's named layer into
 * `properties.layerName` for exactly this purpose). Real vector styles scope almost every
 * layer by `source-layer` alone (with no other distinguishing filter) — unhandled, every style
 * layer matched every feature from every named layer in the tile, badly over-rendering (e.g. a
 * `water` fill style layer painting `building`/`road` polygons too). No `source-layer` set on
 * the style layer means "match every named layer" (a style-JSON author's choice, not a gap). */
function matchesSourceLayer(styleLayer: StyleLayer, feature: Feature): boolean {
  const sourceLayer = styleLayer['source-layer'];
  if (sourceLayer === undefined) return true;
  return (feature.properties as {layerName?: string} | null)?.layerName === sourceLayer;
}

export function filterFeatures(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  cache?: CompileCache
): Feature[] {
  if (!isStyleLayerVisible(styleLayer) || !isStyleLayerInZoomRange(styleLayer, zoom)) {
    return [];
  }
  const filter = compileFilter(styleLayer.filter, evaluator, cache);
  return features.filter(
    f =>
      matchesSourceLayer(styleLayer, f) && filter(zoom, f as {properties: Record<string, unknown>})
  );
}

/** Minimal color-agnostic passthrough: `createPropertyExpression({type: 'color'})` already
 * returns a parsed `{r,g,b,a}` object per the style-spec's own color type (verified against the
 * real `@maplibre/maplibre-gl-style-spec` package) — converts to deck.gl's `[r,g,b,a]` (0-255)
 * `Color` tuple, folding in a separate opacity multiplier where the style separates `-color` and
 * `-opacity` paint properties.
 *
 * Review fix (I1): the style-spec's `Color` is PREMULTIPLIED by alpha — `rgba(255,0,0,.5)`
 * parses to `{r:.5, g:0, b:0, a:.5}`, not `{r:1, g:0, b:0, a:.5}` (verified above against the
 * real package). Reading `r/g/b` directly (as the previous code did) darkens every
 * semi-transparent color proportionally to its alpha (a 50%-alpha red rendered at half the
 * correct red intensity). Un-premultiply by dividing `r/g/b` by `a` before scaling to 0-255;
 * `a === 0` (fully transparent) is left at `{r:0,g:0,b:0}` — the division is undefined
 * (0/0) and the color is invisible regardless of RGB. */
export function toRGBA(color: unknown, opacity: number): [number, number, number, number] {
  const c = color as {r: number; g: number; b: number; a: number};
  const unpremultiply = c.a > 0 ? 1 / c.a : 0;
  return [
    Math.round(c.r * unpremultiply * 255),
    Math.round(c.g * unpremultiply * 255),
    Math.round(c.b * unpremultiply * 255),
    Math.round(c.a * opacity * 255)
  ];
}

export function zoomDependentBucket(
  zoom: number,
  ...compiled: Array<{isZoomDependent: boolean} | null | undefined>
): number | undefined {
  return compiled.some(c => c?.isZoomDependent) ? zoomBucket(zoom) : undefined;
}

/** `background` style layers have no source data — one full-viewport-covering polygon. */
export function mapBackgroundLayer(
  styleLayer: StyleLayer,
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  coveringFeature?: Feature,
  cache?: CompileCache
): Layer | null {
  // Review fix (I5): `background` has no source features to run through `filterFeatures`, but
  // still needs the same `visibility`/`minzoom`/`maxzoom` honoring every other style-layer type
  // gets.
  if (!isStyleLayerVisible(styleLayer) || !isStyleLayerInZoomRange(styleLayer, zoom)) {
    return null;
  }
  const paint = styleLayer.paint ?? {};
  const color = compileExpression<string>(
    paint['background-color'] ?? '#000000',
    {type: 'color'},
    evaluator,
    cache
  );
  const opacity = compileExpression<number>(
    paint['background-opacity'] ?? 1,
    {type: 'number'},
    evaluator,
    cache
  );
  const feature: Feature =
    coveringFeature ??
    ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-180, -90],
            [180, -90],
            [180, 90],
            [-180, 90],
            [-180, -90]
          ]
        ]
      }
    } as Feature);
  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: [feature],
    filled: true,
    stroked: false,
    getFillColor: () =>
      toRGBA(color.evaluate(zoom, feature as never), opacity.evaluate(zoom, feature as never)),
    updateTriggers: {
      getFillColor: zoomDependentBucket(zoom, color, opacity)
    }
  });
}

export function mapFillLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  cache?: CompileCache
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom, cache);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(
    paint['fill-color'] ?? '#000000',
    {type: 'color'},
    evaluator,
    cache
  );
  const opacity = compileExpression<number>(
    paint['fill-opacity'] ?? 1,
    {type: 'number'},
    evaluator,
    cache
  );
  const outlineColor = paint['fill-outline-color']
    ? compileExpression<string>(paint['fill-outline-color'], {type: 'color'}, evaluator, cache)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    filled: true,
    stroked: Boolean(outlineColor),
    getFillColor: (f: unknown) =>
      toRGBA(fillColor.evaluate(zoom, f as never), opacity.evaluate(zoom, f as never)),
    // Omit the key (not `getLineColor: undefined`) when there is no outline color: an explicit
    // `undefined` prop value overrides GeoJsonLayer's own default accessor via deck.gl's
    // object-spread prop merging, whereas omitting the key preserves it (see the identical,
    // confirmed-in-browser bug fixed in symbol-mappers.ts's `getCollisionPriority`). Currently
    // inert either way since `stroked` is coupled to the same `outlineColor` truthiness, but
    // fixed for consistency/defense-in-depth.
    ...(outlineColor
      ? {getLineColor: (f: unknown) => toRGBA(outlineColor.evaluate(zoom, f as never), 1)}
      : {}),
    updateTriggers: {
      getFillColor: zoomDependentBucket(zoom, fillColor, opacity),
      getLineColor: outlineColor ? zoomDependentBucket(zoom, outlineColor) : undefined
    }
  });
}

export function mapLineLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  cache?: CompileCache
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom, cache);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const lineColor = compileExpression<string>(
    paint['line-color'] ?? '#000000',
    {type: 'color'},
    evaluator,
    cache
  );
  const lineWidth = compileExpression<number>(
    paint['line-width'] ?? 1,
    {type: 'number'},
    evaluator,
    cache
  );
  const dashArray = paint['line-dasharray']
    ? compileExpression<[number, number]>(
        paint['line-dasharray'],
        {type: 'array', value: 'number', length: 2},
        evaluator,
        cache
      )
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    stroked: true,
    filled: false,
    // Review fix (I3a): MapLibre's `line-width` is always CSS pixels; GeoJsonLayer/PathLayer
    // default `lineWidthUnits` to 'meters', which scales the stroke with zoom/latitude instead
    // of keeping it a constant screen-space width.
    lineWidthUnits: 'pixels',
    getLineColor: (f: unknown) => toRGBA(lineColor.evaluate(zoom, f as never), 1),
    getLineWidth: (f: unknown) => lineWidth.evaluate(zoom, f as never),
    extensions: dashArray ? [new PathStyleExtension({dash: true})] : [],
    // Omit the key rather than set `undefined` (see mapFillLayer's getLineColor / the
    // getCollisionPriority fix in symbol-mappers.ts) — inert here too since `PathStyleExtension`
    // is only added when `dashArray` is set, but kept consistent for the same reason.
    ...(dashArray ? {getDashArray: (f: unknown) => dashArray.evaluate(zoom, f as never)} : {}),
    updateTriggers: {
      getLineColor: zoomDependentBucket(zoom, lineColor),
      getLineWidth: zoomDependentBucket(zoom, lineWidth),
      getDashArray: dashArray ? zoomDependentBucket(zoom, dashArray) : undefined
    }
  });
}

export function mapFillExtrusionLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  cache?: CompileCache
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom, cache);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(
    paint['fill-extrusion-color'] ?? '#cccccc',
    {type: 'color'},
    evaluator,
    cache
  );
  const height = compileExpression<number>(
    paint['fill-extrusion-height'] ?? 0,
    {type: 'number'},
    evaluator,
    cache
  );
  const base = paint['fill-extrusion-base']
    ? compileExpression<number>(paint['fill-extrusion-base'], {type: 'number'}, evaluator, cache)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    filled: true,
    extruded: true,
    getFillColor: (f: unknown) => toRGBA(fillColor.evaluate(zoom, f as never), 1),
    getElevation: (f: unknown) =>
      height.evaluate(zoom, f as never) - (base ? base.evaluate(zoom, f as never) : 0),
    updateTriggers: {
      getFillColor: zoomDependentBucket(zoom, fillColor),
      getElevation: zoomDependentBucket(zoom, height, base)
    }
  });
}
