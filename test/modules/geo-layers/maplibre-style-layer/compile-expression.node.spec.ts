// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {
  compileExpression,
  zoomBucket
} from '@deck.gl/geo-layers/maplibre-style-layer/compile-expression';

const evaluator = {createPropertyExpression, featureFilter};

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
