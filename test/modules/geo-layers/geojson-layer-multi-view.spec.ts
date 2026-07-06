// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {GeoJsonLayer} from '@deck.gl/layers';
import {UTM18N} from '../core/viewports/crs-fixtures';

// Multi-view mixed-projection audit (docs/superpowers/specs/2026-07-06-crs-multiview-audit.md),
// scenario 4 (baseline): a plain LNGLAT `GeoJsonLayer` shared across a Mercator view and a CRS
// view. Unlike the tile/style layers audited in scenarios 1-3, `GeoJsonLayer`
// (`geojson-layer.ts`) and the plain sublayers it composes (`path-layer.ts`,
// `solid-polygon-layer.ts`, `scatterplot-layer.ts`, ...) never read `this.context.viewport`
// inside `updateState()`/`renderLayers()` to decide *what* geometry/attributes to build --
// projection happens entirely in the `project` shader module at draw time, independently per
// viewport (`layers-pass.ts#_drawLayersInViewport` re-activates the viewport and rebinds
// `project` uniforms for every viewport a frame draws into, regardless of how many share the
// layer). The one `this.context.viewport.resolution` read present in this family
// (`bitmap-layer.ts`, `path-layer.ts`, `solid-polygon-layer.ts` -- a GlobeView-only signal, see
// `mvt-viewport-mode.ts`'s doc comment) is `undefined` for both a `WebMercatorViewport` and a
// `_CRSViewport` alike, so it can't diverge between the two view types audited here either. This
// confirms sharing a plain geometry layer across mixed Mercator/CRS views is fundamentally fine
// by construction -- the hazard audited elsewhere in this suite is specific to layers whose
// *sublayer generation* (not just per-vertex projection) depends on the viewport.
test('GeoJsonLayer#updates cleanly when shared/swapped between a Mercator viewport and a CRS viewport', async () => {
  const mercatorViewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });
  const crsView = new MapView({crs: UTM18N});
  const crsViewport = crsView.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 5}
  })!;

  const data = [
    {type: 'Feature', properties: {}, geometry: {type: 'Point', coordinates: [-72, 40]}},
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-72.1, 40.1],
          [-71.9, 39.9]
        ]
      }
    }
  ];

  const seenErrors: Error[] = [];
  const testCases = [
    {
      title: 'initial: Mercator viewport',
      viewport: mercatorViewport,
      props: {data, pointType: 'circle', getFillColor: [255, 0, 0]},
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers.length).toBeGreaterThan(0);
      }
    },
    {
      title: 'same instance, now drawn/updated against a CRS viewport: no throw, sublayers intact',
      viewport: crsViewport,
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers.length).toBeGreaterThan(0);
      }
    },
    {
      title: 'back to Mercator: still fine',
      viewport: mercatorViewport,
      onAfterUpdate: ({subLayers}: {subLayers: any[]}) => {
        expect(subLayers.length).toBeGreaterThan(0);
      }
    }
  ];

  await testLayerAsync({
    Layer: GeoJsonLayer,
    viewport: mercatorViewport,
    testCases,
    onError: err => seenErrors.push(err)
  });

  expect(seenErrors).toEqual([]);
});
