// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global ImageData */
import {MapView} from '@deck.gl/core';
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {Proj4Projection} from '@math.gl/proj4';

// Render tests must not add runtime dependencies. `@math.gl/proj4` is already a
// devDependency exercised by the non-render CRS tests (see
// test/modules/core/viewports/crs-fixtures.ts and
// test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts) - it is test-only
// and never bundled into a published deck.gl package.
const utm18nProjection = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});

const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18nProjection.project(lnglat),
    inverse: xy => utm18nProjection.unproject(xy)
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

const VIEW_STATE = {
  longitude: -72,
  latitude: 40,
  zoom: 7,
  pitch: 0,
  bearing: 0
};

const TILE_SIZE = 256;
const CELL_SIZE = 32;

// Deterministic, offline tile source: synthesizes a high-contrast checkerboard
// ImageData per tile instead of fetching from a URL, so the warp/mesh path can be
// exercised without any network access. Colors are derived from the tile index alone
// (no randomness), and no text is drawn - the golden-image render tests on this branch
// deliberately avoid TextLayer/text rendering, since font rasterization differs across
// machines/OSes (see the pre-existing `geojson-text*` golden mismatches on this machine).
function makeCheckerboardTileData({index}) {
  const {x, y, z} = index;
  const size = TILE_SIZE;
  const data = new Uint8ClampedArray(size * size * 4);
  // Two saturated colors per tile, chosen by index parity, so adjacent tiles are
  // visually distinguishable in the warped mosaic
  const even = (x + y + z) % 2 === 0;
  const colorA = even ? [220, 40, 40] : [40, 90, 220];
  const colorB = even ? [255, 150, 60] : [90, 200, 255];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const i = (py * size + px) * 4;
      const isA = (Math.floor(px / CELL_SIZE) + Math.floor(py / CELL_SIZE)) % 2 === 0;
      const color = isA ? colorA : colorB;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return new ImageData(data, size, size);
}

export default [
  {
    // _WarpedTileLayer inside a projected-CRS (UTM 18N) MapView, with an offline
    // synthetic tile source (no network) - exercises the warp-mesh/reprojection path
    // that reprojects a Web-Mercator XYZ raster pyramid onto a non-Mercator CRS view.
    name: 'crs-warped-raster',
    views: new MapView({crs: UTM18N}),
    viewState: VIEW_STATE,
    layers: [
      new WarpedTileLayer({
        id: 'crs-warped-raster',
        tileSize: TILE_SIZE,
        // Let the layer pick its own (deep) source zoom to match this view's ground
        // resolution - clamping maxZoom too low here would force it to render a small,
        // heavily zoomed-in slice of a single checkerboard cell rather than a mosaic.
        maxZoom: 19,
        getTileData: makeCheckerboardTileData
      })
    ],
    goldenImage: './test/render/golden-images/crs-warped-raster.png'
  }
];
