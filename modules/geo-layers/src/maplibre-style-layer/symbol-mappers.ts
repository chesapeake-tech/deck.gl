// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Layer} from '@deck.gl/core';
import {IconLayer, TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import type {Feature} from 'geojson';

import {compileExpression, zoomBucket} from './compile-expression';
import type {CompileCache} from './compile-expression';
import {spriteToIconMapping} from './sprite-mapping';
import {lineMidpoint} from './line-midpoint';
import type {MapLibreStyleEvaluator, MapLibreSpriteAtlas} from './types';
import type {StyleLayer} from './style-layer-mappers';
// Fold-in simplification: `filterFeatures` (visibility/minzoom/
// maxzoom/source-layer/`filter`) is now shared with style-layer-mappers.ts instead of
// duplicated — this file previously had its own copy missing all four of those checks.
import {toRGBA, zoomDependentBucket, filterFeatures} from './style-layer-mappers';

/** Signed shoelace sum (×2) of a ring — used both for the ring's area (unsigned, to compare
 * MultiPolygon parts by size) and, divided through, its centroid. */
function ringShoelaceSum(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    sum += x0 * y1 - x1 * y0;
  }
  return sum;
}

/** Area-weighted centroid of a ring's vertices (the standard polygon-centroid
 * formula) — not a bounding-box or plain vertex-average center, which can be pulled off-shape by
 * dense vertex clusters. Only the exterior ring (`rings[0]`) is considered; holes are ignored
 * (documented v1 cut — a label centroid landing inside a small hole is a rare, low-severity
 * fidelity gap compared to the complexity of a hole-aware centroid). Degenerate rings (zero
 * signed area, e.g. collinear/duplicate points) fall back to a plain vertex average. */
function polygonCentroid(rings: [number, number][][]): [number, number] {
  const ring = rings?.[0];
  if (!ring || ring.length === 0) return [NaN, NaN];
  const twiceArea = ringShoelaceSum(ring);
  if (twiceArea === 0) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const area = twiceArea / 2;
  return [cx / (6 * area), cy / (6 * area)];
}

/** A `MultiLineString` + `symbol-placement: 'line'` needs the SAME midpoint
 * fallback as a single `LineString` — applied to whichever part has
 * the greatest cumulative length, not (say) the first part, which may be a short spur. */
function longestPartMidpoint(parts: [number, number][][]): [number, number] {
  let longest: [number, number][] = parts[0] ?? [];
  let longestLength = -1;
  for (const part of parts) {
    let length = 0;
    for (let i = 1; i < part.length; i++) {
      const [x0, y0] = part[i - 1];
      const [x1, y1] = part[i];
      length += Math.hypot(x1 - x0, y1 - y0);
    }
    if (length > longestLength) {
      longestLength = length;
      longest = part;
    }
  }
  return lineMidpoint(longest);
}

/** The largest sub-polygon (by exterior-ring area) of a `MultiPolygon`,
 * centroid of its exterior ring — the same "pick the dominant part" strategy as
 * `longestPartMidpoint` for MultiLineString. */
function largestPolygonCentroid(polygons: [number, number][][][]): [number, number] {
  let best: [number, number][][] = polygons[0] ?? [];
  let bestArea = -1;
  for (const poly of polygons) {
    const area = Math.abs(ringShoelaceSum(poly?.[0] ?? []));
    if (area > bestArea) {
      bestArea = area;
      best = poly;
    }
  }
  return polygonCentroid(best);
}

/** Reduces every feature to a single labeling point: `Point` passes through unchanged;
 * `MultiPoint` uses its first position; `LineString`/`MultiLineString` under
 * `symbol-placement: 'line'` use the midpoint fallback (warning once
 * per style-layer id — `longestPartMidpoint` for the Multi- case); `Polygon`/`MultiPolygon`
 * label at their (exterior-ring) centroid (previously not handled at all,
 * producing a NaN `getPosition` since `geometry.coordinates` for a polygon is a nested ring
 * array, not a `[lng, lat]` pair). Any feature that still can't produce a finite `[lng, lat]`
 * (an empty/degenerate geometry, or a geometry type with no defined label-point rule, e.g.
 * `GeometryCollection`) is dropped rather than emitting `NaN` into `TextLayer.getPosition`. */
