// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayer} from '@deck.gl/test-utils/vitest';
import {GridLayer, HexagonLayer, ContourLayer} from '@deck.gl/aggregation-layers';
import {UTM18N} from '../core/viewports/crs-fixtures';

// A handful of points within UTM 18N's WGS84 extent ([-78, 0, -72, 84]), clustered near
// Philadelphia/New York so their centroid is well inside the zone.
const SAMPLE_DATA = [
  {COORDINATES: [-75.16, 39.95]},
  {COORDINATES: [-74.0, 40.71]},
  {COORDINATES: [-75.6, 39.9]}
];
const getPosition = (d: {COORDINATES: [number, number]}) => d.COORDINATES;

function makeCRSViewport() {
  const view = new MapView({crs: UTM18N});
  return view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -75.6, latitude: 39.9, zoom: 6}
  })!;
}

// Pins a pre-existing bug: `_updateBinOptions` (grid-layer.ts/hexagon-layer.ts/
// contour-layer.ts) reconstructs a fresh "data-centroid" viewport of the same
// `viewport.constructor` for the GPU aggregator's project module, via
// `new ViewportType({longitude, latitude, zoom: 12})` whenever `viewport.isGeospatial`.
// For a plain WebMercatorViewport/GlobeViewport that 3-key options object is enough, but
// `_CRSViewport`'s constructor requires `crs` and throws without it (`normalizeCRS`
// destructures `opts.crs`), so every CRS-view GridLayer/HexagonLayer/ContourLayer with
// finite data bounds crashed on first update.
test('GridLayer#renders (does not throw) in a CRS view', () => {
  const viewport = makeCRSViewport();
  testLayer({
    Layer: GridLayer,
    viewport,
    onError: err => expect(err).toBeFalsy(),
    testCases: [
      {
        props: {data: SAMPLE_DATA, getPosition},
        onAfterUpdate({layer}: any) {
          expect(layer.state.aggregator).toBeTruthy();
          expect(Number.isFinite(layer.state.binIdRange?.[0]?.[0])).toBe(true);
        }
      }
    ]
  });
});

test('HexagonLayer#renders (does not throw) in a CRS view', () => {
  const viewport = makeCRSViewport();
  testLayer({
    Layer: HexagonLayer,
    viewport,
    onError: err => expect(err).toBeFalsy(),
    testCases: [
      {
        props: {data: SAMPLE_DATA, getPosition},
        onAfterUpdate({layer}: any) {
          expect(layer.state.aggregator).toBeTruthy();
          expect(Number.isFinite(layer.state.binIdRange?.[0]?.[0])).toBe(true);
        }
      }
    ]
  });
});

test('ContourLayer#renders (does not throw) in a CRS view', () => {
  const viewport = makeCRSViewport();
  testLayer({
    Layer: ContourLayer,
    viewport,
    onError: err => expect(err).toBeFalsy(),
    testCases: [
      {
        props: {
          data: SAMPLE_DATA,
          getPosition,
          contours: [{threshold: 1, color: [255, 0, 0]}]
        },
        onAfterUpdate({layer}: any) {
          expect(Number.isFinite(layer.state.binIdRange?.[0]?.[0])).toBe(true);
        }
      }
    ]
  });
});
