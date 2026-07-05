# WarpedTileLayer (Experimental)

`_WarpedTileLayer` renders a Web-Mercator raster tile pyramid (OSM, Esri World Imagery — any
plain `{z}/{x}/{y}` XYZ service) inside a `MapView` with a non-Mercator
[`crs`](../core/map-view.md#crs), with no reprojecting server. Each tile is drawn as a small
warped mesh: a grid of vertices is reprojected Mercator → the view CRS exactly on the CPU, and
the tile image is texture-mapped across it on the GPU (triangulated reprojection).

```js
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {MapView} from '@deck.gl/core';

const layer = new WarpedTileLayer({
  data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileSize: 256,
  maxZoom: 19
});
// rendered with: new MapView({crs: myUTMDefinition})
```

Inherits all [TileLayer](./tile-layer.md) properties with these differences:

- `minZoom`/`maxZoom` refer to the **source** (OSM) pyramid levels. The source level is chosen
  by matching ground resolution at the view center.
- `tileMatrixSet` does not apply (the source grid is the fixed Web-Mercator pyramid). For tile
  services native to the view CRS, use [TileLayer with
  `tileMatrixSet`](./tile-layer.md#tilematrixset) instead.

**Careful with `minZoom`/`maxZoom` when composing this layer with a `tileMatrixSet`-driven
`TileLayer`.** The two props are *not* the same kind of number, even though they share a name:
on `_WarpedTileLayer` they index the **source Web-Mercator pyramid** (e.g. `maxZoom: 19` means
"OSM zoom 19 is this service's deepest level"), while on `TileLayer` with `tileMatrixSet` set,
they index **array positions in `tileMatrixSet.tileMatrices`** (e.g. `maxZoom: 7` means "the
last, finest entry in that array"). An app that overlays a warped OSM basemap (`_WarpedTileLayer`)
with a native-CRS vector or raster `TileLayer` (`tileMatrixSet`) should set each layer's
`minZoom`/`maxZoom` from its own numbering — copying one layer's values onto the other silently
clips to the wrong pyramid/matrix depth instead of erroring.
- `tileSize` is the source tile's pixel size (256 for OSM; some services are 512).
- `zRange` is ignored (no terrain in CRS views).
- The default `renderSubLayers` produces a textured mesh (`SimpleMeshLayer`), not GeoJSON.
  `renderSubLayers` remains overridable: a custom function receives the usual sublayer props
  — including `tile` (with `bbox` and `boundsWorld`) — plus `mesh` and `origin`, the warped
  mesh this layer builds for that tile and its common-space origin, so a replacement renderer
  doesn't have to redo the CPU reprojection.

##### `_meshResolution` (number | 'auto', optional) {#_meshresolution}

- Default: `'auto'`

Warp grid cells per tile edge. Vertices are exact; between them the GPU interpolates linearly.

With the default `'auto'`, each tile's grid size is chosen from its measured distortion at the
current view scale, from `{4, 8, 16, 32}`, holding a ≤0.15 px interpolation-error bound: nearly
affine tiles (survey scales) use a coarse 4×4 grid, strongly bowed continental-zoom tiles use up
to 32×32 (the finest, used as a best-effort fallback when even it can't reach the bound — e.g. a
tile far outside a UTM zone). Pass a fixed number to override the adaptive choice.

## Quality and performance envelope

- Warp is exact at grid vertices at any view scale (full CRS transform on CPU, float64, with
  origin-relative float32 attributes for GPU precision); the adaptive grid keeps the between-vertex
  interpolation error ≤0.15 px.
- Tile-edge seams are eliminated with a half-texel UV inset (gutter clamp): mesh UVs span
  `[0.5/w, 1 − 0.5/w]` (w = tile texel width) so linear filtering never reaches a neighbor tile's
  border texels. The tradeoff is that each tile image's outermost half-texel ring is cropped.
  Momentary cracks between zoom levels while children load remain possible (`best-available`
  refinement shows the parent underneath).
- Source level matches ground resolution at the view center; across very wide views the
  effective source resolution drifts by Mercator's `cos(latitude)` factor.
- Views crossing the antimeridian are not supported.
