// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Layer} from '@deck.gl/core';
import {IconLayer, TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileFilter} from './compile-filter';
import {compileExpression, zoomBucket} from './compile-expression';
import {spriteToIconMapping} from './sprite-mapping';
import {lineMidpoint} from './line-midpoint';
import type {MapLibreStyleEvaluator, MapLibreSpriteAtlas} from './types';
import type {StyleLayer} from './style-layer-mappers';

function filterFeatures(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number
): Feature[] {
  const filter = compileFilter(styleLayer.filter, evaluator);
  return features.filter(f => filter(zoom, f as {properties: Record<string, unknown>}));
}

/** Reduces every feature to a single labeling point: `Point` geometries pass through
 * unchanged; `LineString` geometries with `symbol-placement: 'line'` use `lineMidpoint`'s
 * fallback (Decisions for review #4), warning once per style-layer id. */
function toLabelPoints(
  styleLayer: StyleLayer,
  features: Feature[],
  warnOnce: (id: string) => void
): Feature[] {
  const placement = styleLayer.layout?.['symbol-placement'];
  return features.map(f => {
    if (f.geometry.type === 'Point') return f;
    if (f.geometry.type === 'LineString' && placement === 'line') {
      warnOnce(styleLayer.id);
      const point = lineMidpoint(f.geometry.coordinates as [number, number][]);
      return {...f, geometry: {type: 'Point', coordinates: point}} as Feature;
    }
    return f;
  });
}

export function mapSymbolIconLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  spriteAtlas: MapLibreSpriteAtlas
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0 || !styleLayer.layout?.['icon-image']) return null;

  const iconImage = compileExpression<string>(
    styleLayer.layout['icon-image'],
    {type: 'string'},
    evaluator
  );
  const iconSize = compileExpression<number>(
    styleLayer.layout?.['icon-size'] ?? 1,
    {type: 'number'},
    evaluator
  );

  return new IconLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    iconAtlas: spriteAtlas.image,
    iconMapping: spriteToIconMapping(spriteAtlas.mapping),
    getPosition: (f: unknown) =>
      (f as {geometry: {coordinates: [number, number]}}).geometry.coordinates,
    getIcon: (f: unknown) => iconImage.evaluate(zoom, f as never),
    getSize: (f: unknown) => iconSize.evaluate(zoom, f as never),
    updateTriggers: {
      getIcon: iconImage.isZoomDependent ? zoomBucket(zoom) : undefined,
      getSize: iconSize.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}

export function mapSymbolTextLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  warnOnce: (id: string) => void
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom);
  if (matched.length === 0 || !styleLayer.layout?.['text-field']) return null;

  const labelPoints = toLabelPoints(styleLayer, matched, warnOnce);
  const textField = compileExpression<string>(
    styleLayer.layout['text-field'],
    {type: 'string'},
    evaluator
  );
  const priorityValue = styleLayer.layout?.['symbol-sort-key'];
  const priority = priorityValue
    ? compileExpression<number>(priorityValue, {type: 'number'}, evaluator)
    : null;

  return new TextLayer({
    id: `maplibre-${styleLayer.id}`,
    data: labelPoints,
    getPosition: (f: unknown) =>
      (f as {geometry: {coordinates: [number, number]}}).geometry.coordinates,
    getText: (f: unknown) => textField.evaluate(zoom, f as never),
    // Browser-font approximation of `text-font` (Decisions for review — accepted v1 cut, no
    // glyph-PBF fetch/parity with the style's `glyphs` URL).
    fontFamily: 'sans-serif',
    collisionEnabled: true,
    // Deviation (caught via app verification, Task 13, not by unit tests): `extensions` always
    // includes `CollisionFilterExtension`, so `getCollisionPriority` must always resolve to a
    // real accessor. Explicitly setting the prop to `undefined` (rather than omitting the key)
    // overrides the extension's own `getCollisionPriority` default (0) with `undefined` — deck.gl
    // prop merging is a plain object spread, so an explicit `undefined` value wins over a
    // default — which threw "accessor getCollisionPriority is not a function" the first time
    // this ran in a real browser (a style layer with no `symbol-sort-key`, the common case). Omit
    // the key entirely instead when there is no compiled priority expression.
    ...(priority
      ? {getCollisionPriority: (f: unknown) => priority.evaluate(zoom, f as never)}
      : {}),
    extensions: [new CollisionFilterExtension()],
    updateTriggers: {
      getText: textField.isZoomDependent ? zoomBucket(zoom) : undefined,
      getCollisionPriority: priority?.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}
