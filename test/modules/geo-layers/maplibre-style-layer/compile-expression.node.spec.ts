// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {
  createPropertyExpression,
  featureFilter,
  convertFunction
} from '@maplibre/maplibre-gl-style-spec';
import {
  compileExpression,
  zoomBucket
} from '@deck.gl/geo-layers/maplibre-style-layer/compile-expression';

const evaluator = {createPropertyExpression, featureFilter};
const evaluatorWithConvert = {createPropertyExpression, featureFilter, convertFunction};

test('zoomBucket#floors to integer', () => {
  expect(zoomBucket(11.9)).toBe(11);
  expect(zoomBucket(12)).toBe(12);
});

test('compileExpression#constant color, not zoom-dependent', () => {
  const {evaluate, isZoomDependent} = compileExpression<string>(
    '#ff0000',
    {type: 'color'},
    evaluator
  );
  expect(isZoomDependent).toBe(false);
  expect(evaluate(10, {properties: {}})).toBeTruthy();
});

test('compileExpression#zoom-interpolated line-width, zoom-dependent', () => {
  const {evaluate, isZoomDependent} = compileExpression<number>(
    ['interpolate', ['linear'], ['zoom'], 10, 1, 16, 6],
    {type: 'number'},
    evaluator
  );
  expect(isZoomDependent).toBe(true);
  const narrow = evaluate(10, {properties: {}});
  const wide = evaluate(16, {properties: {}});
  expect(Number(wide)).toBeGreaterThan(Number(narrow));
});

test('compileExpression#data-driven (["get", ...]) evaluates per feature', () => {
  const {evaluate} = compileExpression<number>(['get', 'height'], {type: 'number'}, evaluator);
  expect(evaluate(10, {properties: {height: 42}})).toBe(42);
});

test('compileExpression#array-typed constant (line-dasharray) does not need literal-wrapping by the caller', () => {
  const {evaluate} = compileExpression<[number, number]>(
    [2, 1],
    {type: 'array', value: 'number', length: 2},
    evaluator
  );
  expect(evaluate(10, {properties: {}})).toEqual([2, 1]);
});

// Review finding C2: `createPropertyExpression` returns
// `{result: 'error', value: ExpressionParsingError[]}` on failure — `value` is a truthy array,
// so the old `if (!compiled) throw` never fired; downstream code then called `.kind`/`.evaluate`
// on an array of error objects, producing an opaque "evaluate is not a function" deep inside a
// render pass instead of a clear compile-time error.
test('compileExpression#throws a clear error (not a silent pass-through) when the expression fails to parse', () => {
  expect(() => compileExpression<number>(['invalid-op', 'x'], {type: 'number'}, evaluator)).toThrow(
    /invalid-op|Unknown expression/i
  );
});

test('compileExpression#evaluator-shape guard: throws a clear error when createPropertyExpression is not a function', () => {
  const brokenEvaluator = {createPropertyExpression: undefined, featureFilter} as any;
  expect(() => compileExpression<number>(5, {type: 'number'}, brokenEvaluator)).toThrow(
    /createPropertyExpression/i
  );
});

// Review finding C3: an expression's ["geometry-type"] operand needs the same VectorTileFeature
// numeric-code shim as featureFilter's $type — a paint expression keyed on geometry-type must
// not silently evaluate against `feature.type === 'Feature'`.
// Review finding M3: legacy "{token}" text-field strings (pre-expression style-spec syntax,
// still common in hand-written styles) must be substituted with the feature's own property
// value, not passed through literally as the braces-and-all text.
test('compileExpression#legacy "{token}" string is substituted with the feature property, not passed through literally', () => {
  const {evaluate} = compileExpression<string>('{name}', {type: 'string'}, evaluator);
  expect(evaluate(10, {properties: {name: 'Overfalls'}})).toBe('Overfalls');
});

test('compileExpression#legacy mixed "prefix {token} suffix" string interpolates the token in place', () => {
  const {evaluate} = compileExpression<string>('Depth: {depth}m', {type: 'string'}, evaluator);
  expect(evaluate(10, {properties: {depth: 42}})).toBe('Depth: 42m');
});

