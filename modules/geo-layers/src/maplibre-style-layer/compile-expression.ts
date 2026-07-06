// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';

/** MapLibre's own camera/composite expressions are defined as interpolation between integer
 * zoom stops (tile buckets are built per integer zoom in mapbox-gl-js/maplibre-gl-js itself) —
 * bucketing to `Math.floor(zoom)` re-evaluates at the same granularity upstream already uses,
 * not a deck.gl-specific shortcut. See
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md, Decisions for review #3. */
export function zoomBucket(zoom: number): number {
  return Math.floor(zoom);
}

export interface CompiledExpression<T> {
  evaluate: (zoom: number, feature: {properties: Record<string, unknown>}) => T;
  /** True for 'camera'/'composite' expression kinds (depend on `["zoom"]`) — callers should
   * key this accessor's `updateTriggers` entry on `zoomBucket(viewport.zoom)`. False for
   * 'constant'/'source' (data-driven only) — no updateTrigger needed; evaluated once (or on
   * data change only). */
  isZoomDependent: boolean;
}

/** A caller-supplied shorthand — the plan's mapper call sites pass `{type: 'color'}`,
 * `{type: 'number'}`, `{type: 'string'}`, `{type: 'array', value: 'number', length: N}`. The
 * real `@maplibre/maplibre-gl-style-spec#createPropertyExpression` needs a fuller
 * `StylePropertySpecification` (an `expression: {interpolated, parameters}` block and a
 * `property-type`) to recognize `["zoom"]`/`["get", ...]` usage and return the correct
 * `'camera'`/`'composite'`/`'source'` expression kind — verified against the real package's
 * runtime behavior, not assumed from the plan's inline sketch (Deviation, Task 7: the plan's
 * literal `{type: 'color'}`/`{type: 'number'}` objects produce an `undefined` expression kind
 * for zoom/data-driven input against the real package, which would always report
 * `isZoomDependent: false`). A caller may also pass an already-full spec (containing
 * `property-type`) directly; it is used as-is. */
type ShorthandPropertySpec = {
  type: 'color' | 'number' | 'string' | 'array';
  value?: 'number' | 'string';
  length?: number;
};

function toFullPropertySpec(propertySpec: unknown): Record<string, unknown> {
  const spec = propertySpec as ShorthandPropertySpec & Record<string, unknown>;
  if (spec['property-type']) {
    // Caller already supplied a full StylePropertySpecification-shaped object.
    return spec;
  }
  const full: Record<string, unknown> = {
    type: spec.type,
    expression: {
      // Only 'color'/'number' support smooth interpolation in the real style-spec; 'string' and
      // 'array' (e.g. line-dasharray) are step/data-only, matching the spec's own reference
      // property definitions (`s.latest.paint_line['line-width']` vs. `paint_line['line-dasharray']`).
      interpolated: spec.type === 'color' || spec.type === 'number',
      parameters: ['zoom', 'feature']
    },
    'property-type': 'data-driven'
  };
  if (spec.type === 'array') {
    full.value = spec.value ?? 'number';
    if (spec.length !== undefined) full.length = spec.length;
  }
  return full;
}

/** A plain (non-`['literal', ...]`-wrapped) array value — e.g. `line-dasharray: [2, 1]`, the
 * idiomatic way to write it in a MapLibre style JSON — parses as an *invalid* expression
 * (`isExpression()` requires the first element to be a known operator string), not as a
 * constant, if handed to `createPropertyExpression` unmodified. Real MapLibre style-layer
 * processing (`normalizePropertyExpression`'s callers upstream) performs this same
 * literal-wrapping before parsing; do it here so mapper call sites can pass idiomatic style
 * JSON values without pre-wrapping them. Expression arrays (e.g. `["get", "x"]`, `["==", ...]`)
 * always start with a string operator and are left untouched. */
function normalizeExpressionInput(value: unknown): unknown {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] !== 'string') {
    return ['literal', value];
  }
  return value;
}

/** Compiles one paint/layout property value once via the injected evaluator's
 * `createPropertyExpression`, returning a per-feature evaluator plus whether it needs
 * per-zoom-bucket re-evaluation (Decisions for review #3). */
export function compileExpression<T>(
  value: unknown,
  propertySpec: unknown,
  evaluator: MapLibreStyleEvaluator
): CompiledExpression<T> {
  const fullSpec = toFullPropertySpec(propertySpec);
  const input = normalizeExpressionInput(value);
  const result = evaluator.createPropertyExpression(input, fullSpec);
  const compiled = result.value;
  if (!compiled) {
    throw new Error(`Invalid MapLibre style expression: ${JSON.stringify(value)}`);
  }
  const isZoomDependent = compiled.kind === 'camera' || compiled.kind === 'composite';
  return {
    isZoomDependent,
    evaluate: (zoom, feature) => compiled.evaluate({zoom}, feature as never) as T
  };
}
