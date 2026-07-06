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

// Review finding I3(b): MapLibre's `icon-size` is a MULTIPLIER of the sprite's native (i.e.
// pixelRatio-corrected) size, not an absolute deck.gl IconLayer `getSize` pixel value. Previously
// `getSize` returned the multiplier directly (1 by default), producing ~1px icons regardless of
// the sprite's actual rectangle size.
test('mapSymbolIconLayer#getSize multiplies the pixelRatio-corrected native sprite size by icon-size', () => {
  const layer = mapSymbolIconLayer(
    {id: 'poi', type: 'symbol', layout: {'icon-image': 'harbor-15', 'icon-size': 2}},
    [pointFeature],
    evaluator,
    10,
    {
      image: 'atlas.png',
      mapping: {'harbor-15': {x: 0, y: 0, width: 30, height: 30, pixelRatio: 2}}
    }
  ) as IconLayer;
  const getSize = layer.props.getSize as (f: unknown) => number;
  // native (logical) size = 30 / pixelRatio(2) = 15; icon-size multiplier = 2 -> 30.
  expect(getSize(pointFeature)).toBe(30);
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

// Review finding I2: MapLibre's symbol-sort-key is LOW-wins ("features with a lower sort key
// will have priority"); deck.gl's CollisionFilterExtension getCollisionPriority is HIGH-wins
// ("features with higher values are shown preferentially") — the sign must be negated when
// translating one convention to the other. Also: `priorityValue ?` is falsy for a literal
// sort-key of 0 (a valid, common "highest priority" value), so a style layer with
// `symbol-sort-key: 0` must still get a compiled priority accessor — checked via !== undefined.
test('mapSymbolTextLayer#symbol-sort-key priority is negated (MapLibre low-wins -> deck.gl high-wins)', () => {
  const layer = mapSymbolTextLayer(
    {
      id: 'labels',
      type: 'symbol',
      layout: {'text-field': ['get', 'name'], 'symbol-sort-key': ['get', 'symbol-sort-key']}
    },
    [pointFeature],
    evaluator,
    10,
    vi.fn()
  ) as TextLayer;
  const getCollisionPriority = layer.props.getCollisionPriority as (f: unknown) => number;
  // pointFeature has symbol-sort-key: 5 (a MapLibre-low, therefore lower-priority value) -> the
  // deck.gl accessor must return a negative number (-5), not 5.
  expect(getCollisionPriority(pointFeature)).toBe(-5);
});

test('mapSymbolTextLayer#symbol-sort-key of literal 0 still produces a getCollisionPriority accessor (not falsy-skipped)', () => {
  const zeroSortKeyFeature = {
    type: 'Feature' as const,
    properties: {name: 'Zero'},
    geometry: {type: 'Point' as const, coordinates: [-74, 40]}
  };
  const layer = mapSymbolTextLayer(
    {id: 'labels', type: 'symbol', layout: {'text-field': ['get', 'name'], 'symbol-sort-key': 0}},
    [zeroSortKeyFeature],
    evaluator,
    10,
    vi.fn()
  ) as TextLayer;
  expect(layer.props.getCollisionPriority).toBeTypeOf('function');
  expect((layer.props.getCollisionPriority as (f: unknown) => number)(zeroSortKeyFeature)).toBe(-0);
});

// Review finding I3(c): text-size (including zoom interpolation) and text-color were entirely
// unmapped — every label rendered at TextLayer's hardcoded default size/color regardless of the
// style JSON.
test('mapSymbolTextLayer#maps text-size (incl. zoom-interpolated) and text-color', () => {
  const styleLayer = {
    id: 'labels',
    type: 'symbol',
    layout: {
      'text-field': ['get', 'name'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 0, 10, 20, 30]
    },
    paint: {'text-color': '#ff0000'}
  };
  const layer = mapSymbolTextLayer(styleLayer, [pointFeature], evaluator, 5, vi.fn()) as TextLayer;
  const getSize = layer.props.getSize as (f: unknown) => number;
  const getColor = layer.props.getColor as (f: unknown) => number[];
  expect(getSize(pointFeature)).toBeCloseTo(15, 0);
  expect(getColor(pointFeature)).toEqual([255, 0, 0, 255]);

  const layerAtHigherZoom = mapSymbolTextLayer(
    styleLayer,
    [pointFeature],
    evaluator,
    15,
    vi.fn()
  ) as TextLayer;
  const sizeAtHigherZoom = (layerAtHigherZoom.props.getSize as (f: unknown) => number)(
    pointFeature
  );
  expect(sizeAtHigherZoom).toBeGreaterThan(getSize(pointFeature));
});

// Review finding I4: toLabelPoints only handled Point and LineString+'line' — every other
// non-Point geometry (MultiLineString, Polygon, MultiPolygon, ...) fell through unchanged, so
// TextLayer's getPosition (`geometry.coordinates`) read a nested coordinate array instead of a
// [lng, lat] pair, producing NaN.
test("mapSymbolTextLayer#MultiLineString + symbol-placement:line uses the longest part's midpoint", () => {
  const multiLineFeature = {
    type: 'Feature' as const,
    properties: {name: 'River'},
    geometry: {
      type: 'MultiLineString' as const,
      coordinates: [
        [
          [0, 0],
          [1, 0]
        ], // length 1 (short part)
        [
          [10, 0],
          [30, 0]
        ] // length 20 (long part) -> midpoint [20, 0]
      ]
    }
  };
  const warnOnce = vi.fn();
  const layer = mapSymbolTextLayer(
    {
      id: 'river-labels',
      type: 'symbol',
      layout: {'text-field': ['get', 'name'], 'symbol-placement': 'line'}
    },
    [multiLineFeature],
    evaluator,
    10,
    warnOnce
  ) as TextLayer;
  expect(layer.props.data).toEqual([
    expect.objectContaining({geometry: {type: 'Point', coordinates: [20, 0]}})
  ]);
  expect(warnOnce).toHaveBeenCalledWith('river-labels');
});

test('mapSymbolTextLayer#Polygon geometry labels at the (exterior-ring) centroid', () => {
  const squareFeature = {
    type: 'Feature' as const,
    properties: {name: 'Park'},
    geometry: {
      type: 'Polygon' as const,
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0]
        ]
      ]
    }
  };
  const layer = mapSymbolTextLayer(
    {id: 'park-labels', type: 'symbol', layout: {'text-field': ['get', 'name']}},
    [squareFeature],
    evaluator,
    10,
    vi.fn()
  ) as TextLayer;
  const [feature] = layer.props.data as any[];
  expect(feature.geometry.type).toBe('Point');
  expect(feature.geometry.coordinates[0]).toBeCloseTo(5, 5);
  expect(feature.geometry.coordinates[1]).toBeCloseTo(5, 5);
});

test('mapSymbolTextLayer#an unsupported/degenerate geometry is dropped, not turned into a NaN position', () => {
  const emptyLineFeature = {
    type: 'Feature' as const,
    properties: {name: 'Nowhere'},
    geometry: {type: 'LineString' as const, coordinates: []}
  };
  const layer = mapSymbolTextLayer(
    {id: 'degenerate', type: 'symbol', layout: {'text-field': ['get', 'name']}},
    [emptyLineFeature],
    evaluator,
    10,
    vi.fn()
  ) as TextLayer | null;
  const data = (layer?.props.data ?? []) as any[];
  for (const f of data) {
    expect(Number.isFinite(f.geometry.coordinates[0])).toBe(true);
    expect(Number.isFinite(f.geometry.coordinates[1])).toBe(true);
  }
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
