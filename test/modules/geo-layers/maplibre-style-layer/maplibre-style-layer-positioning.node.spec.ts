// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {GeoJsonLayer} from '@deck.gl/layers';
import {ClipExtension} from '@deck.gl/extensions';
import {applyTilePositioning} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';

// Regression test for a correctness gap in the plan's Task 12 sketch (see the report):
// MVTLayer's own renderSubLayers sets modelMatrix/coordinateOrigin/coordinateSystem/extensions
// on the tile props object in the classic Mercator (non-feature-route) case; mapped style-layer
// sublayers must inherit that positioning or they render at the wrong place/scale.

test('applyTilePositioning#Mercator tileProps (modelMatrix set): threads positioning, merges extensions', () => {
  const layer = new GeoJsonLayer({id: 'x', data: []});
  const clip = new ClipExtension();
  const positioned = applyTilePositioning(layer, {
    modelMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    coordinateOrigin: [1, 2, 0],
    coordinateSystem: 1,
    extensions: [clip]
  });
  expect(positioned).not.toBe(layer);
  expect(positioned.props.modelMatrix).toBeTruthy();
  expect(positioned.props.coordinateOrigin).toEqual([1, 2, 0]);
  expect(positioned.props.coordinateSystem).toBe(1);
  expect(positioned.props.extensions?.some(e => e instanceof ClipExtension)).toBe(true);
});

test('applyTilePositioning#feature-route tileProps (modelMatrix undefined): passthrough unchanged', () => {
  const layer = new GeoJsonLayer({id: 'x', data: []});
  const result = applyTilePositioning(layer, {});
  expect(result).toBe(layer);
});
