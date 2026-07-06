// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {
  _MapLibreStyleLayer as MapLibreStyleLayer,
  MVTLayer,
  _MercatorCRSTileset2D as MercatorCRSTileset2D
} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// The existing `maplibre-style-layer.spec.ts` composite test only exercises a classic
// `WebMercatorViewport`. Stage 2's own acceptance scenario (the Fathom hybrid case) is a CRS
// `MapView` — this pins that the composite renders correctly there too, following the pattern
// `mvt-layer-crs.spec.ts` already established for the inner `MVTLayer` on its own (a
// Mercator-pyramid vector source, no `tileMatrixSet`, auto-routed through
// `MercatorCRSTileset2D` inside a UTM `MapView`).

const evaluator = {createPropertyExpression, featureFilter};

const style = {
  layers: [
    {id: 'bg', type: 'background', paint: {'background-color': '#e8e8e8'}},
    {
      id: 'water',
      type: 'fill',
      filter: ['==', ['get', 'class'], 'water'],
      paint: {'fill-color': '#a0c8f0'}
    }
  ]
};

test('MapLibreStyleLayer#renders correctly inside a CRS MapView (UTM), inner MVTLayer auto-routes through MercatorCRSTileset2D', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 5}
  })!;

  const testCases = [
    {
      props: {
        style,
        // A classic Mercator-pyramid MVT source (no tileMatrixSet) - the common, motivating
        // shape (Esri's "Ocean Reference" service and most public MVT endpoints), routed
        // through MercatorCRSTileset2D by MVTLayer._getTilesetClass() when viewed from a CRS
        // MapView (Stage 1, item 1b).
        source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
        evaluator
      },
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers.some(l => l.id.endsWith('-bg'))).toBe(true);
        const mvt = subLayers.find(l => l instanceof MVTLayer);
        expect(mvt).toBeTruthy();
        expect(mvt.state.tileset).toBeInstanceOf(MercatorCRSTileset2D);
        expect(mvt.state.binary).toBe(false);
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

// Round 8 (real-integration feedback) finding 1: a `minzoom`-gated style layer (labels, most
// commonly) was silently hidden in a CRS view because the composite evaluated
// `minzoom`/`maxzoom` gating against the raw, extent-relative `viewport.zoom` instead of the
// Mercator-equivalent zoom the style's `minzoom`/`maxzoom` numbers are actually authored against.
test('MapLibreStyleLayer#a minzoom-gated style layer renders in a CRS view at the Mercator-equivalent ground scale (was hidden at the raw CRS zoom)', () => {
  // Same "UTM 18N at lat 40, zoom 7" scenario as the known-answer tests in
  // `style-eval-zoom.node.spec.ts` / `warp-mesh.node.spec.ts`: raw CRS zoom 7, Mercator-equivalent
  // zoom ~12.52. A style layer gated `minzoom: 9` is below the raw zoom's threshold check (7 < 9,
  // would have been hidden by the pre-fix raw-zoom evaluation) but at-or-above the
  // Mercator-equivalent threshold (12.52 >= 9) -- exactly the CRS-view integration trap the fork
  // feedback describes.
  const gatedStyle = {
    layers: [
      {
        id: 'water-label',
        type: 'fill',
        minzoom: 9,
        filter: ['==', ['get', 'class'], 'water'],
        paint: {'fill-color': '#a0c8f0'}
      }
    ]
  };
  const layer = new MapLibreStyleLayer({
    style: gatedStyle,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 7}
  })!;
  (layer as any).context = {viewport};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layers = layer.renderLayers() as any[];
  const mvt = layers.find(l => l instanceof MVTLayer);
  const feature = {
    type: 'Feature',
    properties: {class: 'water', layerName: undefined},
    geometry: {
      type: 'Polygon',
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
  const sublayers = mvt.props.renderSubLayers({id: 'tile-1', data: [feature]});
  expect(sublayers.some((l: any) => l.id.endsWith('water-label'))).toBe(true);
});
