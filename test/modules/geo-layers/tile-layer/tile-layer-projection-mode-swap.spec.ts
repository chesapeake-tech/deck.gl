// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {
  MVTLayer,
  _Tileset2D as Tileset2D,
  _MercatorCRSTileset2D as MercatorCRSTileset2D
} from '@deck.gl/geo-layers';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// Reviewer-triaged fast-follow (separate from the _MapLibreStyleLayer review-fix round):
// TileLayer.updateState (tile-layer.ts) only invalidates its cached `tileset` when
// `tileMatrixSet` changes (deepEqual check) — but MVTLayer._getTilesetClass() (mvt-layer.ts)
// ALSO depends on `this.context.viewport.projectionMode` (selecting MercatorCRSTileset2D for a
// CRS view vs. the default Tileset2D for classic Mercator, when no tileMatrixSet is set). A live
// view swap on the same layer instance (e.g. a UI toggle between a CRS MapView and a classic
// Mercator MapView, both driving the same MVTLayer) changes what _getTilesetClass() would
// return without ever changing tileMatrixSet identity, so the stale tileset (built for the old
// projection) was kept and reused via tileset.setOptions() — which either mis-indexes tiles or
// throws downstream (found while writing the Stage 2 acceptance-scenario verification app; see
// task-e1s2-report.md's "Concerns/follow-ups").

test('MVTLayer#surviving a CRS -> Mercator viewport change re-creates its tileset (correct class), no throw', async () => {
  const view = new MapView({crs: UTM18N});
  const crsViewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 5}
  })!;
  const mercatorViewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 5
  });

  const seenErrors: Error[] = [];
  let firstTileset: unknown = null;

  const testCases = [
    {
      title: 'initial CRS view: routes through MercatorCRSTileset2D',
      props: {
        data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'
      },
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.tileset).toBeInstanceOf(MercatorCRSTileset2D);
        firstTileset = layer.state.tileset;
      }
    },
    {
      title: 'live-swapped to a classic Mercator view: must recreate as the default Tileset2D',
      viewport: mercatorViewport,
      onAfterUpdate: ({layer}: {layer: any}) => {
        expect(layer.state.tileset).toBeInstanceOf(Tileset2D);
        expect(layer.state.tileset).not.toBeInstanceOf(MercatorCRSTileset2D);
        expect(layer.state.tileset).not.toBe(firstTileset);
      }
    }
  ];

  await testLayerAsync({
    Layer: MVTLayer,
    viewport: crsViewport,
    testCases,
    onError: err => seenErrors.push(err)
  });

  expect(seenErrors).toEqual([]);
});
