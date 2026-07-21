// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global document, window */
// CRS (PROJECTION_MODE.CRS) WebGPU smoke test.
//
// Renders the same CRS scene (UTM 18N via proj4) on a WebGL2 and on a WebGPU
// device with ScatterplotLayers in the CRS-relevant coordinate systems
// (LNGLAT, METER_OFFSETS, LNGLAT_OFFSETS). Each marker has a unique color.
// The Playwright driver (run-smoke.mjs) screenshots the canvas, locates each
// marker's pixel centroid and compares it against the CPU projection
// (CRSViewport.project) returned by this page, then cross-compares WebGL vs
// WebGPU centroids.
//
// NOTE pixel readback is done via Playwright screenshot rather than in-page
// canvas2d.drawImage(webgpuCanvas): Chrome returns transparent black when
// drawing a presented WebGPU canvas into a 2D context (the WebGL canvas reads
// back fine), so the composited-page screenshot is the reliable path.
//
// Exposed API (used by run-smoke.mjs):
//   window.__crsSmoke.run('webgl'|'webgpu', {crs?, layerIds?}) -> scene report
//   window.__crsSmoke.hasWebGPU() -> adapter info

import {Deck, MapView, COORDINATE_SYSTEM} from '@deck.gl/core';
import {ScatterplotLayer} from '@deck.gl/layers';
import {webgpuAdapter} from '@luma.gl/webgpu';
import proj4 from 'proj4';

// Same UTM 18N CRSDefinition shape as test/apps/crs-viewport
const utm18n = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');
const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18n.forward(lnglat),
    inverse: xy => utm18n.inverse(xy)
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

const WIDTH = 800;
const HEIGHT = 600;

// Zoom is extent-relative for CRS viewports: zoom 5 under UTM 18N is roughly
// 41 m/px, so the whole scene spans ~33 x 25 km.
const VIEW_STATE = {longitude: -76.6, latitude: 38.9, zoom: 5, pitch: 0, bearing: 0};

const ORIGIN = [-76.6, 38.9, 0];

const MARKERS = {
  red: {color: [255, 0, 0], kind: 'lnglat', position: [-76.47, 38.98]},
  green: {color: [0, 255, 0], kind: 'lnglat', position: [-76.72, 38.83]},
  blue: {color: [0, 0, 255], kind: 'meter-offsets', position: [7000, -6000, 0]},
  yellow: {color: [255, 255, 0], kind: 'lnglat-offsets', position: [-0.06, 0.07, 0]}
};

// UPSTREAM deck.gl 9.3 WebGPU limitation (not CRS-specific — identical failure
// in plain Web Mercator): layers whose coordinate system disables fp64
// (use64bitPositions() === false, e.g. METER_OFFSETS / LNGLAT_OFFSETS) create a
// DataColumn with `fp64: false`, whose buffer layout still declares the
// `instancePositions64Low` shader attribute at byteOffset 12 in a
// stride-12 buffer (invalid pipeline on WebGPU: "Attribute offset (12) + format
// size (12) must be <= the vertex buffer stride (12)"), and whose constant-zero
// 64Low value hits luma.gl's "WebGPU constant attributes not supported".
// Forcing full-fp64 positions produces the valid interleaved hi/lo layout
// (stride 24, offsets 0/12) and lets the CRS offset branches actually execute.
class Fp64ScatterplotLayer extends ScatterplotLayer {
  static layerName = 'Fp64ScatterplotLayer';
  use64bitPositions() {
    return true;
  }
}

function makeLayers() {
  const byKind = kind =>
    Object.entries(MARKERS)
      .filter(([, m]) => m.kind === kind)
      .map(([name, m]) => ({name, ...m}));

  const common = {
    getPosition: d => d.position,
    getFillColor: d => d.color,
    radiusUnits: 'pixels',
    getRadius: 14,
    filled: true,
    stroked: false,
    antialiasing: false
  };

  return [
    new ScatterplotLayer({
      id: 'lnglat',
      data: byKind('lnglat'),
      ...common
    }),
    new Fp64ScatterplotLayer({
      id: 'meter-offsets',
      coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
      coordinateOrigin: ORIGIN,
      data: byKind('meter-offsets'),
      ...common
    }),
    new Fp64ScatterplotLayer({
      id: 'lnglat-offsets',
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT_OFFSETS,
      coordinateOrigin: ORIGIN,
      data: byKind('lnglat-offsets'),
      ...common
    })
  ];
}