function toLabelPoints(
  styleLayer: StyleLayer,
  features: Feature[],
  warnOnce: (id: string) => void
): Feature[] {
  const placement = styleLayer.layout?.['symbol-placement'];
  const result: Feature[] = [];
  for (const f of features) {
    const geometry = f.geometry as {type: string; coordinates: unknown};
    if (geometry.type === 'Point') {
      result.push(f);
      continue;
    }
    let point: [number, number] | undefined;
    switch (geometry.type) {
      case 'MultiPoint':
        point = (geometry.coordinates as [number, number][])[0];
        break;
      case 'LineString':
        if (placement === 'line') warnOnce(styleLayer.id);
        point = lineMidpoint(geometry.coordinates as [number, number][]);
        break;
      case 'MultiLineString':
        if (placement === 'line') warnOnce(styleLayer.id);
        point = longestPartMidpoint(geometry.coordinates as [number, number][][]);
        break;
      case 'Polygon':
        point = polygonCentroid(geometry.coordinates as [number, number][][]);
        break;
      case 'MultiPolygon':
        point = largestPolygonCentroid(geometry.coordinates as [number, number][][][]);
        break;
      default:
        point = undefined;
    }
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
      result.push({...f, geometry: {type: 'Point', coordinates: point}} as Feature);
    }
  }
  return result;
}

