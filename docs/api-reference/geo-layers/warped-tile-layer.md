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
- `tileMatrixSet` does not apply (it describes a grid *native* to the view CRS). To warp a
  non-Mercator **source** pyramid, use `sourceTileMatrixSet`/`sourceCrs` below. For tile services
  native to the view CRS (no warping), use [TileLayer with
  `tileMatrixSet`](./tile-layer.md#tilematrixset) instead.

##### `sourceTileMatrixSet` (TileMatrixSet, optional) {#sourcetilematrixset}

- Default: the built-in WebMercatorQuad pyramid

An OGC TileMatrixSet describing the **source** tile pyramid, expressed in `sourceCrs` units.
Unset, the source is the standard Web-Mercator (`{z}/{x}/{y}`) pyramid and behavior is unchanged.
`sourceTileMatrixSet` and `sourceCrs` must be set together — either alone throws (a TMS without
its CRS has no defined units; a CRS without a grid has nothing to index). Index/level math is
shared with `TileLayer`'s `tileMatrixSet`.

##### `sourceCrs` (CRSDefinition | 'EPSG:4326', optional) {#sourcecrs}

- Default: Web Mercator

The CRS the source pyramid is described in, so a non-Mercator source (e.g. a 4326
`WorldCRS84Quad` source like NASA GIBS) can be warped into the view CRS:

- unset / `null` — the built-in Web-Mercator source (today's behavior);
- `'EPSG:4326'` — a lat/long source whose tile coordinates **are** lnglat (the identity case);
- a `CRSDefinition` — any other source, which must carry the exact `transform.inverse`
  (source coordinates → lnglat).

The definition's `transform.forward` (lnglat → source coordinates) should **clamp**
out-of-domain input to its domain edge rather than returning `NaN` — that keeps the fetch area
tight, the way the built-in Mercator source clamps latitude to ±85.05°. A forward that returns
non-finite values outside its domain is tolerated (such view corners are skipped when computing
the fetch bounds), but wastes precision when most of the view leaves the source's domain.

**Scope limitation:** the source CRS must be `'EPSG:4326'` or a caller-supplied `CRSDefinition`
with its own inverse. The layer does **not** build a general inverse-projection framework —
inverting an arbitrary projection server-side is exactly what this client-side layer exists to
avoid. Source level selection matches the source's ground resolution at the view center and works
across source TMSs unchanged.

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

## Known behavior

- **Pitched views select per-region levels** (far tiles coarser, near tiles finer) instead of one
  level for the whole view. The band dedup is a center-in-cover test: it never leaves holes, but a
  coarse tile straddling a band seam can be kept and **double-drawn** under the finer tiles above
  it (measured up to ~a quarter of selected tiles at pitch 65). This is visually benign for opaque
  rasters — the finer tiles render on top — but semi-transparent tile imagery may show slightly
  darker seams at band boundaries under high pitch. Exact-coverage dedup is future work.
- **Pitch envelope.** Screen samples above the horizon do not unproject to `NaN` — they extrapolate
  to finite ground positions — so tile selection relies on the horizon staying off-screen. With
  deck's default camera the horizon enters the frame around pitch ~71°; `MapView`'s default
  `maxPitch` of 60° keeps well inside this envelope. Geometric above-horizon detection is future
  work for steeper custom cameras.
