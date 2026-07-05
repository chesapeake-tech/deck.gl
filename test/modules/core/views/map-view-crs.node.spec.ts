// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {
  MapView,
  MapController,
  WebMercatorViewport,
  _CRSViewport as CRSViewport
} from '@deck.gl/core';
import {UTM18N} from '../viewports/crs-fixtures';

const VIEW_STATE = {longitude: -72, latitude: 40, zoom: 10};

test('MapView#without crs makes WebMercatorViewport', () => {
  const view = new MapView({});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(WebMercatorViewport);
});

test('MapView#crs EPSG:3857 makes WebMercatorViewport', () => {
  const view = new MapView({crs: 'EPSG:3857'});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(WebMercatorViewport);
});

test('MapView#crs definition makes CRSViewport', () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(CRSViewport);
  expect((viewport as InstanceType<typeof CRSViewport>).crs.code).toBe('EPSG:32618');
  const [lng, lat] = viewport!.unproject([400, 300]);
  expect(lng).toBeCloseTo(-72, 6);
  expect(lat).toBeCloseTo(40, 6);
});

test('MapView#crs EPSG:4326 makes CRSViewport', () => {
  const view = new MapView({crs: 'EPSG:4326'});
  const viewport = view.makeViewport({width: 800, height: 600, viewState: VIEW_STATE});
  expect(viewport).toBeInstanceOf(CRSViewport);
});

test('MapView#crs no longer forces controller normalize off (D1: constraints are viewport-delegated)', () => {
  // Pre-D1, MapController's `normalize` constraints (world-fit min zoom,
  // equator-centered maxBounds clamp) were computed in Web Mercator world
  // coordinates and were meaningless in another CRS, so MapView defaulted
  // `normalize` to `false` for non-Mercator `crs`. D1 (viewport-delegated
  // constraints) made that math CRS-correct, so the override is gone: `controller`
  // options pass straight through, same as any other view/crs combination.
  const view = new MapView({crs: UTM18N, controller: true});
  expect(view.controller).not.toHaveProperty('normalize');

  const view4326 = new MapView({crs: 'EPSG:4326', controller: {dragPan: false}});
  expect(view4326.controller).toMatchObject({dragPan: false});
  expect(view4326.controller).not.toHaveProperty('normalize');
});

test('MapView#crs controller normalize is still a plain user-settable option', () => {
  const view = new MapView({crs: UTM18N, controller: {normalize: true}});
  expect(view.controller).toMatchObject({normalize: true});

  const disabledNormalize = new MapView({crs: UTM18N, controller: {normalize: false}});
  expect(disabledNormalize.controller).toMatchObject({normalize: false});
});

test('MapView#crs zoom-out with the (now default) normalize:true clamps to the extent-fit, not the equator (D1 regression)', () => {
  // End-to-end port of the clarity-client trial's "map disappears on zoom-out" bug:
  // a real MapView (default controller options, no `normalize` override) driving a
  // MapController over a UTM 18N CRSViewport. Pre-D1 this required MapView's
  // `normalize: false` override to avoid a frozen zoom (`log2(viewportHeight/512)`,
  // the Mercator world height) and a collapse of `latitude` to 0 (Mercator's
  // equator). Post-D1, the default `controller: true` (normalize on) should clamp
  // to the CRS's own extent-fit instead.
  const view = new MapView({crs: UTM18N, controller: true});
  const width = 1280;
  const height = 720;
  const makeViewport = (viewState: any) => view.makeViewport({viewState, width, height})!;

  const MapState = new MapController({} as any).ControllerState;
  const viewState = new MapState({
    ...(view.controller as any),
    width,
    height,
    longitude: -72,
    latitude: 40,
    zoom: -10, // aggressively zoomed out, well past any sane UTM-zone scale
    makeViewport
  });
  const props = viewState.getViewportProps();

  expect(props.normalize).toBe(true);
  // Not the Mercator-world-height freeze.
  expect(props.zoom).not.toBeCloseTo(Math.log2(height / 512), 2);
  // Not snapped to the equator - stays close to the requested 40 degrees latitude.
  expect(props.latitude).toBeCloseTo(40, 6);
  // The map is not "gone": unprojecting the viewport center lands back near the
  // requested view center, not off in CRS-extent-origin territory.
  const constrainedViewport = makeViewport(props);
  const [lng, lat] = constrainedViewport.unproject([width / 2, height / 2]);
  expect(lng).toBeCloseTo(props.longitude, 6);
  expect(lat).toBeCloseTo(40, 3);
});

test('MapView#default crs keeps controller options untouched', () => {
  const view = new MapView({controller: true});
  expect(view.controller).not.toHaveProperty('normalize');

  const mercator = new MapView({crs: 'EPSG:3857', controller: true});
  expect(mercator.controller).not.toHaveProperty('normalize');

  const disabled = new MapView({crs: UTM18N, controller: false});
  expect(disabled.controller).toBeNull();
});
