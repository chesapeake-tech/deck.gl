// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {IconLayer, GeoJsonLayer} from '@deck.gl/layers';
import {WebMercatorViewport} from '@deck.gl/core';
import {_MapLibreStyleLayer as MapLibreStyleLayer, MVTLayer} from '@deck.gl/geo-layers';

const evaluator = {createPropertyExpression, featureFilter};

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

const iconStyle = {
  layers: [{id: 'poi', type: 'symbol', layout: {'icon-image': 'harbor-15'}}]
};

const viewport = new WebMercatorViewport({
  width: 800,
  height: 600,
  longitude: -74,
  latitude: 40,
  zoom: 3
});

const waterFeature = {
  type: 'Feature',
  properties: {class: 'water'},
  geometry: {
    type: 'Polygon',
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

const poiFeature = {
  type: 'Feature',
  properties: {},
  geometry: {type: 'Point', coordinates: [-74, 40]}
};

/** Constructs a `MapLibreStyleLayer` and drives its `renderLayers()` directly, bypassing the
 * full layer-manager lifecycle (no real network/tile fetching) — the same pattern
 * `maplibre-style-layer-crs.spec.ts`'s minzoom-gating test uses. `prevLayer`, when given,
 * carries `state` over to the new instance -- `Layer#props` is frozen after construction (so a
 * later "prop update" can't mutate it in place), but a real `LayerManager` prop update
 * constructs a fresh layer instance and transfers `state` from the old one to the new one for a
 * matching id -- exactly what this reproduces, so `subLayerCache`/the compile-cache identity
 * tracking on `state` persists across the simulated "swaps" below the same way it would in a
 * real app. */
function mount(props: Record<string, unknown>, prevLayer?: MapLibreStyleLayer): MapLibreStyleLayer {
  const layer = new MapLibreStyleLayer(props as never);
  if (prevLayer) {
    (layer as any).state = (prevLayer as any).state;
  }
  (layer as any).context = {viewport};
  (layer as any).internalState = {subLayers: []};
  return layer;
}

function renderAndGetMVT(layer: MapLibreStyleLayer): any {
  const layers = layer.renderLayers() as any[];
  return layers.find(l => l instanceof MVTLayer);
}

const ASYNC_ORIGINAL_SYMBOL = Symbol.for('asyncPropOriginal');

/** Reads an `IconLayer`'s raw, pre-fetch `iconAtlas` value (see the comment at its call site). */
function iconAtlasOriginal(iconLayer: any): unknown {
  return iconLayer.props[ASYNC_ORIGINAL_SYMBOL]?.iconAtlas ?? iconLayer.props.iconAtlas;
}

test('MapLibreStyleLayer#subLayerCache does not grow unboundedly across repeated source swaps (same style/evaluator identity)', () => {
  let layer = mount({style, source: {data: 'a'}, evaluator});

  // Simulate N distinct source swaps, each time "loading" a handful of distinct tile ids under
  // the new source — mirroring what `Tileset2D.reloadAll()`/`finalize()` do when the inner tile
  // source changes (drop old tiles WITHOUT calling `onTileUnload`, see tileset-2d.ts). Before
  // the fix, `subLayerCache`'s only eviction path was `onTileUnload`, so tile entries orphaned
  // by a source swap were never reclaimed and the cache grew by ~`tilesPerSwap` on every swap.
  const swaps = 20;
  const tilesPerSwap = 5;
  for (let s = 0; s < swaps; s++) {
    layer = mount({style, source: {data: `source-${s}`}, evaluator}, layer);
    const mvt = renderAndGetMVT(layer);
    for (let t = 0; t < tilesPerSwap; t++) {
      mvt.props.renderSubLayers({id: `swap${s}-tile${t}`, data: [waterFeature]});
    }
  }

  const subLayerCache = (layer.state as any).subLayerCache as Map<string, unknown>;
  // Only the most recent swap's tiles should still be present — cumulative growth across all
  // 20 swaps * 5 tiles would be 100 entries; a source-identity-based clear caps it at
  // `tilesPerSwap` (the LRU backstop cap is far higher and should never engage here).
  expect(subLayerCache.size).toBe(tilesPerSwap);
});

test('MapLibreStyleLayer#renderSubLayers rebuilds a cached tile sublayer after spriteAtlas identity changes (icons appear once the atlas resolves)', () => {
  const atlasA = {
    image: 'atlas-a.png',
    mapping: {'harbor-15': {x: 0, y: 0, width: 15, height: 15}}
  };
  const atlasB = {
    image: 'atlas-b.png',
    mapping: {'harbor-15': {x: 0, y: 0, width: 15, height: 15}}
  };

  // Same tile-data reference reused across both renders below — the ONLY thing that should
  // distinguish the pre-fix (buggy) `canReuse` gating from the fix is `spriteAtlas` identity;
  // if the tile data reference also changed, `canReuse` would already rebuild for that reason
  // alone, masking the bug this test targets.
  const tileData = [poiFeature];

  let layer = mount({style: iconStyle, source: {data: 'icons'}, evaluator, spriteAtlas: atlasA});
  const mvt1 = renderAndGetMVT(layer);
  const sublayers1 = mvt1.props.renderSubLayers({id: 'tile-1', data: tileData});
  const icon1 = sublayers1.find((l: any) => l instanceof IconLayer);
  // `iconAtlas` is an async deck.gl prop (`{type: 'image', async: true}`) -- outside a real
  // `LayerManager` lifecycle (which this synthetic harness deliberately skips, see `mount`'s
  // doc comment) its raw, pre-fetch value is preserved under `ASYNC_ORIGINAL_SYMBOL` rather
  // than `props.iconAtlas` itself (which reads back the `null` default until an async loader
  // actually resolves it).
  expect(iconAtlasOriginal(icon1)).toBe('atlas-a.png');

  // Swap only `spriteAtlas` (style/evaluator/source identity unchanged) — the common case of an
  // atlas resolving asynchronously after the first tiles already rendered icon-less/with a
  // placeholder atlas.
  layer = mount({style: iconStyle, source: {data: 'icons'}, evaluator, spriteAtlas: atlasB}, layer);
  const mvt2 = renderAndGetMVT(layer);
  // Same tile id AND same tile data reference as before — under the pre-fix `canReuse` gating
  // (which never checked spriteAtlas identity) this would have returned the stale, already-
  // cached `icon1` layer built against atlasA.
  const sublayers2 = mvt2.props.renderSubLayers({id: 'tile-1', data: tileData});
  const icon2 = sublayers2.find((l: any) => l instanceof IconLayer);
  expect(iconAtlasOriginal(icon2)).toBe('atlas-b.png');
});

test('MapLibreStyleLayer#renderSubLayers reuses the cached sublayer when nothing relevant changed (no regression)', () => {
  let layer = mount({style, source: {data: 'stable'}, evaluator});
  const tileData = [waterFeature];
  const mvt1 = renderAndGetMVT(layer);
  const sublayers1 = mvt1.props.renderSubLayers({id: 'tile-1', data: tileData});
  const fill1 = sublayers1.find((l: any) => l instanceof GeoJsonLayer);

  // Re-render with an unchanged style/evaluator/source/spriteAtlas identity and the same tile
  // data reference — the memoized sublayer should be reused (perf fix from the prior round),
  // not rebuilt on every call.
  layer = mount({style, source: {data: 'stable'}, evaluator}, layer);
  const mvt2 = renderAndGetMVT(layer);
  const sublayers2 = mvt2.props.renderSubLayers({id: 'tile-1', data: tileData});
  const fill2 = sublayers2.find((l: any) => l instanceof GeoJsonLayer);
  // `renderSubLayers` always re-wraps the memoized RAW `mapOneStyleLayer` output with
  // `applyTilePositioning(...).clone({id: ...})` (per-tile id-namespacing), so `fill2` is never
  // `===fill1` even on a full cache hit — assert on an accessor function identity instead,
  // which `.clone({id})` passes through unchanged and which only a real `mapFillLayer`
  // rebuild would replace.
  expect(fill2.props.getFillColor).toBe(fill1.props.getFillColor);
});
