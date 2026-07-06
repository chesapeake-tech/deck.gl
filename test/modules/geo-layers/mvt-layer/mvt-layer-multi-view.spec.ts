// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {MVTLayer} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// Multi-view mixed-projection audit (docs/superpowers/specs/2026-07-06-crs-multiview-audit.md),
// scenario 1: a shared MVTLayer instance drawn across a Mercator view and a CRS view.
//
// `MVTLayer.initializeState()` derives `state.binary` from
// `usesFeatureRoute(this.context.viewport)` exactly ONCE, at layer creation --
// `mvt-viewport-mode.ts`'s own doc comment explains why: "GlobeView/CRS views don't work well
// with binary data". `updateState()` never revisits it. `context.viewport` is a single mutable
// slot on the shared `LayerContext` (`layer-manager.ts#activateViewport`) that reflects whichever
// viewport `deckRenderer` last activated -- for a layer instance that is part of more than one
// `View` (either literally shared across two `views` in one `Deck`, against the guidance already
// in docs/developer-guide/views.md#rendering-layers-in-multiple-views, or a single view whose
// `crs` is swapped live), that slot does not durably describe "the" view the layer belongs to.
// If the layer happens to *initialize* while `context.viewport` is a plain Mercator viewport
// (`binary` stays `true`, the default) and is later updated/drawn while serving a CRS view, tile
// requests keep asking for `shape: 'binary'` while `getTileData` independently asks for
// `coordinates: 'wgs84'` (also keyed off `context.viewport`, but read at a different call site
// and potentially a different point in time) -- exactly the combination the code's own comment
// says doesn't work.
test('MVTLayer#state.binary tracks projection mode across updates, not just at init', async () => {
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

  const testCases = [
    {
      title: 'initializes under a plain Mercator viewport: binary stays true (default)',
      viewport: mercatorViewport,
      props: {
        data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'
      },
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.binary).toBe(true);
      }
    },
    {
      title:
        'same instance now updated/drawn against a CRS viewport (live swap, or a second view sharing it): binary must flip to false',
      viewport: crsViewport,
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.binary).toBe(false);
      }
    },
    {
      title: 'swapping back to Mercator restores the prop default',
      viewport: mercatorViewport,
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.binary).toBe(true);
      }
    }
  ];

  const seenErrors: Error[] = [];
  await testLayerAsync({
    Layer: MVTLayer,
    viewport: mercatorViewport,
    testCases,
    onError: err => seenErrors.push(err)
  });

  expect(seenErrors).toEqual([]);
});
