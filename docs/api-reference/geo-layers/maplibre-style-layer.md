# MapLibreStyleLayer (Experimental)

```js
import {_MapLibreStyleLayer as MapLibreStyleLayer} from '@deck.gl/geo-layers';
```

`MapLibreStyleLayer` converts a MapLibre GL style JSON plus a vector tile source into styled
deck.gl layers — one deck.gl layer per style layer, per tile, in style order. It works in both
classic Mercator `MapView`s and non-Mercator CRS `MapView`s (see [MVTLayer CRS
support](./mvt-layer.md#crs-views)); the vector source's `tileMatrixSet` follows the same
convention as `MVTLayer`/`TileLayer` — it is optional, and unset (the classic Mercator XYZ
pyramid shape, e.g. Esri's "Ocean Reference" service) is the common case, automatically routed
through `_MercatorCRSTileset2D` in a CRS view, not a fallback.

## No bundled style-spec dependency

`MapLibreStyleLayer` does not depend on `@maplibre/maplibre-gl-style-spec` at runtime — you
supply its two entry points (`createPropertyExpression`, `featureFilter`) as the `evaluator`
prop:

```js
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {_MapLibreStyleLayer as MapLibreStyleLayer} from '@deck.gl/geo-layers';

new MapLibreStyleLayer({
  style: myStyleJson,
  source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
  evaluator: {createPropertyExpression, featureFilter}
});
```

## Properties

##### `style` (Object, required)

A MapLibre GL style JSON (or the relevant `layers` subset): `{layers: [...]}`.

##### `source` (Object, required)

The vector tile source: `{data: string, tileMatrixSet?: TileMatrixSet}`. `data` is a
`{z}/{x}/{y}` tile URL template, mirroring `MVTLayer`'s own `data` prop. `tileMatrixSet` is
optional CRS-native tiling (see [`tile-layer.md#tilematrixset`](./tile-layer.md#tilematrixset));
omit it for a classic Mercator XYZ vector source.

##### `evaluator` (Object, required)

`{createPropertyExpression, featureFilter}` — pass `@maplibre/maplibre-gl-style-spec`'s own
exports directly.

##### `spriteAtlas` (Object, optional)

A resolved sprite sheet for `symbol` icon layers: `{image: string, mapping: Record<string,
{x, y, width, height, pixelRatio?, sdf?}>}` — the fetched atlas image URL/data plus its parsed
sprite JSON mapping (the layer does not fetch `style.sprite` itself, matching
`IconLayer.iconAtlas`/`iconMapping`'s existing "you provide the resolved asset" contract).

## v1 support

Implemented: `background`, `fill` (+ outline), `line` (+ `line-dasharray`), `fill-extrusion`,
`symbol` icons (via a resolved sprite atlas passed as `spriteAtlas`) and point-placed text labels
(collision handled via `CollisionFilterExtension`; `symbol-sort-key` maps to collision
priority).

Not implemented in v1 (style layers of these types/features are skipped, with a console warning
naming the offending style-layer `id`): `raster`, `raster-particle`, `hillshade`, `heatmap` style
layers; `line-gradient`; `fill-pattern`; true curved `symbol-placement: 'line'` labels (a single
horizontal label at the line's midpoint is substituted instead — see the design doc's Decisions
for review #4); glyph-PBF font parity (`text-font` is approximated by one browser `fontFamily`).

Paint/layout expressions that depend on `["zoom"]` are re-evaluated once per integer zoom level
(`Math.floor(viewport.zoom)`), not continuously — see the design doc's Decisions for review #3.

## Source

[modules/geo-layers/src/maplibre-style-layer](https://github.com/visgl/deck.gl/tree/master/modules/geo-layers/src/maplibre-style-layer)
