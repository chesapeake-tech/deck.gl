// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Layer} from '@deck.gl/core';
import {GeoJsonLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileFilter} from './compile-filter';
import {compileExpression, zoomBucket} from './compile-expression';
import type {MapLibreStyleEvaluator} from './types';

export type StyleLayer = {
  id: string;
  type: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
  layout?: Record<string, unknown>;
};

function filterFeatures(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Feature[] {
  const filter = compileFilter(styleLayer.filter, evaluator);
  return features.filter(f => filter(zoom, f as {properties: Record<string, unknown>}));
}

/** Minimal color-agnostic passthrough: `createPropertyExpression({type: 'color'})` already
 * returns a parsed `{r,g,b,a}` (0-1 range) object per the style-spec's own color type (verified
 * against the real `@maplibre/maplibre-gl-style-spec` package) — converts to deck.gl's
 * `[r,g,b,a]` (0-255) `Color` tuple, folding in a separate opacity multiplier where the style
 * separates `-color` and `-opacity` paint properties. */
function toRGBA(color: unknown, opacity: number): [number, number, number, number] {
  const c = color as {r: number; g: number; b: number; a: number};
  return [
    Math.round(c.r * 255),
    Math.round(c.g * 255),
    Math.round(c.b * 255),
    Math.round(c.a * opacity * 255)
  ];
}

function zoomDependentBucket(
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
  coveringFeature?: Feature
): Layer | null {
  const paint = styleLayer.paint ?? {};
  const color = compileExpression<string>(
    paint['background-color'] ?? '#000000',
    {type: 'color'},
    evaluator
  );
  const opacity = compileExpression<number>(
    paint['background-opacity'] ?? 1,
    {type: 'number'},
    evaluator
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
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(
    paint['fill-color'] ?? '#000000',
    {type: 'color'},
    evaluator
  );
  const opacity = compileExpression<number>(
    paint['fill-opacity'] ?? 1,
    {type: 'number'},
    evaluator
  );
  const outlineColor = paint['fill-outline-color']
    ? compileExpression<string>(paint['fill-outline-color'], {type: 'color'}, evaluator)
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    filled: true,
    stroked: Boolean(outlineColor),
    getFillColor: (f: unknown) =>
      toRGBA(fillColor.evaluate(zoom, f as never), opacity.evaluate(zoom, f as never)),
    getLineColor: outlineColor
      ? (f: unknown) => toRGBA(outlineColor.evaluate(zoom, f as never), 1)
      : undefined,
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
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const lineColor = compileExpression<string>(
    paint['line-color'] ?? '#000000',
    {type: 'color'},
    evaluator
  );
  const lineWidth = compileExpression<number>(
    paint['line-width'] ?? 1,
    {type: 'number'},
    evaluator
  );
  const dashArray = paint['line-dasharray']
    ? compileExpression<[number, number]>(
        paint['line-dasharray'],
        {type: 'array', value: 'number', length: 2},
        evaluator
      )
    : null;

  return new GeoJsonLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    stroked: true,
    filled: false,
    getLineColor: (f: unknown) => toRGBA(lineColor.evaluate(zoom, f as never), 1),
    getLineWidth: (f: unknown) => lineWidth.evaluate(zoom, f as never),
    extensions: dashArray ? [new PathStyleExtension({dash: true})] : [],
    getDashArray: dashArray ? (f: unknown) => dashArray.evaluate(zoom, f as never) : undefined,
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
  zoom: number
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0) return null;

  const paint = styleLayer.paint ?? {};
  const fillColor = compileExpression<string>(
    paint['fill-extrusion-color'] ?? '#cccccc',
    {type: 'color'},
    evaluator
  );
  const height = compileExpression<number>(
    paint['fill-extrusion-height'] ?? 0,
    {type: 'number'},
    evaluator
  );
  const base = paint['fill-extrusion-base']
    ? compileExpression<number>(paint['fill-extrusion-base'], {type: 'number'}, evaluator)
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
