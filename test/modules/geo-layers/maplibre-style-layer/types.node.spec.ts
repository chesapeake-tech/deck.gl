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
