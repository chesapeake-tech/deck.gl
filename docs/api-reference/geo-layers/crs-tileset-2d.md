# CRSTileset2D (Experimental)

`_CRSTileset2D` is a [Tileset2D](./tile-layer.md#tileset2d) implementation that indexes tiles
from an [OGC TileMatrixSet](https://docs.ogc.org/is/17-083r4/17-083r4.html) against a CRS view
(a `MapView` with a non-Mercator [`crs`](../core/map-view.md#crs)), instead of the Web Mercator
(OSM) tile pyramid. Tile bounds and viewport visibility are computed in the view's CRS units
rather than Web Mercator world coordinates.

`TileLayer` selects `_CRSTileset2D` automatically — passing
[`tileMatrixSet`](./tile-layer.md#tilematrixset) is normally the only thing an application needs
to do:

```js
import {TileLayer} from '@deck.gl/geo-layers';

const layer = new TileLayer({
  data: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/.../default/500m/{tm}/{y}/{x}.jpeg',
  tileMatrixSet: myTileMatrixSet, // in the view's CRS
  maxZoom: 7
});
// rendered with: new MapView({crs: 'EPSG:4326'})
```

`_CRSTileset2D` itself is only relevant when writing a custom `TilesetClass` that needs
CRS-aware indexing as a starting point — for example, to layer a custom refinement rule on top
of the CRS/TMS tile math:

```js
import {_CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';

class MyTileset2D extends CRSTileset2D {
  getTileIndices(opts) {
    const indices = super.getTileIndices(opts);
    // ... custom filtering/augmentation
    return indices;
  }
}

const layer = new TileLayer({
  TilesetClass: MyTileset2D,
  tileMatrixSet: myTileMatrixSet,
  data: '...'
});
```

## Constructor

```js
import {_CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';

new CRSTileset2D({...tileset2DProps, tileMatrixSet});
```

Accepts all [`Tileset2D`](./tile-layer.md#tileset2d) constructor options, plus:

* `tileMatrixSet` (`TileMatrixSet`) - **required**. The OGC TileMatrixSet describing the tile
  grid, in the view's CRS. Throws if omitted.

A `TileMatrixSet` is `{id?, crs?, tileMatrices}`, where each `tileMatrices` entry is `{id,
cellSize (or scaleDenominator), pointOfOrigin, cornerOfOrigin?, tileWidth, tileHeight,
matrixWidth, matrixHeight}` — see [TileLayer's `tileMatrixSet`
prop](./tile-layer.md#tilematrixset) for the full format, a worked NASA GIBS example, and the
`{z}`/`{tm}` URL template tokens.

**Important — always prefer an explicit `cellSize`.** When a tile matrix omits `cellSize`, it
is derived from `scaleDenominator` using the OGC 0.28mm/px convention, which some published
registries (e.g. CanadianNAD83_LCC) do not actually follow — see [TileLayer's `cellSize`
warning](./tile-layer.md#tilematrixset) for the failure mode (tiles fetch successfully but
render blank or off-grid) and why the registry's own `cellSize`, copied verbatim, is safer than
trusting `scaleDenominator`.

Notes:

* A negative `minZoom` is clamped to `0` in `setOptions`. Tile matrix array positions start at
  `0`, and `getParentIndex` returns the root index unchanged once a walk reaches level `0`; a
  negative `minZoom` would make the base class's ancestor walk (`getTileZoom(index) >
  minZoom`) loop forever.

## Tile index and metadata

`getTileIndices` returns `CRSTileIndex` objects: `{x, y, z, tm}`, where `z` is the tile matrix's
**array position** (`0` = coarsest — matching `minZoom`/`maxZoom` semantics) and `tm` is the
matrix's own `id` string, for substituting the `{tm}` URL template token. The matrix level is
chosen by matching each level's `cellSize` (CRS units per pixel) against the viewport
resolution at the current zoom, then clamped into `[minZoom, maxZoom]` and the matrix's own
`[0, tileMatrices.length - 1]` range.

`getTileMetadata(index)` adds, per tile:

* `bbox` (`{west, south, east, north}`) - the tile's WGS84 lon/lat bounding box, computed by
  inverse-projecting the tile's CRS-unit corners. Tile grids may overflow the CRS extent (a
  GIBS level-0 tile spans 288°, for instance); the corners are inverse-projected unclamped so
  raster sublayers stretch imagery across the tile's *true* span. Only when a curved CRS's
  inverse is undefined that far outside the extent (a non-finite result) does a corner fall
  back to being clamped into the extent first.
* `boundsCRS` (`[minX, minY, maxX, maxY]`) - the exact tile rectangle in CRS units.
* `boundsCommon` (`[minX, minY, maxX, maxY]`) - the same rectangle in deck's common space
  (CRS units offset by the view's `extent` minimum and scaled by `commonUnitsPerCRSUnit`), for
  exact positioning of raster sublayers with `COORDINATE_SYSTEM.CARTESIAN`.

`getParentIndex` walks up one tile matrix level, re-deriving `{x, y, tm}` from the parent
matrix's grid at the child's center point (clamped to the parent matrix's bounds, since grids
can overflow the CRS extent unevenly between levels — a child's center can fall just outside
the parent matrix). At level `0` (the root), the index is returned unchanged.

## Limitations

* **Pitched views over-fetch at a single resolution.** The visible area is estimated as one
  axis-aligned box in CRS units — the viewport's four screen corners, unprojected and then
  forward-projected through `crs.transform` — at the one tile matrix level chosen for the
  whole view. There is no per-corner or far-field level of detail, so at high pitch, far-field
  tiles are fetched at the same (near-field) resolution as the rest of the view. If a screen
  corner unprojects to a non-finite lnglat (pointed past the horizon, or outside the CRS
  transform's domain), the fetch bounds widen to the CRS's full `extent` for that axis rather
  than silently shrinking — bounded by the tile matrix's own dimensions, but potentially a
  large over-fetch relative to what's actually on screen.
* **`minZoom` returns no tiles, rather than the whole grid, when the view is far above it.**
  Mirroring `TileLayer`'s Web Mercator path: if the level selected by viewport resolution is
  coarser than `minZoom` and no `extent` option bounds the fetch area, `getTileIndices` returns
  `[]` instead of clamping up to `minZoom` — clamping without an `extent` bound could otherwise
  request the entire tile matrix at that level.
* **Swapping the view's CRS flushes the tile cache without individual `onTileUnload` events.**
  Cached tiles carry metadata (`bbox`, `boundsCommon`) and a TMS normalized against the CRS in
  effect when they were created; both become meaningless the instant `MapView.crs` changes to
  a different CRS. `_CRSTileset2D` detects the CRS-code change and calls the base
  `Tileset2D.finalize()` to drop every cached tile — but `finalize()` aborts in-flight
  requests and clears the cache directly, without firing `onTileUnload` per tile. That's
  acceptable here because the entire cache is invalid, but an application tracking loaded
  tiles via `onTileLoad`/`onTileUnload` will not see per-tile unload events for tiles dropped
  by this flush (the same is true of `TileLayer`'s own `tileMatrixSet`-prop-change handling,
  which also calls `finalize()` directly).
* A mismatch between the `TileMatrixSet`'s stated `crs` and the view's `crs.code` (`crs` accepts
  a plain code like `'EPSG:32618'`, an OGC CRS URI or URN, or a TMS 2.0 `{uri}` object — see
  [TileLayer's `tileMatrixSet` prop](./tile-layer.md#tilematrixset)) logs a warning rather than
  throwing, once per distinct `(tileMatrixSet, view CRS)` combination — indexing still proceeds,
  which for a genuine mismatch commonly produces zero or nonsensical tiles rather than a clear
  error.

## Source

[modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts](https://github.com/visgl/deck.gl/blob/master/modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts)
