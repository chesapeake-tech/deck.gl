// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {testInitializeLayer} from '@deck.gl/test-utils/vitest';
import CRSViewport from '@deck.gl/core/viewports/crs-viewport';
import SolidPolygonLayer from '@deck.gl/layers/solid-polygon-layer/solid-polygon-layer';
import {UTM18N} from '../core/viewports/crs-fixtures';

// Regression test (review, item 4): `SolidPolygonLayer#initializeState` builds the CRS affine
// tesselation `preproject` ONCE, closing over the then-current view center (see
// `crs-affine-preproject.ts#getPolygonTesselatorPreproject`'s `origin` argument). Before this
// fix, `updateGeometry` never rebuilt it, so a re-tesselation (a `data`/`getPolygon` change)
// that happens after the camera has panned far from where the layer first mounted kept using
// the STALE origin -- increasingly wrong triangulation topology the further the camera moves
// from the original mount position, in a CRS view.
//
// `createCRSAffinePreproject`'s closure returns exactly `[0, 0]` when evaluated at its own
// `origin` (dLng = dLat = 0, see crs-affine-preproject.ts), so evaluating the CURRENT
// polygonTesselator's `preproject` at the CURRENT viewport's center is a direct probe of which
// origin it was built against.

function polygon(lng: number, lat: number, s = 0.001) {
  return {
    polygon: [
      [lng, lat],
      [lng + s, lat],
      [lng + s, lat + s],
      [lng, lat + s],
      [lng, lat]
    ]
  };
}

test('SolidPolygonLayer#CRS view: re-tesselation after a large pan rebuilds preproject with the CURRENT viewport origin', () => {
  const viewport1 = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -75,
    latitude: 40,
    zoom: 12
  });

  const props1 = {
    id: 'polys',
    data: [polygon(-75, 40)],
    getPolygon: (d: any) => d.polygon,
    filled: true,
    coordinateSystem: 'lnglat'
  };
  const layer = new SolidPolygonLayer(props1 as any);
  const {finalize} = testInitializeLayer({
    layer,
    viewport: viewport1,
    finalize: false,
    onError: (err: Error) => expect(err).toBeFalsy()
  });

  try {
    // A large simulated pan -- far enough that the stale (viewport1) origin would put a
    // meaningfully different affine approximation in play at viewport2's center.
    const viewport2 = new CRSViewport({
      crs: UTM18N,
      width: 800,
      height: 600,
      longitude: -70,
      latitude: 35,
      zoom: 12
    });
    (layer as any).context.viewport = viewport2;

    const props2 = {...props1, data: [polygon(-70, 35)]};
    // Directly drives `updateGeometry` (the method under test), sidestepping any ambiguity in
    // how the full `LayerManager`/`testLayer` lifecycle harness batches multiple updateState
    // passes across a viewport change -- exactly mirrors the pattern
    // `maplibre-style-layer-crs.spec.ts`'s minzoom-gating test uses to directly drive a
    // specific method with hand-built parameters.
    (layer as any).updateGeometry({
      props: props2,
      oldProps: props1,
      changeFlags: {dataChanged: 'manual test: pan + re-tesselate'}
    });

    const preproject = (layer.state as any).polygonTesselator.opts.preproject as (
      xy: number[]
    ) => number[];
    // Evaluated at viewport2's own center: a preproject rebuilt against viewport2's origin
    // returns ~[0, 0] there; a STALE preproject (still viewport1's origin) would not.
    const [x, y] = preproject([viewport2.longitude, viewport2.latitude]);
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(Math.abs(y)).toBeLessThan(1e-9);
  } finally {
    finalize();
  }
});

test('SolidPolygonLayer#Mercator view: updateGeometry keeps using projectFlat (byte-identical, no CRS-specific behavior change)', () => {
  const props1 = {
    id: 'polys',
    data: [polygon(-75, 40)],
    getPolygon: (d: any) => d.polygon,
    filled: true,
    coordinateSystem: 'lnglat'
  };
  const layer = new SolidPolygonLayer(props1 as any);
  const {finalize} = testInitializeLayer({
    layer,
    finalize: false,
    onError: (err: Error) => expect(err).toBeFalsy()
  });
  try {
    const viewport = (layer as any).context.viewport;
    const props2 = {...props1, data: [polygon(-75, 40.1)]};
    (layer as any).updateGeometry({
      props: props2,
      oldProps: props1,
      changeFlags: {dataChanged: 'manual test'}
    });
    const preproject = (layer.state as any).polygonTesselator.opts.preproject as (
      xy: number[]
    ) => number[];
    const sample = [-75.2, 40.3];
    expect(preproject(sample)).toEqual(viewport.projectFlat(sample));
  } finally {
    finalize();
  }
});
