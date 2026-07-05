// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {MapView} from '@deck.gl/core';
import {GeoJsonLayer, PathLayer, ScatterplotLayer} from '@deck.gl/layers';
import {Proj4Projection} from '@math.gl/proj4';

// Render tests must not add runtime dependencies. `@math.gl/proj4` is already a
// devDependency exercised by the non-render CRS tests (see
// test/modules/core/viewports/crs-fixtures.ts and
// test/modules/geo-layers/warped-tile-layer/warped-tile-layer.spec.ts) - it is test-only
// and never bundled into a published deck.gl package, so reusing it here for a real
// UTM 18N transform does not violate that constraint.
const utm18nProjection = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});

// UTM zone 18N: a concrete, non-identity CRS whose forward/inverse transform has a
// genuinely curved Jacobian across the zone, exercising PROJECTION_MODE.CRS's linear +
// quadratic (Hessian) shader correction. This is unlike 'EPSG:4326' (case
// `crs-4326-vectors` below), whose transform is a literal lnglat pass-through - identity
// Jacobian, zero Hessian everywhere - so it alone would not exercise the curved-CRS math.
const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18nProjection.project(lnglat),
    inverse: xy => utm18nProjection.unproject(xy)
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

// Zoom is extent-relative (see docs/api-reference/core/crs-viewport.md#zoom-is-extent-relative):
// UTM 18N's extent is a single ~670km-wide zone, so the same lnglat scene needs a much
// smaller zoom number there than under 'EPSG:4326' (whose extent is the whole globe) to
// land on the same screen framing. Both values below were picked so the ~8x6 degree scene
// fills most of the 800x450 canvas.
const UTM_VIEW_STATE = {
  longitude: -72,
  latitude: 40,
  zoom: -0.7,
  pitch: 0,
  bearing: 0
};

const EPSG4326_VIEW_STATE = {
  longitude: -72,
  latitude: 40,
  zoom: 5.1,
  pitch: 0,
  bearing: 0
};

// A solid, high-contrast polygon - avoids thin/antialiased edges that are sensitive to
// GPU rasterization differences across machines. Deliberately offset from the
// graticule's grid lines below (which fall on even lng/lat) so the polygon's stroke
// never sits exactly on top of a graticule line - coincident geometry from two
// different layers is a render-order/z-fighting risk that could differ across GPUs.
const POLYGON = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-77, 36],
        [-69, 36],
        [-69, 44],
        [-77, 44],
        [-77, 36]
      ]
    ]
  }
};

// A lnglat graticule (meridians + parallels), rendered as thick lines, to make the CRS's
// projection curvature visible without relying on text
function makeGraticule() {
  const paths = [];
  for (let lng = -80; lng <= -66; lng += 2) {
    paths.push({path: Array.from({length: 21}, (_, i) => [lng, 35 + i * 0.5])});
  }
  for (let lat = 35; lat <= 45; lat += 2) {
    paths.push({path: Array.from({length: 29}, (_, i) => [-80 + i * 0.5, lat])});
  }
  return paths;
}

const GRATICULE = makeGraticule();

const POINTS = [
  {position: [-75, 41.5], color: [255, 0, 0]},
  {position: [-71.5, 40.5], color: [0, 200, 0]},
  {position: [-73.5, 37.5], color: [255, 200, 0]}
];

function makeCrsSceneLayers(idPrefix) {
  return [
    new GeoJsonLayer({
      id: `${idPrefix}-polygon`,
      data: POLYGON,
      stroked: true,
      filled: true,
      getFillColor: [0, 120, 255, 200],
      getLineColor: [0, 0, 0],
      lineWidthMinPixels: 3
    }),
    new PathLayer({
      id: `${idPrefix}-graticule`,
      data: GRATICULE,
      getPath: d => d.path,
      getColor: [255, 255, 255],
      widthMinPixels: 3
    }),
    new ScatterplotLayer({
      id: `${idPrefix}-points`,
      data: POINTS,
      getPosition: d => d.position,
      getFillColor: d => d.color,
      getRadius: 20000,
      radiusMinPixels: 10,
      stroked: true,
      getLineColor: [0, 0, 0],
      lineWidthMinPixels: 2
    })
  ];
}

export default [
  {
    // Vector layers (polygon fill, thick path graticule, points) rendered in a real
    // projected CRS (UTM 18N) via a MapView `crs` prop - exercises PROJECTION_MODE.CRS
    // with a non-identity Jacobian + Hessian (see UTM18N comment above).
    name: 'crs-utm-vectors',
    views: new MapView({crs: UTM18N}),
    viewState: UTM_VIEW_STATE,
    layers: makeCrsSceneLayers('crs-utm-vectors'),
    goldenImage: './test/render/golden-images/crs-utm-vectors.png'
  },
  {
    // Same scene under the built-in 'EPSG:4326' CRS - a baseline/contrast case: this
    // transform is an identity pass-through (no curvature), so this checks the CRS
    // viewport's plumbing without exercising the Jacobian/Hessian correction.
    name: 'crs-4326-vectors',
    views: new MapView({crs: 'EPSG:4326'}),
    viewState: EPSG4326_VIEW_STATE,
    layers: makeCrsSceneLayers('crs-4326-vectors'),
    goldenImage: './test/render/golden-images/crs-4326-vectors.png'
  },
  {
    // Same UTM 18N scene as `crs-utm-vectors`, tilted and rotated - verifies the CRS
    // viewport's view/projection matrices (not just the ground-plane projection) under
    // bearing + pitch.
    name: 'crs-utm-bearing-pitch',
    views: new MapView({crs: UTM18N}),
    viewState: {...UTM_VIEW_STATE, bearing: 30, pitch: 40},
    layers: makeCrsSceneLayers('crs-utm-bearing-pitch'),
    goldenImage: './test/render/golden-images/crs-utm-bearing-pitch.png'
  }
];
