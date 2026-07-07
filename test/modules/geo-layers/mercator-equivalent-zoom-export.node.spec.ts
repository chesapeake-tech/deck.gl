// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {_mercatorEquivalentZoom} from '@deck.gl/geo-layers';
import {mercatorEquivalentZoom} from '@deck.gl/geo-layers/maplibre-style-layer/style-eval-zoom';

// Item 8: `mercatorEquivalentZoom` (style-eval-zoom.ts) was only reachable via the leaf-module
// subpath import (`@deck.gl/geo-layers/maplibre-style-layer/style-eval-zoom`), not the package's
// public barrel -- consumers (e.g. clarity-client) were copy-pasting the formula rather than
// importing it. Exported from the top-level `@deck.gl/geo-layers` entry point as
// `_mercatorEquivalentZoom`, following the module's underscore-experimental convention for
// CRS-view internals (`_CRSTileset2D`, `_WarpedTileLayer`, `_MapLibreStyleLayer`, etc.).
test('_mercatorEquivalentZoom is exported from the @deck.gl/geo-layers package barrel and is the same function as the leaf module export', () => {
  expect(_mercatorEquivalentZoom).toBe(mercatorEquivalentZoom);

  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -74,
    latitude: 40,
    zoom: 7
  });
  // Identity for a real WebMercatorViewport (see style-eval-zoom.node.spec.ts for the full
  // known-answer coverage of the formula itself; this test only pins the export surface).
  expect(_mercatorEquivalentZoom(viewport)).toBeCloseTo(7, 6);
});
