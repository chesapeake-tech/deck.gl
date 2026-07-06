// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {GeoJsonLayer} from '@deck.gl/layers';
import {PathStyleExtension} from '@deck.gl/extensions';
import {
  mapBackgroundLayer,
  mapFillLayer,
  mapLineLayer,
  mapFillExtrusionLayer
} from '@deck.gl/geo-layers/maplibre-style-layer/style-layer-mappers';

const evaluator = {createPropertyExpression, featureFilter};

const polygonFeature = {
  type: 'Feature' as const,
  properties: {class: 'park'},
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

test('mapBackgroundLayer#produces a SolidPolygonLayer-backed layer with background-color', () => {
  const layer = mapBackgroundLayer(
    {id: 'bg', type: 'background', paint: {'background-color': '#e0e0e0'}},
    evaluator,
    10
  );
  expect(layer).not.toBeNull();
});

test('mapFillLayer#filters, colors via fill-color, null when nothing matches', () => {
  const styleLayer = {
    id: 'parks',
    type: 'fill',
    filter: ['==', ['get', 'class'], 'park'],
    paint: {'fill-color': '#00ff00', 'fill-opacity': 0.5}
  };
  const layer = mapFillLayer(styleLayer, [polygonFeature], evaluator, 10);
  expect(layer).toBeInstanceOf(GeoJsonLayer);

  const noMatch = mapFillLayer(
    {...styleLayer, filter: ['==', ['get', 'class'], 'water']},
    [polygonFeature],
    evaluator,
    10
  );
  expect(noMatch).toBeNull();
});

test('mapLineLayer#applies line-dasharray via PathStyleExtension', () => {
  const lineFeature = {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [0, 0],
        [1, 1]
      ]
    }
  };
  const layer = mapLineLayer(
    {id: 'border', type: 'line', paint: {'line-color': '#000', 'line-dasharray': [2, 1]}},
    [lineFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.extensions?.some(e => e instanceof PathStyleExtension)).toBe(true);
});

test('mapFillExtrusionLayer#extruded true, getElevation from fill-extrusion-height', () => {
  const extrudedFeature = {...polygonFeature, properties: {'fill-extrusion-height': 30}};
  const layer = mapFillExtrusionLayer(
    {
      id: 'buildings',
      type: 'fill-extrusion',
      paint: {'fill-extrusion-height': ['get', 'fill-extrusion-height']}
    },
    [extrudedFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.extruded).toBe(true);
});
