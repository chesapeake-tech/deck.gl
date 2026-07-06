// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';
import {withGeometryTypeCode} from './geometry-type';

/** MapLibre's own camera/composite expressions are defined as interpolation between integer
 * zoom stops (tile buckets are built per integer zoom in mapbox-gl-js/maplibre-gl-js itself) —
 * bucketing to `Math.floor(zoom)` re-evaluates at the same granularity upstream already uses,
 * not a deck.gl-specific shortcut. See
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md, Decisions for review #3. */
export function zoomBucket(zoom: number): number {
  return Math.floor(zoom);
}

export interface CompiledExpression<T> {
  evaluate: (
    zoom: number,
    feature: {properties: Record<string, unknown>; geometry?: {type?: string}}
  ) => T;
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
/** Review fix (M3): the legacy (pre-expression, Mapbox Style Spec v7-era) `"{token}"` string
 * syntax — e.g. `text-field: "{name}"`, still common in older/hand-written styles — is NOT
 * token-substituted by `createPropertyExpression` itself; handed through unmodified it parses
 * as a `'constant'` string expression that always evaluates to the literal text
 * `"{name}"` (verified against the real package), never the feature's `name` property.
 * Upstream mapbox-gl-js/maplibre-gl-js perform this token conversion in their own style-layer
 * processing, one layer above `createPropertyExpression` — replicate it here as an equivalent
 * `["concat", ...]` expression (mixing literal text runs with `["get", token]` lookups) so it
 * goes through the same compiled/cached/zoom-aware path as every other expression. A string
 * with no `{...}` token is returned unchanged (the overwhelmingly common case — most style
 * values aren't legacy token strings). */
function convertLegacyTokenString(value: unknown): unknown {
  if (typeof value !== 'string' || !/\{[^{}]+\}/.test(value)) {
    return value;
  }
  const parts: unknown[] = ['concat'];
  const tokenPattern = /\{([^{}]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = tokenPattern.exec(value))) {
    if (match.index > lastIndex) parts.push(value.slice(lastIndex, match.index));
    parts.push(['get', match[1]]);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return parts;
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
  const detokenized = convertLegacyTokenString(value);
  if (Array.isArray(detokenized) && detokenized.length > 0 && typeof detokenized[0] !== 'string') {
    return ['literal', detokenized];
  }
  return detokenized;
}

/** Review fix (I6): a cache shared across every `compileExpression`/`compileFilter` call for one
 * style (constructed once per style+evaluator identity by the composite's `updateState` — see
 * `maplibre-style-layer.ts`), keyed on the paint/layout `value` reference (stable across tile
 * renders and zoom-bucket re-renders because it's read from the same `style.layers[...].paint`
 * object every time, not recreated). Compiling a MapLibre expression is real parse/validate
 * work (`createPropertyExpression`'s own AST build) — without this cache it reran once per
 * style layer *per tile render*, including every zoom-bucket-triggered re-render the C1 fix
 * added, which is exactly the "clean substrate for C1" the review asked for. */
export type CompileCache = Map<unknown, unknown>;

/** Compiles one paint/layout property value once via the injected evaluator's
 * `createPropertyExpression`, returning a per-feature evaluator plus whether it needs
 * per-zoom-bucket re-evaluation (Decisions for review #3). */
export function compileExpression<T>(
  value: unknown,
  propertySpec: unknown,
  evaluator: MapLibreStyleEvaluator,
  cache?: CompileCache
): CompiledExpression<T> {
  const cached = cache?.get(value) as CompiledExpression<T> | undefined;
  if (cached) return cached;
  // Review fix (C2): the injected evaluator is a structural contract (Decisions for review #2),
  // not a typechecked import — a caller can hand in the wrong shape (e.g. a partial mock, or a
  // typo'd property name) and get no compile-time signal. Fail fast with a clear message rather
  // than letting `undefined(...)` throw a generic TypeError deep inside a render pass.
  if (typeof evaluator?.createPropertyExpression !== 'function') {
    throw new Error(
      '_MapLibreStyleLayer: the injected `evaluator.createPropertyExpression` is not a function ' +
        '— pass the real `createPropertyExpression` export from `@maplibre/maplibre-gl-style-spec` ' +
        '(or a structurally identical implementation) as `evaluator.createPropertyExpression`.'
    );
  }
  const fullSpec = toFullPropertySpec(propertySpec);
  const input = normalizeExpressionInput(value);
  const result = evaluator.createPropertyExpression(input, fullSpec) as {
    result?: string;
    value?: {kind: string; evaluate: (globals: unknown, feature?: unknown) => unknown};
  };
  // Review fix (C2): `createPropertyExpression` returns
  // `{result: 'error', value: ExpressionParsingError[]}` on failure — `value` is a truthy array
  // of error objects, not falsy, so the previous `if (!compiled) throw` never fired; the array
  // was then used as if it were `{kind, evaluate}`, producing an opaque "evaluate is not a
  // function" far from the actual cause. Check `result.result` explicitly and surface the real
  // parser error text.
  if (result.result === 'error') {
    const messages = (result.value as unknown as Array<{message?: string}>)
      .map(e => e?.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `_MapLibreStyleLayer: invalid MapLibre style expression ${JSON.stringify(value)}: ${
        messages || '(no parser detail available)'
      }`
    );
  }
  const compiled = result.value;
  if (!compiled) {
    throw new Error(`Invalid MapLibre style expression: ${JSON.stringify(value)}`);
  }
  const isZoomDependent = compiled.kind === 'camera' || compiled.kind === 'composite';
  const compiledExpression: CompiledExpression<T> = {
    isZoomDependent,
    // Review fix (C3): the same VectorTileFeature numeric geometry-type shim compileFilter uses
    // — an ["geometry-type"] operand inside a paint/layout expression needs it too, or it
    // silently evaluates against `feature.type === 'Feature'` instead of the real geometry.
    evaluate: (zoom, feature) =>
      compiled.evaluate({zoom}, withGeometryTypeCode(feature as never) as never) as T
  };
  cache?.set(value, compiledExpression);
  return compiledExpression;
}
