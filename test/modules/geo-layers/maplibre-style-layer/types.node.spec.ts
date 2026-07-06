// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import * as styleSpec from '@maplibre/maplibre-gl-style-spec';
import type {MapLibreStyleEvaluator} from '@deck.gl/geo-layers/maplibre-style-layer/types';

test('the real @maplibre/maplibre-gl-style-spec package satisfies MapLibreStyleEvaluator structurally', () => {
  const evaluator: MapLibreStyleEvaluator = {
    createPropertyExpression: styleSpec.createPropertyExpression,
    featureFilter: styleSpec.featureFilter
  };
  expect(typeof evaluator.createPropertyExpression).toBe('function');
  expect(typeof evaluator.featureFilter).toBe('function');
});

// Round 8 fork feedback #4: `convertFunction` is optional (an existing `evaluator` without it
// keeps compiling — legacy `{stops: [...]}` styles just throw a clearer error), but the real
// package's own export satisfies it structurally with zero adaptation, same as the two
// required entry points.
test('the real @maplibre/maplibre-gl-style-spec package also satisfies the optional convertFunction entry point', () => {
  const evaluator: MapLibreStyleEvaluator = {
    createPropertyExpression: styleSpec.createPropertyExpression,
    featureFilter: styleSpec.featureFilter,
    convertFunction: styleSpec.convertFunction
  };
  expect(typeof evaluator.convertFunction).toBe('function');
});
