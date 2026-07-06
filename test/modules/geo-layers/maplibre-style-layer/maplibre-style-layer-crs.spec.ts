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
