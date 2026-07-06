// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';

// Review finding C2 (composite-level half): the evaluator is an injected structural contract
// (Decisions for review #2), not a typechecked import. A malformed evaluator should fail with
// one clear error at the top of renderLayers(), not an opaque error from deep inside a per-tile,
// per-feature compileExpression/compileFilter call.

const style = {
  layers: [{id: 'water', type: 'fill', paint: {'fill-color': '#0000ff'}}]
};

function makeLayer(evaluator: any) {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: {zoom: 5}};
  (layer as any).internalState = {subLayers: []};
  return layer;
}

test('MapLibreStyleLayer#renderLayers throws a clear error when evaluator.createPropertyExpression is missing', () => {
  const layer = makeLayer({featureFilter});
  expect(() => layer.renderLayers()).toThrow(/createPropertyExpression/i);
});

test('MapLibreStyleLayer#renderLayers throws a clear error when evaluator.featureFilter is missing', () => {
  const layer = makeLayer({createPropertyExpression});
  expect(() => layer.renderLayers()).toThrow(/featureFilter/i);
});

test('MapLibreStyleLayer#renderLayers runs fine with the real evaluator', () => {
  const layer = makeLayer({createPropertyExpression, featureFilter});
  expect(() => layer.renderLayers()).not.toThrow();
});
