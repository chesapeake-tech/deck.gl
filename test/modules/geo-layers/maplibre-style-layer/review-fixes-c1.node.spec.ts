// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
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

// Real `WebMercatorViewport`s (not a bare `{zoom}` mock) — `renderLayers` now evaluates style at
// the Mercator-equivalent zoom (`mercatorEquivalentZoom`, Round 8 finding 1), which needs
// `viewport.metersPerPixel`/`.latitude`, not just `.zoom`. For a real Web Mercator viewport this
// is an exact identity, so the zoom-bucket assertions below are unchanged from before that fix.
function webMercatorViewportAt(zoom: number): WebMercatorViewport {
  return new WebMercatorViewport({width: 800, height: 600, longitude: 0, latitude: 0, zoom});
}

test('MapLibreStyleLayer#renderLayers wires a zoom-bucketed updateTriggers.renderSubLayers onto the inner MVTLayer, changing value across an integer-zoom crossing', () => {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  // Minimal fake context so renderLayers() (which reads this.context.viewport and calls
  // this.getSubLayerProps()) can run without a full layer-manager lifecycle.
  (layer as any).context = {viewport: webMercatorViewportAt(5.7)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAtZoom5 = layer.renderLayers() as any[];
  const mvt5 = layersAtZoom5.find(l => l instanceof MVTLayer);
  expect(mvt5).toBeTruthy();
  const [bucket5, style5] = mvt5.props.updateTriggers?.renderSubLayers;
  expect(bucket5).toBe(5);
  expect(style5).toBe(style);

  (layer as any).context = {viewport: webMercatorViewportAt(6.2)};
  const layersAtZoom6 = layer.renderLayers() as any[];
  const mvt6 = layersAtZoom6.find(l => l instanceof MVTLayer);
  const [bucket6, style6] = mvt6.props.updateTriggers?.renderSubLayers;
  expect(bucket6).toBe(6);
  expect(bucket6).not.toBe(bucket5);
  expect(style6).toBe(style);
});

test('MapLibreStyleLayer#renderLayers regenerates the updateTrigger on a `style` swap even within the same zoom bucket (finding 2)', () => {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(5.1)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersBefore = layer.renderLayers() as any[];
  const mvtBefore = layersBefore.find(l => l instanceof MVTLayer);
  const triggerBefore = mvtBefore.props.updateTriggers?.renderSubLayers;

  // A brand-new `style` object, same zoom bucket: simulates what the real lifecycle manager does
  // across a prop update (mirrors the equivalent `review-fixes-i6.node.spec.ts` pattern) — a
  // second `MapLibreStyleLayer` instance, carrying the first instance's `context`/`state`
  // forward, rather than mutating the frozen `props` of an already-initialized layer.
  const newStyle = {...style};
  const layer2 = new MapLibreStyleLayer({
    style: newStyle,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer2 as any).context = (layer as any).context;
  (layer2 as any).internalState = {subLayers: []};
  (layer2 as any).state = (layer as any).state;

  const layersAfter = layer2.renderLayers() as any[];
  const mvtAfter = layersAfter.find(l => l instanceof MVTLayer);
  const triggerAfter = mvtAfter.props.updateTriggers?.renderSubLayers;

  expect(triggerBefore[0]).toBe(triggerAfter[0]); // same zoom bucket
  expect(triggerBefore[1]).not.toBe(triggerAfter[1]); // different style identity
});
