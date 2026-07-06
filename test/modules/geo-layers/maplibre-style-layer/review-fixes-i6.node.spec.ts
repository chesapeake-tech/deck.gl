// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MVTLayer} from '@deck.gl/geo-layers';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';

// Review finding I6: filters/expressions should compile ONCE per style (keyed on style+evaluator
// identity), not once per tile — the per-tile `renderSubLayers` callback previously called
// mapFillLayer/etc., which called compileExpression/compileFilter, on every single tile,
// re-running createPropertyExpression's real parse/AST-build work for the exact same style-layer
// paint value every time.

const style = {
  layers: [{id: 'water', type: 'fill', paint: {'fill-color': '#0000ff'}}]
};

const feature = {
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ]
    ]
  }
};

test("MapLibreStyleLayer#compiles a style layer's paint expressions once, reused across multiple tiles", () => {
  const createPropertyExpressionSpy = vi.fn(createPropertyExpression);
  const evaluator = {createPropertyExpression: createPropertyExpressionSpy, featureFilter};

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: {zoom: 5}};
  (layer as any).internalState = {subLayers: []};
  (layer as any).state = {};

  const layers = layer.renderLayers() as any[];
  const mvt = layers.find(l => l instanceof MVTLayer);
  const renderSubLayers = mvt.props.renderSubLayers;

  renderSubLayers({id: 'tile-1', data: [feature]});
  const callsAfterFirstTile = createPropertyExpressionSpy.mock.calls.length;
  expect(callsAfterFirstTile).toBeGreaterThan(0);

  renderSubLayers({id: 'tile-2', data: [feature]});
  const callsAfterSecondTile = createPropertyExpressionSpy.mock.calls.length;
  // A second tile, same style layer, same paint value -> no additional compile calls.
  expect(callsAfterSecondTile).toBe(callsAfterFirstTile);
});

test('MapLibreStyleLayer#recompiles when the style prop identity changes (a new style JSON is passed)', () => {
  const createPropertyExpressionSpy = vi.fn(createPropertyExpression);
  const evaluator = {createPropertyExpression: createPropertyExpressionSpy, featureFilter};

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: {zoom: 5}};
  (layer as any).internalState = {subLayers: []};
  (layer as any).state = {};

  const layers1 = layer.renderLayers() as any[];
  layers1
    .find(l => l instanceof MVTLayer)
    .props.renderSubLayers({
      id: 'tile-1',
      data: [feature]
    });
  const callsAfterFirstStyle = createPropertyExpressionSpy.mock.calls.length;

  // A brand-new style object (different reference, same content) -> the cache must not be
  // reused across it (a stale compiled expression referencing a since-replaced style/evaluator
  // would be a correctness bug, not just a missed optimization).
  const newStyle = {
    layers: [{id: 'water', type: 'fill', paint: {'fill-color': '#0000ff'}}]
  };
  // Simulates what the real lifecycle manager does across a prop update: the SAME underlying
  // `state` object carries forward onto a layer instance with new props (LayerManager's
  // transferState) — `layer.props` itself is frozen per-instance, so a second `MapLibreStyleLayer`
  // instance (with the new style) is constructed and given the first instance's `state` directly.
  const layer2 = new MapLibreStyleLayer({
    style: newStyle,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer2 as any).context = (layer as any).context;
  (layer2 as any).internalState = {subLayers: []};
  (layer2 as any).state = (layer as any).state;

  const layers2 = layer2.renderLayers() as any[];
  layers2
    .find(l => l instanceof MVTLayer)
    .props.renderSubLayers({
      id: 'tile-1',
      data: [feature]
    });
  const callsAfterSecondStyle = createPropertyExpressionSpy.mock.calls.length;
  expect(callsAfterSecondStyle).toBeGreaterThan(callsAfterFirstStyle);
});

// Review finding M4: `source` is a caller-supplied, index-signature bag of MVTLayer/TileLayer
// props (documented escape hatch for e.g. `fetch`) — if it happens to carry its own `id`, that
// must not clobber the composite-computed, properly namespaced inner MVTLayer id.
test('MapLibreStyleLayer#a source.id does not clobber the namespaced inner MVTLayer id', () => {
  const evaluator = {createPropertyExpression, featureFilter};
  const layer = new MapLibreStyleLayer({
    id: 'my-style-layer',
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt', id: 'attacker-controlled-id'},
    evaluator
  });
  (layer as any).context = {viewport: {zoom: 5}};
  (layer as any).internalState = {subLayers: []};
  (layer as any).state = {};

  const layers = layer.renderLayers() as any[];
  const mvt = layers.find(l => l instanceof MVTLayer);
  expect(mvt.props.id).not.toBe('attacker-controlled-id');
  expect(mvt.props.id).toBe('my-style-layer-source');
});
