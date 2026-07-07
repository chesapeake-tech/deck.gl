// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {clamp} from '@math.gl/core';
import {lngLatToWorld as _lngLatToWorld, worldToLngLat} from '@math.gl/web-mercator';
import {MapController, WebMercatorViewport, _CRSViewport as CRSViewport} from '@deck.gl/core';
import {resolveNonFiniteAxis} from '@deck.gl/core/controllers/map-controller';
import {UTM18N} from '../viewports/crs-fixtures';

const MapState = new MapController({} as any).ControllerState;

// A self-contained re-implementation of the pre-D1 Web Mercator maxBounds/zoom-fit math
// (independent of modules/core/src/controllers/map-controller.ts), used below as the
// "golden" reference to pin that D1's viewport delegation left the Mercator path
// byte-identical.
function refLngLatToWorld([lng, lat]: number[]): [number, number] {
  if (Math.abs(lat) > 90) {
    lat = Math.sign(lat) * 90;
  }
  if (Number.isFinite(lng)) {
    const [x, y] = _lngLatToWorld([lng, lat]);
    return [x, clamp(y, 0, 512)];
  }
  const [, y] = _lngLatToWorld([0, lat]);
  return [lng, clamp(y, 0, 512)];
}

function mod(value: number, divisor: number): number {
  const modulus = value % divisor;
  return modulus < 0 ? divisor + modulus : modulus;
}

function refConstrain(props: {
  width: number;
  height: number;
  longitude: number;
  latitude: number;
  zoom: number;
  maxZoom: number;
  minZoom: number;
  maxBounds: [[number, number], [number, number]] | null;
  normalize?: boolean;
}) {
  let {zoom, longitude} = props;
  let minZoom = props.minZoom;
  const {maxZoom, maxBounds, width, height, normalize = true} = props;

  // Mirrors applyConstraints' longitude-wrap step, which runs before the maxBounds clamp.
  if (normalize && (longitude < -180 || longitude > 180)) {
    longitude = mod(longitude + 180, 360) - 180;
  }

  if (maxBounds !== null && width > 0 && height > 0) {
    const bl = refLngLatToWorld(maxBounds[0]);
    const tr = refLngLatToWorld(maxBounds[1]);
    const w = tr[0] - bl[0];
    const h = tr[1] - bl[1];
    if (Number.isFinite(w) && w > 0) minZoom = Math.max(minZoom, Math.log2(width / w));
    if (Number.isFinite(h) && h > 0) minZoom = Math.max(minZoom, Math.log2(height / h));
    if (minZoom > maxZoom) minZoom = maxZoom;
  }
  zoom = clamp(zoom, minZoom, maxZoom);

  let {latitude} = props;
  if (maxBounds) {
    const bl = refLngLatToWorld(maxBounds[0]);
    const tr = refLngLatToWorld(maxBounds[1]);
    const scale = 2 ** zoom;
    const halfWidth = width / 2 / scale;
    const halfHeight = height / 2 / scale;
    const [minLng, minLat] = worldToLngLat([bl[0] + halfWidth, bl[1] + halfHeight]);
    const [maxLng, maxLat] = worldToLngLat([tr[0] - halfWidth, tr[1] - halfHeight]);
    longitude = clamp(longitude, minLng, maxLng);
    latitude = clamp(latitude, minLat, maxLat);
  }
  return {zoom, longitude, latitude};
}

const mercatorMakeViewport = (props: any) => new WebMercatorViewport(props);

test('D1 Mercator byte-identity — default whole-world maxBounds', () => {
  const scenarios = [
    {width: 800, height: 600, longitude: -182, latitude: 36, zoom: 0, bearing: 180},
    {width: 1280, height: 720, longitude: -122, latitude: 38, zoom: 10, bearing: -45, pitch: 30},
    {width: 800, height: 600, longitude: 0, latitude: 89.999, zoom: -3},
    {width: 800, height: 600, longitude: 0, latitude: -89.999, zoom: 25}
  ];

  for (const scenario of scenarios) {
    const viewState = new MapState({...scenario, makeViewport: mercatorMakeViewport});
    const actual = viewState.getViewportProps();
    const expected = refConstrain({
      width: scenario.width,
      height: scenario.height,
      longitude: scenario.longitude,
      latitude: scenario.latitude,
      zoom: scenario.zoom,
      maxZoom: 20,
      minZoom: 0,
      maxBounds: [
        [-Infinity, -90],
        [Infinity, 90]
      ]
    });
    expect(actual.zoom, `zoom byte-identical for ${JSON.stringify(scenario)}`).toBe(expected.zoom);
    expect(actual.longitude, `longitude byte-identical for ${JSON.stringify(scenario)}`).toBe(
      expected.longitude
    );
    expect(actual.latitude, `latitude byte-identical for ${JSON.stringify(scenario)}`).toBe(
      expected.latitude
    );
  }
});

