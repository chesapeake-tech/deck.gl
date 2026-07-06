// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';
import {MVTLayer} from '@deck.gl/geo-layers';

// Bug 1 (review-confirmed, zoom-bucket-regen-skip cache, commit 09b1ab34d): `isZoomDependent` in
// the `SubLayerCacheEntry` memoization was derived ONLY from the built layer's own paint/layout
// `updateTriggers` (`layerHasZoomDependentAccessor`) -- a style layer whose `["zoom"]` dependence
// lives entirely in its `filter` (e.g. `filter: ["<=", ["zoom"], 10]`) with otherwise-static paint
// produced no updateTrigger, so it was misclassified as zoom-INDEPENDENT and its stale
// `mapOneStyleLayer` output (built from the matched-feature set at the OLD zoom) was reused
// unchanged across a bucket crossing -- a feature that should now be filtered out (or newly
// admitted) by the zoom-dependent filter kept rendering (or stayed absent) using the stale
// verdict. This pins that a filter referencing `["zoom"]` forces a rebuild on every bucket
// crossing, while a filter with no zoom reference is unaffected (still gets the perf-win skip).

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

test('MapLibreStyleLayer#renderSubLayers rebuilds a filter-zoom-dependent style layer across a bucket crossing (feature drops out once the filter excludes it)', () => {
  const style = {
    layers: [
      {
        id: 'water-filter-zoom',
        type: 'fill',
        // The ONLY zoom dependence is in the filter -- paint is fully static.
        filter: ['<=', ['zoom'], 10],
        paint: {'fill-color': '#a0c8f0'}
      }
    ]
  };

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(8.5)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAt8 = layer.renderLayers() as any[];
  const mvt8 = layersAt8.find(l => l instanceof MVTLayer);
  const tileData = [feature];
  const sublayersAt8 = mvt8.props.renderSubLayers({id: 'tile-1', data: tileData});
  // In range (zoom 8 <= 10): the feature passes the filter, layer is present.
  expect(findById(sublayersAt8, 'water-filter-zoom')).toBeTruthy();

  // Cross the bucket boundary (8 -> 12), same tile data reference -- a pure bucket-crossing regen.
  (layer as any).context = {viewport: webMercatorViewportAt(12.3)};
  const layersAt12 = layer.renderLayers() as any[];
  const mvt12 = layersAt12.find(l => l instanceof MVTLayer);
  const sublayersAt12 = mvt12.props.renderSubLayers({id: 'tile-1', data: tileData});
  // Out of range (zoom 12 > 10): the filter must now exclude the feature -- the style layer's
  // mapped output must have been rebuilt, not reused from the stale zoom-8 verdict.
  expect(findById(sublayersAt12, 'water-filter-zoom')).toBeFalsy();
});

test('MapLibreStyleLayer#renderSubLayers still skips regen for a style layer whose filter has no zoom reference (perf win preserved)', () => {
  const style = {
    layers: [
      {
        id: 'water-filter-static',
        type: 'fill',
        // Filter references a feature property, never `["zoom"]`.
        filter: ['==', ['get', 'class'], 'water'],
        paint: {'fill-color': '#a0c8f0'}
      }
    ]
  };

  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(8.5)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layersAt8 = layer.renderLayers() as any[];
  const mvt8 = layersAt8.find(l => l instanceof MVTLayer);
  const tileData = [feature];
  const sublayersAt8 = mvt8.props.renderSubLayers({id: 'tile-1', data: tileData});
  const staticAt8 = findById(sublayersAt8, 'water-filter-static');
  expect(staticAt8).toBeTruthy();

  (layer as any).context = {viewport: webMercatorViewportAt(12.3)};
  const layersAt12 = layer.renderLayers() as any[];
  const mvt12 = layersAt12.find(l => l instanceof MVTLayer);
  const sublayersAt12 = mvt12.props.renderSubLayers({id: 'tile-1', data: tileData});
  const staticAt12 = findById(sublayersAt12, 'water-filter-static');
  expect(staticAt12).toBeTruthy();
  // No zoom in the filter and no zoom-dependent paint -- must still be the SAME reused mapped
  // output (byte-for-byte, same `data` reference), i.e. the perf-win skip still applies.
  expect(staticAt12.props.data).toBe(staticAt8.props.data);
});