export function mapSymbolIconLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  spriteAtlas: MapLibreSpriteAtlas,
  cache?: CompileCache
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom, cache);
  if (matched.length === 0 || !styleLayer.layout?.['icon-image']) return null;

  const iconImage = compileExpression<string>(
    styleLayer.layout['icon-image'],
    {type: 'string'},
    evaluator,
    cache
  );
  const iconSize = compileExpression<number>(
    styleLayer.layout?.['icon-size'] ?? 1,
    {type: 'number'},
    evaluator,
    cache
  );

  const iconMapping = spriteToIconMapping(spriteAtlas.mapping);

  // MapLibre's `icon-size` is a MULTIPLIER of the sprite's native (logical,
  // pixelRatio-corrected) size — not an absolute IconLayer `getSize` pixel value.
  // `IconLayer.getSize` (icon-layer-vertex.glsl.ts: `sizePixels = getSize() * sizeScale`) *is*
  // the absolute on-screen pixel size along the mapping's `sizeBasis` dimension (height, by
  // deck.gl's default) — it does not itself scale by the sprite rect's raw pixel dimensions, so
  // passing the multiplier straight through (the previous code) produced ~1px icons for the
  // common `icon-size: 1` case. Look up the resolved icon's native height (`rect.height /
  // rect.pixelRatio`) and multiply by the compiled multiplier.
  function getNativeIconSize(iconName: string): number {
    const entry = iconMapping[iconName];
    return entry ? entry.height / entry.pixelRatio : 0;
  }

  return new IconLayer({
    id: `maplibre-${styleLayer.id}`,
    data: matched,
    iconAtlas: spriteAtlas.image,
    iconMapping,
    getPosition: (f: unknown) =>
      (f as {geometry: {coordinates: [number, number]}}).geometry.coordinates,
    getIcon: (f: unknown) => iconImage.evaluate(zoom, f as never),
    getSize: (f: unknown) =>
      getNativeIconSize(iconImage.evaluate(zoom, f as never)) * iconSize.evaluate(zoom, f as never),
    updateTriggers: {
      getIcon: iconImage.isZoomDependent ? zoomBucket(zoom) : undefined,
      getSize: iconImage.isZoomDependent || iconSize.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}

export function mapSymbolTextLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleEvaluator,
  zoom: number,
  warnOnce: (id: string) => void,
  cache?: CompileCache
): Layer | null {
  const matched = filterFeatures(styleLayer, features, evaluator, zoom, cache);
  if (matched.length === 0 || !styleLayer.layout?.['text-field']) return null;

  const labelPoints = toLabelPoints(styleLayer, matched, warnOnce);
  const textField = compileExpression<string>(
    styleLayer.layout['text-field'],
    {type: 'string'},
    evaluator,
    cache
  );
  // text-size (16 is the style-spec's own default) and text-color (paint,
  // '#000000' default) were entirely unmapped — every label rendered at TextLayer's hardcoded
  // default size (32px)/color regardless of the style JSON. `TextLayer.getSize`'s default
  // `sizeUnits` is already 'pixels' (unlike GeoJsonLayer's 'meters' default), matching
  // MapLibre's own always-pixels `text-size` unit with no extra unit mapping needed.
  const textSize = compileExpression<number>(
    styleLayer.layout['text-size'] ?? 16,
    {type: 'number'},
    evaluator,
    cache
  );
  const textColor = compileExpression<string>(
    styleLayer.paint?.['text-color'] ?? '#000000',
    {type: 'color'},
    evaluator,
    cache
  );
  const textOpacity = compileExpression<number>(
    styleLayer.paint?.['text-opacity'] ?? 1,
    {type: 'number'},
    evaluator,
    cache
  );
  // `priorityValue ?` is falsy for the literal sort-key value `0` — a valid,
  // common "most important" value in MapLibre's ascending-priority convention — which silently
  // skipped compiling a priority accessor for exactly that case. Check `!== undefined` instead.
  const priorityValue = styleLayer.layout?.['symbol-sort-key'];
  const priority =
    priorityValue !== undefined
      ? compileExpression<number>(priorityValue, {type: 'number'}, evaluator, cache)
      : null;

  return new TextLayer({
    id: `maplibre-${styleLayer.id}`,
    data: labelPoints,
    getPosition: (f: unknown) =>
      (f as {geometry: {coordinates: [number, number]}}).geometry.coordinates,
    getText: (f: unknown) => textField.evaluate(zoom, f as never),
    getSize: (f: unknown) => textSize.evaluate(zoom, f as never),
    getColor: (f: unknown) =>
      toRGBA(textColor.evaluate(zoom, f as never), textOpacity.evaluate(zoom, f as never)),
    // Browser-font approximation of `text-font` (accepted v1 cut, no
    // glyph-PBF fetch/parity with the style's `glyphs` URL).
    fontFamily: 'sans-serif',
    collisionEnabled: true,
    // Not caught by the unit test suite (only surfaced via manual/browser verification):
    // `extensions` always includes `CollisionFilterExtension`, so `getCollisionPriority` must always resolve to a
    // real accessor. Explicitly setting the prop to `undefined` (rather than omitting the key)
    // overrides the extension's own `getCollisionPriority` default (0) with `undefined` — deck.gl
    // prop merging is a plain object spread, so an explicit `undefined` value wins over a
    // default — which threw "accessor getCollisionPriority is not a function" the first time
    // this ran in a real browser (a style layer with no `symbol-sort-key`, the common case). Omit
    // the key entirely instead when there is no compiled priority expression.
    // MapLibre's `symbol-sort-key` is LOW-wins ("features with a lower sort key
    // will have priority", MapLibre style-spec), but `CollisionFilterExtension.getCollisionPriority`
    // is HIGH-wins ("features with higher values are shown preferentially",
    // collision-filter-extension.ts) — negate to translate one convention to the other.
    ...(priority
      ? {getCollisionPriority: (f: unknown) => -priority.evaluate(zoom, f as never)}
      : {}),
    extensions: [new CollisionFilterExtension()],
    updateTriggers: {
      getText: textField.isZoomDependent ? zoomBucket(zoom) : undefined,
      getSize: textSize.isZoomDependent ? zoomBucket(zoom) : undefined,
      getColor: zoomDependentBucket(zoom, textColor, textOpacity),
      getCollisionPriority: priority?.isZoomDependent ? zoomBucket(zoom) : undefined
    }
  });
}
