// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';
import {MVTLayer} from '@deck.gl/geo-layers';

// Perf fix: a zoom-bucket crossing (`updateTriggers.renderSubLayers = [zoomBucket(zoom), style]`,
// see the "Review fix (C1)"/"Review fix (Round 8 finding 2)" comments in maplibre-style-layer.ts)
// makes TileLayer null out `tile.layers` for EVERY cached tile, forcing every visible tile's
// `renderSubLayers` callback (this file's closure) to re-run `mapOneStyleLayer` for EVERY style
// layer, even ones whose paint/layout has no `["zoom"]` dependence and no minzoom/maxzoom gate in
// range -- pure wasted work that gets worse with more tiles/layers/features. This pins that a
// zoom-independent, non-range-gated style layer's mapped sublayer (and the `matched` feature
// array `mapOneStyleLayer` built it from) is REUSED unchanged across a bucket crossing, while a
// zoom-dependent (or range-gate-crossing) style layer still rebuilds.

const evaluator = {createPropertyExpression, featureFilter};

const feature = {
  type: 'Feature' as const,
  properties: {class: 'water'},
  geometry: {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ]
    ]
  }
};

function webMercatorViewportAt(zoom: number): WebMercatorViewport {
  return new WebMercatorViewport({width: 800, height: 600, longitude: 0, latitude: 0, zoom});
}

function findById(sublayers: any[], suffix: string): any {
  return sublayers.find((l: any) => l.id.endsWith(suffix));
}

test("MapLibreStyleLayer#renderSubLayers reuses a zoom-independent style layer's mapped sublayer (same `data` array) across a zoom-bucket crossing", () => {
  const style = {
    layers: [
      {
        id: 'water-static',
        type: 'fill',
        filter: ['==', ['get', 'class'], 'water'],
        // Constant color/opacity -- no `["zoom"]` reference anywhere, and no minzoom/maxzoom.
        paint: {'fill-color': '#a0c8f0', 'fill-opacity': 0.8}
      },
      {
        id: 'water-zoom',
        type: 'fill',
        filter: ['==', ['get', 'class'], 'water'],
        // Zoom-interpolated color: a real `["zoom"]` dependence, must still regenerate.
        paint: {
          'fill-color': ['interpolate', ['linear'], ['zoom'], 0, '#ff0000', 20, '#0000ff']
        }
      }
    ]
  };

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(5.7)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAt5 = layer.renderLayers() as any[];
  const mvt5 = layersAt5.find(l => l instanceof MVTLayer);
  const tileData = [feature];
  const sublayersAt5 = mvt5.props.renderSubLayers({id: 'tile-1', data: tileData});
  const staticAt5 = findById(sublayersAt5, 'water-static');
  const zoomDepAt5 = findById(sublayersAt5, 'water-zoom');
  expect(staticAt5).toBeTruthy();
  expect(zoomDepAt5).toBeTruthy();

  // Cross the integer-zoom boundary (bucket 5 -> 6) with the SAME tile data reference -- a pure
  // zoom-bucket-crossing regen, not a new tile load.
  (layer as any).context = {viewport: webMercatorViewportAt(6.2)};
  const layersAt6 = layer.renderLayers() as any[];
  const mvt6 = layersAt6.find(l => l instanceof MVTLayer);
  const sublayersAt6 = mvt6.props.renderSubLayers({id: 'tile-1', data: tileData});
  const staticAt6 = findById(sublayersAt6, 'water-static');
  const zoomDepAt6 = findById(sublayersAt6, 'water-zoom');

  // Zoom-independent layer: the underlying mapped GeoJsonLayer (and the `matched` feature array
  // `filterFeatures` built it from) is reused byte-for-byte -- `mapOneStyleLayer`'s
  // filter/compile/feature loop did NOT re-run for this style layer on this crossing.
  expect(staticAt6.props.data).toBe(staticAt5.props.data);

  // Zoom-dependent layer: still rebuilt every crossing (a fresh `matched` array).
  expect(zoomDepAt6.props.data).not.toBe(zoomDepAt5.props.data);
});

test('MapLibreStyleLayer#renderSubLayers still regenerates a non-zoom-dependent style layer whose minzoom gate is crossed by the zoom-bucket crossing', () => {
  const style = {
    layers: [
      {
        id: 'water-gated',
        type: 'fill',
        minzoom: 6,
        filter: ['==', ['get', 'class'], 'water'],
        // Constant paint -- no `["zoom"]` dependence, but minzoom gates it out below zoom 6.
        paint: {'fill-color': '#a0c8f0'}
      }
    ]
  };

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(5.7)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAt5 = layer.renderLayers() as any[];
  const mvt5 = layersAt5.find(l => l instanceof MVTLayer);
  const tileData = [feature];
  const sublayersAt5 = mvt5.props.renderSubLayers({id: 'tile-1', data: tileData});
  // Below minzoom: gated out entirely.
  expect(findById(sublayersAt5, 'water-gated')).toBeFalsy();

  (layer as any).context = {viewport: webMercatorViewportAt(6.2)};
  const layersAt6 = layer.renderLayers() as any[];
  const mvt6 = layersAt6.find(l => l instanceof MVTLayer);
  const sublayersAt6 = mvt6.props.renderSubLayers({id: 'tile-1', data: tileData});
  // At/above minzoom: must now appear -- the in-range flip must not be masked by the
  // "zoom-independent paint -> skip regen" optimization.
  expect(findById(sublayersAt6, 'water-gated')).toBeTruthy();
});
