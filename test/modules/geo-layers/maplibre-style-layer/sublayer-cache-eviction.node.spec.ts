// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {WebMercatorViewport} from '@deck.gl/core';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {MapLibreStyleLayer} from '@deck.gl/geo-layers/maplibre-style-layer/maplibre-style-layer';
import {MVTLayer} from '@deck.gl/geo-layers';

// Bug 2 (review-confirmed, zoom-bucket-regen-skip cache, commit 09b1ab34d): the `subLayerCache`
// (per (tile id, style layer id) memoization Map) is keyed on `tileProps.id` -- the
// TileLayer-namespaced id (`${MVTLayer id}-${rawTileId}`, e.g. "C-source-0,0,0", built by
// `TileLayer.renderLayers()`'s own `this.getSubLayerProps({id: tile.id, ...})` call before handing
// props to `renderSubLayers`) -- but `onTileUnload` deletes by the RAW `Tile2DHeader.id` alone
// (e.g. "0,0,0", the id `TileLayer._onTileUnload` receives straight from its tileset, with no
// namespacing). The two keys never match, so eviction is a silent no-op and `subLayerCache` grows
// without bound for the lifetime of the layer. This pins that after `onTileUnload` fires for a
// tile whose sublayers were cached, the corresponding cache entries are actually gone.

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

const style = {
  layers: [
    {
      id: 'water',
      type: 'fill',
      filter: ['==', ['get', 'class'], 'water'],
      paint: {'fill-color': '#a0c8f0'}
    }
  ]
};

function webMercatorViewportAt(zoom: number): WebMercatorViewport {
  return new WebMercatorViewport({width: 800, height: 600, longitude: 0, latitude: 0, zoom});
}

test('MapLibreStyleLayer#onTileUnload evicts the subLayerCache entries for the unloaded tile (cache size decreases)', () => {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  });
  (layer as any).context = {viewport: webMercatorViewportAt(5)};
  (layer as any).internalState = {subLayers: []};
  (layer as any).props = layer.props;

  const layers = layer.renderLayers() as any[];
  const mvt = layers.find(l => l instanceof MVTLayer);

  // Mirror TileLayer.renderLayers()'s real prop shape: `id` is namespaced under the MVTLayer's
  // own id (`this.getSubLayerProps({id: 'source'}).id`, the FIRST ctor arg `MVTLayer` was built
  // with here), `tile` is the raw `Tile2DHeader` (`.id` un-namespaced) -- exactly what
  // `TileLayer.renderLayers()` spreads into the props object handed to `renderSubLayers`, and
  // exactly what `TileLayer._onTileUnload` receives directly (see tile-layer.ts).
  const rawTileId = '0,0,0';
  const namespacedTileId = `${mvt.props.id}-${rawTileId}`;
  const tileData = [feature];

  mvt.props.renderSubLayers({id: namespacedTileId, tile: {id: rawTileId}, data: tileData});

  const subLayerCache = (layer as any).state.subLayerCache as Map<string, unknown>;
  expect(subLayerCache.size).toBeGreaterThan(0);
  const sizeBeforeUnload = subLayerCache.size;

  mvt.props.onTileUnload({id: rawTileId});

  expect(subLayerCache.size).toBeLessThan(sizeBeforeUnload);
  expect(subLayerCache.has(namespacedTileId)).toBe(false);
});
