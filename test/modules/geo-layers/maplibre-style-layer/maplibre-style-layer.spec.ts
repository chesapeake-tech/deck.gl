// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {_MapLibreStyleLayer as MapLibreStyleLayer, MVTLayer} from '@deck.gl/geo-layers';

const evaluator = {createPropertyExpression, featureFilter};

const style = {
  layers: [
    {id: 'bg', type: 'background', paint: {'background-color': '#e8e8e8'}},
    {
      id: 'water',
      type: 'fill',
      filter: ['==', ['get', 'class'], 'water'],
      paint: {'fill-color': '#a0c8f0'}
    },
    {
      id: 'raster-unsupported',
      type: 'raster'
    }
  ]
};

test('MapLibreStyleLayer#renders a background layer and one mapped fill layer, skips unsupported types', async () => {
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -74,
    latitude: 40,
    zoom: 3
  });

  const testCases = [
    {
      props: {
        style,
        source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
        evaluator
      },
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        // Review fix (M1): the background sublayer is now routed through
        // `this.getSubLayerProps` (id namespaced under the composite's own id, e.g.
        // `<compositeId>-bg`, not the mapper's old static `maplibre-bg`).
        expect(subLayers.some(l => l.id.endsWith('-bg'))).toBe(true);
        expect(subLayers.some(l => l instanceof MVTLayer)).toBe(true);
      }
    }
  ];

  await testLayerAsync({
    Layer: MapLibreStyleLayer,
    viewport,
    testCases,
    onError: e => expect(e).toBeFalsy()
  });
});
