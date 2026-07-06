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

// Review finding C3: featureFilter's $type / ["geometry-type"] compare against a
// VectorTileFeature's numeric `type` code (1/2/3), not a GeoJSON feature's `type: 'Feature'` —
// unshimmed, a legacy `$type` filter drops every GeoJSON feature silently.
test('compileFilter#legacy ["==", "$type", "Polygon"] matches GeoJSON Polygon/MultiPolygon features', () => {
  const fn = compileFilter(['==', '$type', 'Polygon'], evaluator);
  expect(fn(10, {properties: {}, geometry: {type: 'Polygon'}} as any)).toBe(true);
  expect(fn(10, {properties: {}, geometry: {type: 'LineString'}} as any)).toBe(false);
});

test('compileFilter#expression ["==", ["geometry-type"], "Polygon"] matches GeoJSON Polygon features', () => {
  const fn = compileFilter(['==', ['geometry-type'], 'Polygon'], evaluator);
  expect(fn(10, {properties: {}, geometry: {type: 'Polygon'}} as any)).toBe(true);
  expect(fn(10, {properties: {}, geometry: {type: 'Point'}} as any)).toBe(false);
});
