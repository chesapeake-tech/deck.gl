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

// Review finding I3(a): MapLibre's `line-width` is always in CSS pixels; GeoJsonLayer's default
// `lineWidthUnits` is 'meters', so an unmapped line-width silently scaled with zoom/latitude
// instead of staying a constant screen-space width.
test('mapLineLayer#line-width is mapped in pixel units (lineWidthUnits: "pixels")', () => {
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
    {id: 'border', type: 'line', paint: {'line-color': '#000', 'line-width': 3}},
    [lineFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.lineWidthUnits).toBe('pixels');
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

// Review finding I1: the style-spec's parsed Color is PREMULTIPLIED — rgba(255,0,0,.5) parses
// to {r:.5, g:0, b:0, a:.5}, not {r:1, g:0, b:0, a:.5}. The un-premultiplied reading darkens
// every semi-transparent color (r:.5*255=127 instead of the correct 255).
test('mapFillLayer#semi-transparent fill-color un-premultiplies correctly (rgba(255,0,0,.5) -> full-intensity red at alpha 127)', () => {
  const styleLayer = {
    id: 'translucent',
    type: 'fill',
    paint: {'fill-color': 'rgba(255,0,0,0.5)'}
  };
  const layer = mapFillLayer(styleLayer, [polygonFeature], evaluator, 10) as GeoJsonLayer;
  const getFillColor = layer.props.getFillColor as (f: unknown) => number[];
  const [r, g, b, a] = getFillColor(polygonFeature);
  expect(r).toBe(255);
  expect(g).toBe(0);
  expect(b).toBe(0);
  expect(a).toBe(128);
});

// Review finding I5: `source-layer`, `layout.visibility: 'none'`, and `minzoom`/`maxzoom` were
// entirely unhandled — every style layer matched every feature from every named vector-tile
// layer, at every zoom, regardless of these MapLibre-mandatory scoping fields.
test('mapFillLayer#source-layer scopes to the matching feature.properties.layerName only', () => {
  const styleLayer = {
    id: 'water',
    type: 'fill',
    'source-layer': 'water',
    paint: {'fill-color': '#0000ff'}
  };
  const waterFeature = {
    ...polygonFeature,
    properties: {...polygonFeature.properties, layerName: 'water'}
  };
  const buildingFeature = {
    ...polygonFeature,
    properties: {...polygonFeature.properties, layerName: 'building'}
  };
  const layer = mapFillLayer(
    styleLayer,
    [waterFeature, buildingFeature],
    evaluator,
    10
  ) as GeoJsonLayer;
  expect(layer.props.data).toEqual([waterFeature]);
});

test('mapFillLayer#layout.visibility "none" suppresses the layer entirely', () => {
  const styleLayer = {
    id: 'hidden',
    type: 'fill',
    layout: {visibility: 'none'},
    paint: {'fill-color': '#0000ff'}
  };
  expect(mapFillLayer(styleLayer, [polygonFeature], evaluator, 10)).toBeNull();
});

test('mapFillLayer#minzoom/maxzoom restrict the layer to its declared zoom range', () => {
  const styleLayer = {
    id: 'ranged',
    type: 'fill',
    minzoom: 8,
    maxzoom: 12,
    paint: {'fill-color': '#0000ff'}
  };
  expect(mapFillLayer(styleLayer, [polygonFeature], evaluator, 7)).toBeNull();
  expect(mapFillLayer(styleLayer, [polygonFeature], evaluator, 8)).not.toBeNull();
  expect(mapFillLayer(styleLayer, [polygonFeature], evaluator, 11.9)).not.toBeNull();
  expect(mapFillLayer(styleLayer, [polygonFeature], evaluator, 12)).toBeNull();
});

test('mapBackgroundLayer#layout.visibility "none" and out-of-zoom-range both suppress the background layer', () => {
  expect(
    mapBackgroundLayer(
      {id: 'bg', type: 'background', layout: {visibility: 'none'}, paint: {}},
      evaluator,
      10
    )
  ).toBeNull();
  expect(
    mapBackgroundLayer({id: 'bg', type: 'background', minzoom: 12, paint: {}}, evaluator, 10)
  ).toBeNull();
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
