// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView, WebMercatorViewport, _CRSViewport as CRSViewport} from '@deck.gl/core';
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
