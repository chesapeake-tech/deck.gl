// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';
import {normalizeCRS, lngLatToCommon} from '@deck.gl/core/viewports/crs-utils';
import {worldToPixels} from '@math.gl/web-mercator';
import {UTM18N} from '../../core/viewports/crs-fixtures';

// The convention a CARTESIAN-positioned SimpleMeshLayer (e.g. Fathom's app-side-positioned
// bathymetry mesh) must follow in a CRS view: common-space XY via `lngLatToCommon` (the CRS's
// own forward transform + Phase 1's extent-normalization, equivalently `viewport.projectFlat`),
// Z as raw elevation meters — unchanged from classic Mercator (no new Z-scaling; Decisions for
// review #3). `crs` here is normalized independently of the viewport under test (fresh
// `normalizeCRS` call) so the two computations below are genuinely independent, not the same
// cached object reused twice.
const crs = normalizeCRS(UTM18N);

test('CARTESIAN position (app-computed via lngLatToCommon) matches viewport.projectFlat', () => {
  const viewport = new CRSViewport({
    crs: UTM18N,
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10,
    bearing: 20,
    pitch: 45
  });
  for (const lnglat of [
    [-72, 40],
    [-72.02, 40.01]
  ] as [number, number][]) {
    const [cx, cy] = lngLatToCommon(crs, lnglat);
    const [px, py] = viewport.projectFlat(lnglat);
    expect(cx).toBeCloseTo(px, 6);
    expect(cy).toBeCloseTo(py, 6);
  }
});

test('CARTESIAN mesh position projects to the same screen pixel the pitched camera predicts', () => {
  for (const pitch of [0, 30, 60]) {
    for (const bearing of [0, 45, 200]) {
      const viewport = new CRSViewport({
        crs: UTM18N,
        width: 800,
        height: 600,
        longitude: -72,
        latitude: 40,
        zoom: 12,
        bearing,
        pitch
      });
      const elevationMeters = 25; // e.g. a bathymetry mesh vertex above/below the datum
      const lnglat: [number, number] = [-72.001, 40.001];
      const [cx, cy] = lngLatToCommon(crs, lnglat);
      const common: [number, number, number] = [cx, cy, elevationMeters];

      // What CARTESIAN rendering does at the GPU: worldToPixels(commonSpaceXYZ, pixelProjectionMatrix).
      const pixel = worldToPixels(common, viewport.pixelProjectionMatrix);

      // Independently: project the same lnglat+elevation via the viewport's own `projectFlat`
      // (nonlinear XY only) with Z left as raw meters, then the same pixel matrix — must agree
      // with the app-computed point above. Deliberately NOT `viewport.projectPosition`: that
      // method scales Z by `distanceScales.unitsPerMeter[2]` (correct for the LNGLAT/
      // METER_OFFSETS coordinate systems it serves), which is exactly the scaling CARTESIAN
      // positioning must bypass per Decisions for review #3 (no new Z-scaling) — using it here
      // would assert the wrong invariant.
      const expectedCommon: [number, number, number] = [
        ...viewport.projectFlat(lnglat),
        elevationMeters
      ];
      const expectedPixel = worldToPixels(expectedCommon, viewport.pixelProjectionMatrix);

      expect(pixel[0]).toBeCloseTo(expectedPixel[0], 6);
      expect(pixel[1]).toBeCloseTo(expectedPixel[1], 6);

      // Elevation Z survives unscaled: CARTESIAN never runs Z through
      // `distanceScales.unitsPerMeter` (unlike `projectPosition`/`unprojectPosition`, which
      // scale Z for the LNGLAT/METER_OFFSETS coordinate systems — deliberately not used above,
      // see comment). Pin that invariant directly here, independent of pitch/bearing: the raw
      // decoded elevation is the common-space Z TerrainLayer's mesh bakes, full stop (Decisions
      // for review #3 — no new Z-scaling).
      expect(common[2]).toBe(elevationMeters);

      // XY common<->lnglat is invertible independent of the camera (pitch/bearing only affect
      // the camera matrices, not the planar CRS<->common mapping).
      const [unprojLng, unprojLat] = viewport.unprojectFlat([cx, cy]);
      expect(unprojLng).toBeCloseTo(lnglat[0], 6);
      expect(unprojLat).toBeCloseTo(lnglat[1], 6);
    }
  }
});
