// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {compileFilter} from '@deck.gl/geo-layers/maplibre-style-layer/compile-filter';

const evaluator = {createPropertyExpression, featureFilter};

test('compileFilter#no filter always passes', () => {
  const fn = compileFilter(undefined, evaluator);
  expect(fn(10, {properties: {}})).toBe(true);
});

test('compileFilter#["==", ["get", "class"], "park"]', () => {
  const fn = compileFilter(['==', ['get', 'class'], 'park'], evaluator);
  expect(fn(10, {properties: {class: 'park'}})).toBe(true);
  expect(fn(10, {properties: {class: 'water'}})).toBe(false);
});

test('compileFilter#zoom-dependent filter (>=)', () => {
  const fn = compileFilter(['>=', ['zoom'], 12], evaluator);
  expect(fn(11, {properties: {}})).toBe(false);
  expect(fn(12, {properties: {}})).toBe(true);
});