test('D1 Mercator byte-identity — explicit finite maxBounds', () => {
  const props = {
    width: 800,
    height: 600,
    longitude: 0,
    latitude: 0,
    zoom: 0,
    bearing: 120,
    maxBounds: [
      [-5, 45],
      [5, 55]
    ] as [[number, number], [number, number]]
  };
  const viewState = new MapState({...props, makeViewport: mercatorMakeViewport});
  const actual = viewState.getViewportProps();
  const expected = refConstrain({...props, maxZoom: 20, minZoom: 0});
  expect(actual.zoom).toBe(expected.zoom);
  expect(actual.longitude).toBe(expected.longitude);
  expect(actual.latitude).toBe(expected.latitude);
});

test('D1 Mercator byte-identity — normalize:false skips maxBounds entirely', () => {
  const viewState = new MapState({
    width: 800,
    height: 600,
    longitude: -182,
    latitude: 36,
    zoom: 0,
    bearing: 180,
    normalize: false,
    makeViewport: mercatorMakeViewport
  });
  const props = viewState.getViewportProps();
  // normalize:false => maxBounds defaults to null (MapState's own constructor logic,
  // unchanged) => zoom is only clamped to [minZoom, maxZoom], not world-fit.
  expect(props.zoom).toBe(0);
  expect(props.longitude).toBe(-182);
  expect(props.latitude).toBe(36);
});

// --- CRS: the trial's zoom-out "map disappears" bug scenario -------------------------

const crsMakeViewport = (props: any) => new CRSViewport({...props, crs: UTM18N});

test('D1 CRS zoom-out clamps to extent-fit, not the Mercator equator snap', () => {
  // Mirrors the clarity-client trial repro: 1280x720 viewport, UTM 18N, view centered
  // well north of the equator. Pre-D1, the *default* Web-Mercator maxBounds forced the
  // zoom floor to log2(720/512) (~0.492, the Mercator world's fixed height) and the
  // latitude clamp collapsed to 0 (Mercator's y=0 == the equator), snapping the view
  // off-screen from the actual UTM data. Post-D1, both should be computed from the
  // CRS's own extent instead.
  const width = 1280;
  const height = 720;
  const mercatorEquatorSnapZoom = Math.log2(height / 512); // ~0.4919 - the pre-D1 bug value

  for (const requestedZoom of [0, -2, -5, -10]) {
    const viewState = new MapState({
      width,
      height,
      longitude: -72,
      latitude: 40,
      zoom: requestedZoom,
      makeViewport: crsMakeViewport
    });
    const props = viewState.getViewportProps();

    // Not frozen at the Mercator-world-height floor.
    expect(props.zoom).not.toBeCloseTo(mercatorEquatorSnapZoom, 2);
    // The correct floor is derived from the CRS's own extent width (which always maps
    // to the 512-unit common-space world, independent of the CRS's shape) fit to the
    // viewport width.
    expect(props.zoom).toBeCloseTo(Math.log2(width / 512), 10);
    // No equator snap: the view center's latitude stays at the requested 40 degrees,
    // nowhere near the Mercator-style collapse toward 0.
    expect(props.latitude).toBe(40);
    // Longitude is pinned to the zone's central meridian once the floor makes the
    // whole extent width exactly fill the viewport (not left as some Mercator-derived
    // artifact).
    expect(props.longitude).toBeCloseTo(-75, 6);
  }
});

test('D1 CRS zoom-out: view center and moderate zoom-out are unconstrained by the default bounds', () => {
  // At a zoom where the CRS extent is much larger than the viewport, the default
  // whole-world-equivalent maxBounds should not constrain the view at all (matching
  // Web Mercator's "default bounds rarely bind" behavior away from the extremes).
  const viewState = new MapState({
    width: 1280,
    height: 720,
    longitude: -72,
    latitude: 40,
    zoom: 5,
    makeViewport: crsMakeViewport
  });
  const props = viewState.getViewportProps();
  expect(props.zoom).toBe(5);
  expect(props.longitude).toBe(-72);
  expect(props.latitude).toBe(40);
});

