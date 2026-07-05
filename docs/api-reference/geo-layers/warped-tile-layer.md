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

##### `_meshResolution` (number, optional) {#_meshresolution}

- Default: `16`

Warp grid cells per tile edge. Vertices are exact; between them the GPU interpolates linearly.
The default is sub-pixel (≤0.15 px) for UTM-class CRSs even at continental zooms; raise it only
for unusually curved custom CRSs.

## Quality and performance envelope

- Warp is exact at grid vertices at any view scale (full CRS transform on CPU, float64, with
  origin-relative float32 attributes for GPU precision).
- Hairline seams can appear at tile borders (linear texture filtering, no gutters), and
  momentary cracks between zoom levels while children load (`best-available` refinement shows
  the parent underneath). Accepted tradeoffs of client-side warping.
- Source level matches ground resolution at the view center; across very wide views the
  effective source resolution drifts by Mercator's `cos(latitude)` factor.
- Views crossing the antimeridian are not supported.
