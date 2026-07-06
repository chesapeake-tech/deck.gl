// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global ImageData */
import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// Multi-view mixed-projection audit (docs/superpowers/specs/2026-07-06-crs-multiview-audit.md),
// scenario 2: is `WarpedTileLayer` safe to share across a CRS view and a plain Mercator view?
//
// Initial hypothesis (from reading `renderSubLayers()` alone, warped-tile-layer.ts:155-158,
// which returns `null` when `(this.context.viewport as any).crs` is absent) was that the shared
// layer would silently render nothing, or silently reuse stale CRS-projected sublayers, once
// `context.viewport` (the single mutable slot `layer-manager.ts#activateViewport` sets, shared
// by every view drawing this layer -- see `composite-layer.ts`'s own doc comment: "draw can be
// called without calling updateState ... while renderLayers can only be called during a
// recursive layer update") pointed at the non-CRS view. Probing it directly shows the actual,
// better-than-hypothesized behavior: `MercatorCRSTileset2D.getTileIndices()`
// (mercator-crs-tileset-2d.ts:58-63), called from `TileLayer._updateTileset()` every update
// cycle regardless of whether new tiles are needed, throws an explicit, actionable error --
// `_WarpedTileLayer requires a CRS view — set the crs prop on MapView (use TileLayer in Web
// Mercator views)` -- the moment `context.viewport` lacks `.crs`. `layer-manager.ts`'s
// `_handleError` catches it per-layer (`layer.raiseError()`), so it does not crash the whole
// `Deck` or the other view's other layers; it disables/errors just this one shared layer for
// that update. This is already the "clear failure, not silent corruption" resolution the
// multi-view audit's acceptable-v1 bar asks for -- no fix needed here. (Caveat noted in the
// audit doc: the error is not latched/deduped, so it re-fires on every subsequent update cycle
// for as long as the shared context keeps landing on the non-CRS viewport, e.g. while the user
// is actively panning -- a possible, non-blocking console-noise follow-up.)
test('WarpedTileLayer#throws a clear, actionable error rather than corrupting when shared with a plain Mercator viewport', async () => {
  const crsView = new MapView({crs: UTM18N});
  const crsViewport = crsView.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 7}
  })!;
  const mercatorViewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 7
  });

  const seenErrors: Error[] = [];
  const testCases = [
    {
      title: 'CRS viewport: warps and renders SimpleMeshLayer tiles',
      viewport: crsViewport,
      props: {
        getTileData: () => Promise.resolve(new ImageData(4, 4))
      },
      onAfterUpdate: ({layer, subLayers}: {layer: any; subLayers: any[]}) => {
        if (layer.isLoaded) {
          const meshLayers = subLayers.filter(l => l instanceof SimpleMeshLayer);
          expect(meshLayers.length).toBeGreaterThan(0);
        }
      }
    },
    {
      title:
        'same instance updated/drawn against a plain Mercator viewport (2nd view, or live swap): raises a clear error',
      viewport: mercatorViewport,
      onAfterUpdate: () => {
        expect(seenErrors.length).toBeGreaterThan(0);
        expect(seenErrors[seenErrors.length - 1].message).toContain(
          '_WarpedTileLayer requires a CRS view'
        );
      }
    }
  ];

  await testLayerAsync({
    Layer: WarpedTileLayer,
    viewport: crsViewport,
    testCases,
    onError: err => seenErrors.push(err)
  });

  // Only the expected, actionable "requires a CRS view" error should have fired -- exactly once,
  // for the one testCase that activated the non-CRS viewport.
  expect(seenErrors.length).toBe(1);
  expect(seenErrors[0].message).toContain('_WarpedTileLayer requires a CRS view');
});