test('D1 CRS normalize:false still opts out of constraints entirely', () => {
  // zoom 0.5 is comfortably within [minZoom, maxZoom] = [0, 20], but below the
  // extent-fit floor (~1.32, per the scenario above) that the default maxBounds would
  // otherwise impose - so this only stays at 0.5 if normalize:false really does skip
  // the maxBounds/zoom-fit clamp (not just the separate min/maxZoom clamp).
  const viewState = new MapState({
    width: 1280,
    height: 720,
    longitude: -72,
    latitude: 40,
    zoom: 0.5,
    normalize: false,
    makeViewport: crsMakeViewport
  });
  const props = viewState.getViewportProps();
  expect(props.zoom).toBe(0.5);
  expect(props.longitude).toBe(-72);
  expect(props.latitude).toBe(40);
});

// --- CRS: maxBounds known-answer (UTM 18N) --------------------------------------------

test('D1 CRS maxBounds — known-answer region clamp in UTM 18N', () => {
  const width = 800;
  const height = 600;
  const maxBounds: [[number, number], [number, number]] = [
    [-73, 39],
    [-71, 41]
  ];

  // Independent reference: project the corners directly through CRSViewport's own
  // exact transform - a different code path than the controller's internal
  // `projectMaxBoundsCorner` - used here purely as ground truth. [-71, 41] falls
  // slightly outside UTM 18N's own extent (it's clamped into the zone, same as the
  // controller does via `clampLngLatToDomain`, mirrored here explicitly).
  const refViewport = new CRSViewport({width, height, crs: UTM18N, longitude: -72, latitude: 40});
  const bl = refViewport.projectFlat(refViewport.clampLngLatToDomain(maxBounds[0]));
  const tr = refViewport.projectFlat(refViewport.clampLngLatToDomain(maxBounds[1]));
  const w = tr[0] - bl[0];
  const h = tr[1] - bl[1];
  const expectedMinZoom = Math.max(Math.log2(width / w), Math.log2(height / h));

  const viewState = new MapState({
    width,
    height,
    longitude: -72,
    latitude: 40,
    zoom: -5, // far below expectedMinZoom - should be floored
    maxBounds,
    makeViewport: crsMakeViewport
  });
  const props = viewState.getViewportProps();

  expect(props.zoom).toBeCloseTo(expectedMinZoom, 6);
  // At the floored zoom the AABB fit pins the center very close to the requested
  // [-72, 40] (which is near the bounds' own center).
  expect(props.longitude).toBeCloseTo(-72, 1);
  expect(props.latitude).toBeCloseTo(40, 1);

  // A request comfortably within the bounds at a reasonable zoom is left untouched.
  const insideViewState = new MapState({
    width,
    height,
    longitude: -72,
    latitude: 40,
    zoom: 10,
    maxBounds,
    makeViewport: crsMakeViewport
  });
  const insideProps = insideViewState.getViewportProps();
  expect(insideProps.zoom).toBe(10);
  expect(insideProps.longitude).toBe(-72);
  expect(insideProps.latitude).toBe(40);
});

// --- CRS: resolveNonFiniteAxis NaN handling (review item 6e) --------------------------

// `resolveNonFiniteAxis` treats every non-finite input the same way (`Number.isFinite(value)`
// is false for NaN too), resolving to the CRS extent's own min/max edge based on
// `value < 0` -- a sensible default for +/-Infinity (the library's own default `maxBounds`
// spans longitude to +/-Infinity, and a signed infinity has a clear "which edge" answer), but
// NOT for NaN: `NaN < 0` is always `false`, so NaN silently resolved to `maxEdge` regardless of
// which corner (min or max) it came from -- an arbitrary, misleading bias for what is really
// "no meaningful value at all", rather than "unconstrained in this direction" (`undefined`,
// which falls through to the real per-axis projection a few lines below).
test('resolveNonFiniteAxis#NaN resolves to undefined (unconstrained), not maxEdge', () => {
  expect(resolveNonFiniteAxis(NaN, -100, 100)).toBeUndefined();
  // Unaffected: signed infinities still resolve to their directional edge.
  expect(resolveNonFiniteAxis(-Infinity, -100, 100)).toBe(-100);
  expect(resolveNonFiniteAxis(Infinity, -100, 100)).toBe(100);
  // Unaffected: a finite value needs a real projection (also undefined), same as before.
  expect(resolveNonFiniteAxis(5, -100, 100)).toBeUndefined();
});
