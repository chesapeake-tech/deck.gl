// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {IconLayer, TextLayer} from '@deck.gl/layers';
import {CollisionFilterExtension} from '@deck.gl/extensions';
import {
  mapSymbolIconLayer,
  mapSymbolTextLayer
} from '@deck.gl/geo-layers/maplibre-style-layer/symbol-mappers';

const evaluator = {createPropertyExpression, featureFilter};

const pointFeature = {
  type: 'Feature' as const,
  properties: {name: 'Overfalls', 'symbol-sort-key': 5},
  geometry: {type: 'Point' as const, coordinates: [-74, 40]}
};

test('mapSymbolIconLayer#produces an IconLayer using spriteAtlas mapping', () => {
  const layer = mapSymbolIconLayer(
    {id: 'poi', type: 'symbol', layout: {'icon-image': 'harbor-15'}},
    [pointFeature],
    evaluator,
    10,
    {image: 'atlas.png', mapping: {'harbor-15': {x: 0, y: 0, width: 15, height: 15}}}
  );
  expect(layer).toBeInstanceOf(IconLayer);
});

test('mapSymbolTextLayer#point placement: TextLayer with CollisionFilterExtension, priority from symbol-sort-key', () => {
  const warnOnce = vi.fn();
  const layer = mapSymbolTextLayer(
    {
      id: 'labels',
      type: 'symbol',
      layout: {'text-field': ['get', 'name'], 'symbol-sort-key': ['get', 'symbol-sort-key']}
    },
    [pointFeature],
    evaluator,
    10,
    warnOnce
  ) as TextLayer;
  expect(layer).toBeInstanceOf(TextLayer);
  expect(layer.props.extensions?.some(e => e instanceof CollisionFilterExtension)).toBe(true);
  expect(warnOnce).not.toHaveBeenCalled();
});

test('mapSymbolTextLayer#symbol-placement:line falls back to midpoint, warns once', () => {
  const lineFeature = {
    type: 'Feature' as const,
    properties: {name: 'Main St'},
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [0, 0],
        [10, 0]
      ]
    }
  };
  const warnOnce = vi.fn();
  const layer = mapSymbolTextLayer(
    {
      id: 'road-labels',
      type: 'symbol',
      layout: {'text-field': ['get', 'name'], 'symbol-placement': 'line'}
    },
    [lineFeature],
    evaluator,
    10,
    warnOnce
  ) as TextLayer;
  expect(layer.props.data).toEqual([
    expect.objectContaining({geometry: {type: 'Point', coordinates: [5, 0]}})
  ]);
  expect(warnOnce).toHaveBeenCalledWith('road-labels');
});
