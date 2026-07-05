// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {afterEach, test, expect, vi} from 'vitest';
import {MapView, WebMercatorViewport, type MapViewState} from '@deck.gl/core';
import {CompassWidget} from '@deck.gl/widgets';
import {WidgetTester} from './common';
import {UTM18N} from '../core/viewports/crs-fixtures';

let testInstance: WidgetTester<any> | undefined;

afterEach(() => {
  testInstance?.destroy();
  testInstance = undefined;
});

test('CompassWidget', async () => {
  let viewState: MapViewState = {
    longitude: 0,
    latitude: 0,
    zoom: 1,
    bearing: -120,
    pitch: 45
  };
  const onReset = vi.fn();
  testInstance = new WidgetTester({
    initialViewState: viewState,
    onViewStateChange: (evt: any) => {
      viewState = evt.viewState;
    },
    widgets: [new CompassWidget({id: 'compass', onReset})]
  });

  await testInstance.idle();
  testInstance.click('.deck-widget-button > button');
  expect(onReset).toHaveBeenCalledWith({
    viewId: 'default-view',
    bearing: 0,
    pitch: 45
  });
  expect(viewState.bearing).toBe(0);

  await testInstance.idle();
  testInstance.click('.deck-widget-button > button');
  expect(onReset).toHaveBeenCalledWith({
    viewId: 'default-view',
    bearing: 0,
    pitch: 0
  });
  expect(viewState.pitch).toBe(0);
});

test('CompassWidget#getRotation and getConvergence: Mercator viewport is unaffected', () => {
  const widget = new CompassWidget();
  const viewport = new WebMercatorViewport({
    width: 800,
    height: 600,
    longitude: -72,
    latitude: 40,
    zoom: 10,
    bearing: 30,
    pitch: 20
  });
  expect(widget.getRotation(viewport)).toEqual([-30, 20]);
  // Web Mercator has no grid/true north distinction
  expect(widget.getConvergence(viewport)).toBeNull();
});

test('CompassWidget#getRotation and getConvergence: CRS viewport picks up bearing/pitch and convergence', () => {
  const widget = new CompassWidget();
  const view = new MapView({crs: UTM18N});
  // -72 is 3 degrees east of UTM 18N's central meridian (-75); known convergence ~1.93deg
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 10, bearing: 30, pitch: 20}
  })!;

  const [rz, rx] = widget.getRotation(viewport);
  expect(rz).toBe(-30);
  expect(rx).toBe(20);

  const convergence = widget.getConvergence(viewport);
  expect(convergence).not.toBeNull();
  expect(convergence as number).toBeGreaterThan(1.8);
  expect(convergence as number).toBeLessThan(2.1);
});

test('CompassWidget#getConvergence is null on the CRS central meridian (grid ~= true north)', () => {
  const widget = new CompassWidget();
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -75, latitude: 40, zoom: 10}
  })!;
  expect(widget.getConvergence(viewport)).toBeCloseTo(0, 3);
});

test('CompassWidget#renders a true-north tick and convergence tooltip only for a CRS view off the central meridian', async () => {
  const crsViewState: MapViewState = {longitude: -72, latitude: 40, zoom: 10, bearing: 0, pitch: 0};
  testInstance = new WidgetTester({
    views: new MapView({crs: UTM18N}),
    initialViewState: crsViewState,
    widgets: [new CompassWidget({id: 'compass'})]
  });
  await testInstance.idle();

  const trueNorthTicks = testInstance.findElements('.deck-widget-compass-true-north');
  expect(trueNorthTicks.length).toBe(1);

  const button = testInstance.findElements('.deck-widget-button > button')[0] as HTMLElement;
  expect(button.title).toMatch(/grid vs\. true north/);
  expect(button.title).toMatch(/\+1\.9\d°/);
});

test('CompassWidget#does not render a true-north tick for a non-CRS (Mercator) view', async () => {
  const viewState: MapViewState = {longitude: -72, latitude: 40, zoom: 10, bearing: 0, pitch: 0};
  testInstance = new WidgetTester({
    initialViewState: viewState,
    widgets: [new CompassWidget({id: 'compass'})]
  });
  await testInstance.idle();

  expect(testInstance.findElements('.deck-widget-compass-true-north').length).toBe(0);
  const button = testInstance.findElements('.deck-widget-button > button')[0] as HTMLElement;
  expect(button.title).not.toMatch(/grid vs\. true north/);
});
