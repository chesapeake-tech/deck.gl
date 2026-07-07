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

`{createPropertyExpression, featureFilter, convertFunction?}` — pass
`@maplibre/maplibre-gl-style-spec`'s own exports directly. `convertFunction` is optional but
recommended: real-world styles (CARTO, Esri) commonly still author zoom-dependent paint/layout
as legacy (pre-expression, Mapbox Style Spec v7-era) `{stops: [...]}` "functions" rather than
expressions, and `createPropertyExpression` rejects a bare `{stops: [...]}` object outright
("Bare objects invalid") unless it is converted first. Passing `convertFunction` lets the
adapter do that conversion itself; omit it and a legacy-function style throws that error instead.

##### `spriteAtlas` (Object, optional)

A resolved sprite sheet for `symbol` icon layers: `{image: string, mapping: Record<string,
{x, y, width, height, pixelRatio?, sdf?}>}` — the fetched atlas image URL/data plus its parsed
sprite JSON mapping (the layer does not fetch `style.sprite` itself, matching
`IconLayer.iconAtlas`/`iconMapping`'s existing "you provide the resolved asset" contract).
`_fetchMapLibreSpriteAtlas(spriteBaseUrl, {fetch?, pixelRatio?})` (also exported from
`@deck.gl/geo-layers`) is a convenience that builds this prop for you: given a style's `sprite`
base URL, it fetches the matching `.json` + `.png` pair (requesting the `@2x` variant when
`pixelRatio >= 2`, falling back to `@1x` if the style has none) via plain `fetch` — no new
runtime dependency — and resolves a ready-to-use `spriteAtlas`. It is invoked by the caller
*before* constructing the layer; `_MapLibreStyleLayer` itself still never fetches anything.

```js
import {_fetchMapLibreSpriteAtlas as fetchMapLibreSpriteAtlas} from '@deck.gl/geo-layers';

const spriteAtlas = await fetchMapLibreSpriteAtlas(myStyleJson.sprite, {
  pixelRatio: window.devicePixelRatio
});
```

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
Legacy (pre-expression) `{stops: [...]}` zoom/property "functions" are normalized into real
expressions before compiling (given `evaluator.convertFunction`, see above), and a `line-dasharray`
zoom function whose stops mix array lengths (e.g. `[1]` at one zoom, `[2, 2]` at another — legal,
since MapLibre's own dasharray semantics are cyclic: `[1]` repeats identically to `[1, 1, ...]`) is
losslessly cyclic-equalized to a common length before compiling, both so it doesn't fail
`createPropertyExpression`'s array-length validation and so every evaluated stop is actually the
same length at runtime, which `PathStyleExtension`'s fixed-size-2 `getDashArray` accessor needs.

Not implemented in v1 (style layers of these types/features are skipped, with a console warning
naming the offending style-layer `id`): `raster`, `raster-particle`, `hillshade`, `heatmap` style
layers; `line-gradient`; `fill-pattern`; true curved `symbol-placement: 'line'` labels (a single
horizontal label at the line's midpoint is substituted instead — see the design doc's Decisions
for review #4); glyph-PBF font parity (`text-font` is approximated by one browser `fontFamily`);
the `["format", ...]` expression (rich multi-run text — throws a clear compile-time error rather
than silently rendering something wrong, since its result isn't a plain string).

### Style evaluation zoom in CRS views

Paint/layout expressions that depend on `["zoom"]`, and `minzoom`/`maxzoom` gating, are
re-evaluated once per integer zoom level, not continuously — but the zoom number used is the
**Mercator-equivalent** zoom, not the raw `viewport.zoom`, whenever the layer is rendered inside a
non-Mercator CRS `MapView`. A CRS view's zoom is extent-relative (see [`MapView`'s `crs`
docs](../core/map-view.md#crs)): a projected CRS with a much smaller extent than Web Mercator's
whole world (e.g. a single UTM zone) reaches the same zoom NUMBER at a far more zoomed-in ground
scale, so evaluating style expressions and `minzoom`/`maxzoom` gating against the raw CRS zoom
silently hides every minzoom-gated style layer — most visibly labels, which are almost always
minzoom-gated. The layer derives the Mercator-equivalent zoom from the viewport's own ground
resolution (`viewport.metersPerPixel`) instead, which is an exact no-op (identical to
`viewport.zoom`) for a classic Web Mercator `MapView` — this only changes behavior in a CRS view,
and there it makes minzoom-gated content (e.g. reference labels) appear at the ground scale a real
MapLibre/Mercator map would show them at, instead of being hidden.

This helper is exported from `@deck.gl/geo-layers` as `_mercatorEquivalentZoom(viewport)` for
consumers that need the same Mercator-equivalent zoom outside this layer (e.g. driving their own
CRS-aware `minzoom`/`maxzoom` gating), rather than re-deriving the formula themselves.

### `background` style layers and CRS views

A `background` style layer has no source features, so it is rendered by covering the current
viewport with a filled polygon in `COORDINATE_SYSTEM.LNGLAT` space. In a CRS view this polygon
covers the viewport's own CRS's valid `extent` (densified and inverse-projected to lnglat), not a
hardcoded whole-world rectangle — the whole-world rectangle is only valid for Web Mercator (or
other whole-world) views; a projected CRS with a much smaller domain folds it into a degenerate
shape that never actually covers the viewport once run through the CRS's `transform.forward`.

### Re-styling on a `style` swap

Passing a new `style` object (identity change, not just a deep-equal one) regenerates the inner
tile source's already-materialized sublayers on the next render, the same way a zoom-bucket
crossing already does — swapping styles live (e.g. a basemap-style switcher) restyles cached
tiles instead of leaving them showing the previous style.

Each style layer's filter/paint/layout expressions are compiled once per `style`+`evaluator`
identity (not once per tile or per render) and cached for the layer instance's lifetime; passing
a new `style` or `evaluator` object (not just a deep-equal one) invalidates the cache.

## Source

[modules/geo-layers/src/maplibre-style-layer](https://github.com/visgl/deck.gl/tree/master/modules/geo-layers/src/maplibre-style-layer)
