// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';
import {MVTLayer} from '@deck.gl/geo-layers';

// Review finding C1: the composite never overrode shouldUpdateState, so a viewport-only change
// (e.g. zoom) never re-ran renderLayers — CompositeLayer's activateViewport only calls
// setNeedsUpdate() when needsUpdate()/shouldUpdateState() returns true (modules/core/src/lib/
// layer.ts:628-631), and Layer's default shouldUpdateState is `changeFlags.propsOrDataChanged`
// only (layer.ts:481-483), which is false for a pure viewport change.

const evaluator = {createPropertyExpression, featureFilter};

const style = {
  layers: [
    {
      id: 'water',
      type: 'fill',
      paint: {'fill-color': ['interpolate', ['linear'], ['zoom'], 0, '#ff0000', 20, '#0000ff']}
    }
  ]
};

test('MapLibreStyleLayer#shouldUpdateState returns true on viewport-only change (zoom)', () => {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  // A pure viewport change: propsOrDataChanged/dataChanged/updateTriggersChanged are all false,
  // only viewportChanged (and the derived somethingChanged) are true.
  const viewportOnlyChangeFlags = {
    dataChanged: false,
    propsChanged: false,
    updateTriggersChanged: false,
    viewportChanged: true,
    somethingChanged: true
  } as any;
  expect(layer.shouldUpdateState({changeFlags: viewportOnlyChangeFlags} as any)).toBe(true);

  const nothingChangedFlags = {
    dataChanged: false,
    propsChanged: false,
    updateTriggersChanged: false,
    viewportChanged: false,
    somethingChanged: false
  } as any;
  expect(layer.shouldUpdateState({changeFlags: nothingChangedFlags} as any)).toBe(false);
});

test('MapLibreStyleLayer#renderLayers wires a zoom-bucketed updateTriggers.renderSubLayers onto the inner MVTLayer, changing value across an integer-zoom crossing', () => {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  // Minimal fake context so renderLayers() (which reads this.context.viewport.zoom and calls
  // this.getSubLayerProps()) can run without a full layer-manager lifecycle.
  (layer as any).context = {viewport: {zoom: 5.7}};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAtZoom5 = layer.renderLayers() as any[];
  const mvt5 = layersAtZoom5.find(l => l instanceof MVTLayer);
  expect(mvt5).toBeTruthy();
  expect(mvt5.props.updateTriggers?.renderSubLayers).toBe(5);

  (layer as any).context = {viewport: {zoom: 6.2}};
  const layersAtZoom6 = layer.renderLayers() as any[];
  const mvt6 = layersAtZoom6.find(l => l instanceof MVTLayer);
  expect(mvt6.props.updateTriggers?.renderSubLayers).toBe(6);
  expect(mvt6.props.updateTriggers?.renderSubLayers).not.toBe(
    mvt5.props.updateTriggers?.renderSubLayers
  );
});