// Review finding M3 (second half): a `["format", ...]` text-field expression is a real
// style-spec construct the adapter doesn't support (its evaluate() result is a rich
// "Formatted" object, not a plain string a TextLayer getText accessor can render) — it should
// surface as the SAME clear compile-time error the C2 fix already produces for any invalid
// expression (a `{type: 'string'}` propertySpec naturally rejects `format`'s `Formatted`
// result type), not an opaque runtime failure.
test('compileExpression#["format", ...] surfaces a clear error via the C2 error path (unsupported by a string propertySpec)', () => {
  expect(() =>
    compileExpression<string>(['format', ['get', 'name'], {}], {type: 'string'}, evaluator)
  ).toThrow(/formatted/i);
});

test('compileExpression#["geometry-type"] expression evaluates against the GeoJSON feature\'s actual geometry', () => {
  const {evaluate} = compileExpression<string>(
    ['case', ['==', ['geometry-type'], 'Polygon'], 'poly', 'other'],
    {type: 'string'},
    evaluator
  );
  expect(evaluate(10, {properties: {}, geometry: {type: 'Polygon'}} as any)).toBe('poly');
  expect(evaluate(10, {properties: {}, geometry: {type: 'Point'}} as any)).toBe('other');
});

// Round 8 fork feedback #4: legacy (pre-expression) `{stops: [...]}` zoom functions are real,
// current-day style JSON (CARTO/Esri still ship them) — `createPropertyExpression` rejects a
// bare stops object outright ("Bare objects invalid") unless it's converted to an expression
// first via the style-spec's own `convertFunction`.
test('compileExpression#legacy {stops} zoom function is converted and evaluates like a real expression', () => {
  const legacy = {
    stops: [
      [5, '#ff0000'],
      [10, '#0000ff']
    ]
  };
  const {evaluate, isZoomDependent} = compileExpression<string>(
    legacy,
    {type: 'color'},
    evaluatorWithConvert
  );
  expect(isZoomDependent).toBe(true);
  expect(evaluate(5, {properties: {}})).toBeTruthy();
  expect(evaluate(10, {properties: {}})).toBeTruthy();
});

test('compileExpression#legacy {stops} function throws a clear error when the evaluator has no convertFunction', () => {
  const legacy = {
    stops: [
      [5, '#ff0000'],
      [10, '#0000ff']
    ]
  };
  expect(() => compileExpression<string>(legacy, {type: 'color'}, evaluator)).toThrow(
    /convertFunction/i
  );
});

// Round 8 fork feedback #4: a real style's `line-dasharray` zoom function can mix stop lengths
// (CARTO ships `[1]` at z5, `[2, 2]` at z7) — MapLibre's own dasharray semantics are cyclic
// (`[1]` repeats identically to `[1, 1, ...]`), so the adapter must equalize stops to a common
// length before compiling, both so `createPropertyExpression` doesn't reject the mismatch and so
// every evaluated stop is actually the same length at runtime (`PathStyleExtension`'s
// fixed-size-2 `getDashArray` accessor needs that, not just a passing compile-time check).
test('compileExpression#unequal-length line-dasharray stops are cyclic-equalized before compiling', () => {
  const legacyDasharray = {
    stops: [
      [5, [1]],
      [7, [2, 2]]
    ]
  };
  const {evaluate} = compileExpression<number[]>(
    legacyDasharray,
    {type: 'array', value: 'number'},
    evaluatorWithConvert
  );
  expect(evaluate(5, {properties: {}})).toEqual([1, 1]);
  expect(evaluate(7, {properties: {}})).toEqual([2, 2]);
});

test('compileExpression#unequal-length dasharray also equalizes when authored directly as a step expression (no legacy stops)', () => {
  const stepExpression = ['step', ['zoom'], ['literal', [1]], 7, ['literal', [2, 2]]];
  const {evaluate} = compileExpression<number[]>(
    stepExpression,
    {type: 'array', value: 'number'},
    evaluator
  );
  expect(evaluate(5, {properties: {}})).toEqual([1, 1]);
  expect(evaluate(7, {properties: {}})).toEqual([2, 2]);
});
