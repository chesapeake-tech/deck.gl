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

`source` accepts any other `MVTLayer`/`TileLayer` prop too (it is spread verbatim into the
inner `MVTLayer` this composite creates) — most notably a custom `fetch` override, an escape
hatch for offline/synthetic tile data (no public MVT test service exists for every CRS/UTM
combination, so the module's own demo app and test suite rely on this same mechanism):

```js
new MapLibreStyleLayer({
  style: myStyleJson,
  source: {
    data: 'https://example.com/tiles/{z}/{x}/{y}.mvt',
    fetch: (url, {layer, loadOptions}) => myCustomTileFetch(url, loadOptions)
  },
  evaluator: {createPropertyExpression, featureFilter}
});
```

A custom `fetch` bypasses `MVTWorkerLoader`'s own PBF parse step, which is what normally performs
the tile-local `[0, 1]` → lnglat coordinate transform for CRS/Globe views (`coordinates: 'wgs84'`
in `loadOptions.mvt`, see [`mvt-layer.md`](./mvt-layer.md)). A custom `fetch` implementation must
branch on `loadOptions.mvt.coordinates` itself: return tile-local `[0, 1]` coordinates for the
classic Mercator case (`loadOptions.mvt.coordinates !== 'wgs84'`), or already-lnglat coordinates
when it is `'wgs84'` (CRS/Globe views) — returning the wrong convention silently mis-positions
every feature. See `test/apps/crs-viewport/app.jsx`'s demo `fetch` override for a worked example
of this branch.

##### `updateTriggers` on `source` (Object, optional)

Any `updateTriggers` entries set inside `source` (i.e. `source.updateTriggers`) are merged with
(not overridden by) the ones this composite sets on the inner `MVTLayer` internally — safe to
add your own alongside the built-in zoom-bucket trigger that drives re-styling on zoom.

##### `evaluator` (Object, required)

`{createPropertyExpression, featureFilter}` — pass `@maplibre/maplibre-gl-style-spec`'s own
exports directly.

##### `spriteAtlas` (Object, optional)

A resolved sprite sheet for `symbol` icon layers: `{image: string, mapping: Record<string,
{x, y, width, height, pixelRatio?, sdf?}>}` — the fetched atlas image URL/data plus its parsed
sprite JSON mapping (the layer does not fetch `style.sprite` itself, matching
`IconLayer.iconAtlas`/`iconMapping`'s existing "you provide the resolved asset" contract).

## v1 support

Implemented: `background`, `fill` (+ outline), `line` (+ `line-width` in CSS pixels +
`line-dasharray`), `fill-extrusion`, `symbol` icons (via a resolved sprite atlas passed as
`spriteAtlas`; `icon-size` is honored as a multiplier of the sprite's native, pixelRatio-corrected
size) and text labels — point-placed, plus `LineString`/`MultiLineString` under
`symbol-placement: 'line'` (approximated at the midpoint, see below) and `Polygon`/`MultiPolygon`
(labeled at their exterior-ring centroid) — with `text-size` (including zoom interpolation) and
`text-color`, collision handled via `CollisionFilterExtension` (`symbol-sort-key` maps to
collision priority, negated to translate MapLibre's low-wins convention to
`CollisionFilterExtension`'s high-wins one). Legacy `"{token}"` text-field strings are
substituted with the referenced feature property, matching pre-expression MapLibre styles.

Every style layer honors `source-layer` (matched against the vector tile's own named layer,
`feature.properties.layerName`), `layout.visibility: 'none'`, and `minzoom`/`maxzoom` — real
styles rely on all three, commonly scoping a layer by `source-layer` alone with no other filter.

Not implemented in v1 (style layers of these types/features are skipped, with a console warning
naming the offending style-layer `id`): `raster`, `raster-particle`, `hillshade`, `heatmap` style
layers; `line-gradient`; `fill-pattern`; true curved `symbol-placement: 'line'` labels (a single
horizontal label at the line's midpoint is substituted instead — see the design doc's Decisions
for review #4); glyph-PBF font parity (`text-font` is approximated by one browser `fontFamily`);
the `["format", ...]` expression (rich multi-run text — throws a clear compile-time error rather
than silently rendering something wrong, since its result isn't a plain string).

Paint/layout expressions that depend on `["zoom"]` are re-evaluated once per integer zoom level
(`Math.floor(viewport.zoom)`), not continuously — see the design doc's Decisions for review #3.
Each style layer's filter/paint/layout expressions are compiled once per `style`+`evaluator`
identity (not once per tile or per render) and cached for the layer instance's lifetime; passing
a new `style` or `evaluator` object (not just a deep-equal one) invalidates the cache.

## Source

[modules/geo-layers/src/maplibre-style-layer](https://github.com/visgl/deck.gl/tree/master/modules/geo-layers/src/maplibre-style-layer)