/** Ground-truth lnglat of every marker (CPU-side, non-circular w.r.t. the shader) */
function markerLngLat(marker) {
  switch (marker.kind) {
    case 'lnglat':
      return marker.position;
    case 'meter-offsets': {
      // deck METER_OFFSETS semantics: spherical ENU meters (deck's
      // METERS_PER_DEGREE model), converted to degree offsets at the origin.
      // See getCRSMetersJacobian in crs-utils.ts. The lnglat->CRS step is then
      // exact (proj4 inside CRSViewport.project), so only the shader's Jacobian
      // linearization differs.
      const METERS_PER_DEGREE = 4.003e7 / 360; // matches crs-utils.ts
      const dlon = marker.position[0] / (METERS_PER_DEGREE * Math.cos((ORIGIN[1] * Math.PI) / 180));
      const dlat = marker.position[1] / METERS_PER_DEGREE;
      return [ORIGIN[0] + dlon, ORIGIN[1] + dlat];
    }
    case 'lnglat-offsets':
      // Degree offsets are literal: origin + delta, exactly
      return [ORIGIN[0] + marker.position[0], ORIGIN[1] + marker.position[1]];
    default:
      throw new Error(marker.kind);
  }
}

function waitFrames(n) {
  return new Promise(resolve => {
    const step = k => (k <= 0 ? resolve() : window.requestAnimationFrame(() => step(k - 1)));
    step(n);
  });
}

let currentDeck = null;

async function runCase(type, options = {}) {
  const {crs = true, layerIds = null} = options;
  const errors = [];

  // Tear down the previous run so the screenshot region is unambiguous
  if (currentDeck) {
    currentDeck.finalize();
    currentDeck = null;
  }
  for (const old of Array.from(document.querySelectorAll('canvas'))) {
    old.remove();
  }

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.cssText = `position:absolute;left:0;top:0;width:${WIDTH}px;height:${HEIGHT}px;`;
  document.body.appendChild(canvas);

  const deviceProps =
    type === 'webgpu' ? {type: 'webgpu', adapters: [webgpuAdapter]} : {type: 'webgl'};

  let renderCount = 0;
  const deck = new Deck({
    canvas,
    width: WIDTH,
    height: HEIGHT,
    useDevicePixels: false,
    // `crs: false` renders the identical scene in plain Web Mercator — a
    // control case to tell CRS-specific failures apart from general
    // deck-on-WebGPU issues (zoom adjusted to a similar meters-per-pixel).
    views: crs ? new MapView({crs: UTM18N}) : new MapView(),
    viewState: crs ? VIEW_STATE : {...VIEW_STATE, zoom: 12.7},
    controller: false,
    layers: makeLayers().filter(l => !layerIds || layerIds.includes(l.id)),
    deviceProps,
    onError: error => errors.push(`${error && (error.stack || error.message || error)}`),
    onAfterRender: () => renderCount++
  });
  currentDeck = deck;

  // Wait for async device creation + first renders
  const t0 = Date.now();
  while (renderCount < 2 && Date.now() - t0 < 15000 && errors.length === 0) {
    // eslint-disable-next-line no-await-in-loop
    await waitFrames(1);
  }
  // Let the last frame present before the driver screenshots
  await waitFrames(2);

  const device = deck.device;
  const deviceInfo = device
    ? {type: device.type, vendor: device.info.vendor, renderer: device.info.renderer}
    : null;

  const result = {type, crs, deviceInfo, errors, renderCount, markers: {}};

  if (renderCount >= 2) {
    const viewport = deck.getViewports()[0];
    for (const [name, marker] of Object.entries(MARKERS)) {
      const expected = viewport.project(markerLngLat(marker));
      result.markers[name] = {
        kind: marker.kind,
        color: marker.color,
        expected: [expected[0], expected[1]]
      };
    }
  }
  return result;
}

const status = document.getElementById('status');
window.__crsSmoke = {
  run: async (type, options) => {
    try {
      const result = await runCase(type, options);
      status.textContent = `last run: ${type} errors=${result.errors.length}`;
      return result;
    } catch (error) {
      return {type, fatal: `${error.stack || error}`};
    }
  },
  hasWebGPU: async () => {
    if (!window.navigator.gpu) {
      return {available: false};
    }
    const adapter = await window.navigator.gpu.requestAdapter();
    const info = adapter && adapter.info;
    return {
      available: Boolean(adapter),
      vendor: info && info.vendor,
      architecture: info && info.architecture,
      description: info && info.description
    };
  }
};
status.textContent = 'ready';
