# CRSViewport (Experimental)

The `CRSViewport` class takes map view states (`latitude`, `longitude`, `zoom`, `pitch`, `bearing` etc.), and performs projections between world and screen coordinates in an arbitrary projected coordinate reference system (CRS), instead of Web Mercator.

## Usage

The `CRSViewport` is created under the hood by a [MapView](./map-view.md) whenever its [`crs`](./map-view.md#crs) prop is set to anything other than `'EPSG:3857'`.

Common space is the CRS plane: the CRS's own units, offset so that the extent minimum sits at the origin, and scaled so the extent width maps to a 512-unit world at zoom `0` — the same convention `WebMercatorViewport` uses for Web Mercator meters. Because zoom is defined relative to each CRS's own extent, it is **extent-relative** rather than universally ground-comparable — see [Zoom is extent-relative](#zoom-is-extent-relative) below.

```js
import proj4 from 'proj4';
import {_CRSViewport as CRSViewport, _createProj4CRS as createProj4CRS} from '@deck.gl/core';

const converter = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');

const viewport = new CRSViewport({
  width: 600,
  height: 400,
  // Builds the CRSDefinition from the proj4 converter, so it doesn't need to be
  // hand-written - see `_createProj4CRS` below.
  crs: createProj4CRS({
    code: 'EPSG:32618',
    converter,
    // UTM zone 18N's WGS84 extent - simpler to find than the projected extent
    extentGeographic: [-78, 0, -72, 84],
    units: 'meters'
  }),
  longitude: -75.6,
  latitude: 39.9,
  zoom: 10
});

viewport.project([-75.6, 39.9]);
// [300, 200]
```

## Constructor

```js
new CRSViewport({width, height, crs, longitude, latitude, zoom, pitch, bearing});
```

Parameters:

* `opts` (object) - CRS viewport options

  + `crs` (CRSDefinition | string) - Coordinate reference system to render in. Either `'EPSG:4326'` (the only string built in) or a `CRSDefinition` object:
    - `code` (string) - Identifier, e.g. `'EPSG:32618'`. Used for viewport equality checks and debugging.
    - `transform` (object) - WGS84 degrees ↔ CRS units:
      + `forward(lnglat: [number, number]): [number, number]` - Projects `[longitude, latitude]` in WGS84 degrees to `[x, y]` in CRS units.
      + `inverse(xy: [number, number]): [number, number]` - Unprojects `[x, y]` in CRS units to `[longitude, latitude]` in WGS84 degrees.
    - `extent` ([number, number, number, number], optional) - `[minX, minY, maxX, maxY]` valid bounds in CRS units. Defines the common-space world scale.
    - `extentGeographic` ([number, number, number, number], optional) - `[west, south, east, north]` valid bounds in WGS84 degrees, as an alternative to `extent` for CRSs where a geographic bbox is at hand but the projected extent is not. Derived into a projected extent by densifying the boundary (~8 samples per edge) through `transform.forward` and taking the bounding box of the finite results — an approximation of the true (possibly curved) projected boundary, most accurate for the roughly-rectangular boundaries typical of UTM-class zones. Exactly one of `extent`/`extentGeographic` should be provided; if both are given, `extent` is used.
    - `units` ('meters' | 'degrees', optional) - CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default `'meters'`.
  + `id` (string, optional) - Name of the viewport.
  + `x` (number, optional) - Left offset from the canvas edge, in pixels.
  + `y` (number, optional) - Top offset from the canvas edge, in pixels.
  + `width` (number, optional) - Viewport width in pixels.
  + `height` (number, optional) - Viewport height in pixels.

  map view state arguments:

  + `longitude` (number, optional) - Longitude of the view center, in degrees.
  + `latitude` (number, optional) - Latitude of the view center, in degrees.
  + `zoom` (number, optional) - Zoom level. Default `0`.
  + `pitch` (number, optional) - Tilt of the camera in degrees. Default `0`.
  + `bearing` (number, optional) - Heading of the camera in degrees. `0` is CRS grid-north up. Default `0`.
  + `position` (number[], optional) - Viewport center offsets from lng, lat, in meters.

  projection matrix arguments:

  + `altitude` (number, optional) - Camera altitude relative to the viewport height, used to control the FOV. Default `1.5`.
  + `fovy` (number, optional) - Camera fovy in degrees. If provided, overrides `altitude`.
  + `orthographic` (boolean, optional) - Whether to create an orthographic or perspective projection matrix. Default `false`.
  + `nearZMultiplier` (number, optional) - Scaler for the near plane, 1 unit equals to the height of the viewport. Default `0.1`.
  + `farZMultiplier` (number, optional) - Scaler for the far plane, 1 unit equals to the distance from the camera to the edge of the screen. Default `1.01`.
  + `nearZ` (number, optional) - Optionally override the near plane position.
  + `farZ` (number, optional) - Optionally override the far plane position.
  + `padding` (object, optional) - Padding around the viewport, in pixels.

Remarks:

* `crs` and its `extent` (resolved from `extentGeographic` first, if `extent` is not given) are validated on construction: the extent must be `[minX, minY, maxX, maxY]` with positive width and height, and the transform must round-trip at the extent center. An invalid extent, a degenerate or under-sampled `extentGeographic` derivation, or a non-finite round-trip throws.
* The view center is clamped into the CRS `extent` on construction, since an out-of-domain center can produce non-finite results from the transform (for example, panning past the edge of a UTM zone).
* `latitude`/`longitude` remain in WGS84 degrees regardless of `crs`, so `{longitude, latitude, zoom, bearing, pitch}` view state is portable across CRSs — switching `crs` on a `MapView` only requires changing that one prop. Zoom's *ground* meaning does not carry over unchanged, though: it is extent-relative, so the same `zoom` number can represent a very different ground scale after the switch. See [Zoom is extent-relative](#zoom-is-extent-relative) below for the scale-preserving conversion.

Inherits all [Viewport methods](./viewport.md#methods).

## `_createProj4CRS`

```js
import {_createProj4CRS as createProj4CRS} from '@deck.gl/core';

createProj4CRS(options: CreateProj4CRSOptions): CRSDefinition;
```

Builds a `CRSDefinition` from a proj4-style converter, so it doesn't have to be hand-written
around every `crs`. `@deck.gl/core` does not bundle a projection library — `converter` is
supplied by the caller, so this stays a zero-dependency helper.

Parameters (`CreateProj4CRSOptions`):

* `code` (string) - Identifier, e.g. `'EPSG:32618'`. Passed through to `CRSDefinition#code`.
* `converter` (object) - A proj4-style converter. Either naming convention is accepted and
  normalized to `CRSDefinition#transform`:
  + proj4's own `Converter` shape: `forward(lnglat): [x, y]` / `inverse(xy): [lng, lat]`.
  + `@math.gl/proj4`'s `Proj4Projection` shape: `project(lnglat): [x, y]` / `unproject(xy): [lng, lat]`.
* `extent` ([number, number, number, number], optional) - Passed through to
  `CRSDefinition#extent`. Exactly one of `extent`/`extentGeographic` is required.
* `extentGeographic` ([number, number, number, number], optional) - Passed through to
  `CRSDefinition#extentGeographic` untouched — `createProj4CRS` does no derivation itself;
  the projected extent is still derived from it lazily, by `CRSViewport`/`normalizeCRS`, the
  same as when `extentGeographic` is set by hand.
* `units` ('meters' | 'degrees', optional) - Passed through to `CRSDefinition#units`.

Returns a plain `CRSDefinition` object — anything that accepts one (`MapView({crs})`,
`CRSViewport({crs})`) accepts `createProj4CRS`'s result directly.

## Zoom is extent-relative

At zoom level `z`, the CRS's `extent` always spans `512 * 2^z` pixels in common space — that's the common-space convention above, applied literally. What that means on the ground depends on how big the extent is:

* `'EPSG:4326'`'s extent is the full 360°×180° lat/lng box, which is angularly comparable to Web Mercator's whole-world extent, so the same zoom number is roughly ground-comparable between the two.
* A projected CRS with a much smaller extent — a single UTM zone spans a few hundred kilometers, not the whole globe — reaches the same zoom number at a much more zoomed-in ground scale. Zoom `10` in a UTM viewport is not the same ground scale as zoom `10` in Web Mercator or `'EPSG:4326'`.

To switch between viewports (or CRSs) while preserving ground scale, adjust zoom by the ratio of `distanceScales.unitsPerMeter`:

```js
const newZoom =
  zoom + Math.log2(sourceViewport.distanceScales.unitsPerMeter[0] / targetViewport.distanceScales.unitsPerMeter[0]);
```

`MapController`'s default `minZoom: 0, maxZoom: 20` are calibrated for Web Mercator's world-sized extent. Applications using a projected CRS with a smaller extent should set their own `minZoom`/`maxZoom` to match the extent's actual scale.

## Methods

Inherits all methods from [Viewport](./viewport.md).

#### `project` {#project}

Projects world coordinates to pixel coordinates on screen. Same signature as [`WebMercatorViewport#project`](./web-mercator-viewport.md#project). Exact — computed from the injected `transform.forward`, with no linearization error.

#### `unproject` {#unproject}

Unprojects pixel coordinates on screen into world coordinates. Same signature as [`WebMercatorViewport#unproject`](./web-mercator-viewport.md#unproject). Exact — computed from the injected `transform.inverse`, with no linearization error.

#### `projectFlat` / `unprojectFlat` {#projectflat-unprojectflat}

Projects/unprojects a `[longitude, latitude]` to/from common space, via `transform.forward`/`transform.inverse`. Because these CPU-side methods call the injected transform directly, `project`, `unproject`, `panByPosition`, `fitBounds`, and picking/tooltip queries are all exact in any CRS.

This is distinct from how `COORDINATE_SYSTEM.LNGLAT` layer data is projected on the GPU: the vertex shader approximates the transform around the view center with a second-order (quadratic) Taylor expansion — a local affine term (the view-center-relative Jacobian returned by `getCRSJacobianAtOrigin`) plus a curvature term (the Hessian returned by `getCRSHessianAtOrigin`) — rather than calling the transform per vertex. That approximation is exact for `'EPSG:4326'` (whose transform is itself linear, so the Hessian is zero), sub-pixel at any practical zoom for survey/city/regional scales for projected CRSs, and degrades only at continental extents in strongly curved projections — where the remaining error is now cubic in distance from the view center rather than quadratic. For example, in UTM 18N at 1,200km from the view center (the distance from southern New England to the Great Lakes), the affine-only approximation misregisters by roughly 100km; adding the quadratic correction reduces that to about 1-2km, ~1-2 px at the zoom that frames such an extent.

#### `getCRSJacobianAtOrigin` {#getcrsjacobianatorigin}

Returns the column-major 2×2 Jacobian of the lnglat-to-common transform at the given origin, in common units per degree, by finite differences of `transform.forward`. Uploaded as a shader uniform to drive the local affine (first-order) term of the approximation described above.

Parameters:

* `origin` (number[]) - `[longitude, latitude]` at which to evaluate the Jacobian.

Returns:

* `[dX/dlng, dY/dlng, dX/dlat, dY/dlat]` - a 4-element array representing the 2×2 Jacobian.

#### `getCRSHessianAtOrigin` {#getcrshessianatorigin}

Returns the second-order (quadratic) coefficients of the lnglat-to-common transform at the given origin, per output component, in common units per degree². Uploaded as shader uniforms (`crsUnitsPerDegree2X`/`crsUnitsPerDegree2Y`) to drive the quadratic correction term described above: `commonXY = center + J·Δ + ½·H(Δ)`, where `Δ` is the offset from the origin in degrees. Estimated by second-order central finite differences of `transform.forward`, with a larger step than the Jacobian's (second differences amplify floating-point rounding more than first differences do). Falls back to all-zero coefficients — degrading gracefully to the first-order-only approximation — if the transform is non-finite anywhere in the finite-difference stencil (e.g. near the domain edge of the CRS).

Parameters:

* `origin` (number[]) - `[longitude, latitude]` at which to evaluate the Hessian.

Returns:

* `{x: [number, number, number], y: [number, number, number]}` - for each common-space output component, `[d²/dlng², d²/(dlng·dlat), d²/dlat²]` in common units per degree².

#### `getConvergence` {#getconvergence}

Returns the standard surveying grid convergence angle (γ), in degrees, at the given
`[longitude, latitude]` position (the view center by default). `bearing: 0` on a `CRSViewport`
points grid north up - not necessarily true (geographic) north, since a projected CRS's grid
lines and the local meridian generally diverge away from the CRS's line(s) of true scale (e.g.
a UTM zone's central meridian). `getConvergence` returns that divergence so applications (for
example, a survey-oriented compass widget) can show both norths.

Sign convention (matches the surveying-standard relation `True Azimuth = Grid Azimuth + γ`,
e.g. Snyder's UTM convergence formula and the National Geodetic Survey's definition of
convergence as "from true meridian to grid meridian"): **positive means grid north lies
clockwise (east) of true north; equivalently, true north lies counterclockwise (west) of grid
north.** For example, east of a UTM zone's central meridian in the Northern Hemisphere, `γ` is
positive (grid north leans east of true north there); west of it, negative; `0` on the central
meridian and everywhere in `'EPSG:4326'` (whose grid is always aligned with the graticule).

Parameters:

* `lnglat` (number[], optional) - `[longitude, latitude]` at which to evaluate the
  convergence. Defaults to the viewport's own `[longitude, latitude]` center.

Returns:

* `number` - the convergence angle in degrees, signed per the convention above.

```js
const convergence = viewport.getConvergence();
// Rotate a "true north" needle relative to the viewport's grid-north-relative bearing:
const trueNorthScreenRotation = -(viewport.bearing + convergence);
```

#### `panByPosition` {#panbyposition}

Returns a new longitude and latitude that keeps a world coordinate at a given screen pixel. Exact, via `projectFlat`/`unprojectFlat`.

Parameters:

* `coords` (number[]) - `[longitude, latitude]` world coordinate to keep fixed.
* `pixel` (number[]) - `[x, y]` screen pixel position where the coordinate should remain.

Returns:

* An object with `{longitude, latitude}` representing the new viewport center.

#### `fitBounds` {#fitbounds}

Returns a new viewport that fits around the given lnglat bounding box. The fitted viewport uses the current viewport's `width` and `height`. Only supports non-perspective mode.

Parameters:

* `bounds` (number[2][2]) - Bounding box in `[[west, south], [east, north]]`, in degrees.
* `opts` (object)
  + `padding` (number, optional) - The amount of padding in pixels to add to the given bounds. Default `0`.

Returns:

* New `CRSViewport` fit around the given bounding box, using the same `crs`, `width`, and `height` as the original.

## Limitations

* **No repeated worlds.** `CRSViewport` has no `repeat` option: a projected CRS is a finite plane, not a wrapping globe, so there is no analog of `WebMercatorViewport`'s low-zoom world repetition.
* **`COORDINATE_SYSTEM.CARTESIAN` positions must be pre-normalized to common space.** Unlike `COORDINATE_SYSTEM.LNGLAT`, Cartesian data is not run through the CRS transform or its linear approximation — it is assumed to already be in the viewport's common-space units.
* **`COORDINATE_SYSTEM.METER_OFFSETS` and `COORDINATE_SYSTEM.LNGLAT_OFFSETS` apply the full Jacobian at `coordinateOrigin`, not just at the view center.** Offsets are rotated and scaled by the CRS grid's local Jacobian evaluated at each layer's own `coordinateOrigin` (its off-diagonal terms encode grid convergence — the local rotation between the CRS grid and true north), matching the same first-order approximation `COORDINATE_SYSTEM.LNGLAT` gets around the view center. This is still a *local* (single-origin) linear approximation: it has no second-order (Hessian) correction and no per-vertex re-evaluation, so offsets spanning a large distance from their `coordinateOrigin` accumulate curvature error as that distance grows — for offsets beyond roughly 100km from their anchor, consider splitting the data across multiple `coordinateOrigin`s closer to each cluster, the same way you would for `WebMercatorViewport`'s `METER_OFFSETS`.
* **Second-order distance-scale corrections are zero in CRS mode.** `unitsPerDegree2`/`unitsPerMeter2` (the corrections `WebMercatorViewport` uses to account for Mercator's latitude-dependent scale change) are zero for `PROJECTION_MODE.CRS`, so tall `METER_OFFSETS` geometries lose the y-axis correction Mercator applies.
* **Data outside the CRS domain renders at linearized positions.** The shader-side affine approximation has no domain check; layer data whose `COORDINATE_SYSTEM.LNGLAT` positions fall outside the CRS's valid extent is rendered wherever the linear approximation places it, rather than erroring.
* **The view center is clamped into the CRS extent.** Panning the view center out of the CRS's valid domain clamps it back inside, so that the projected center never receives a non-finite result from the transform.
* **`FlyToInterpolator` interpolates in Mercator world coordinates.** With a CRS view, the transition's destination view state is still correct, but the pacing of the transition (how the camera eases toward it) may be slightly off since the interpolation path itself is computed in Mercator space.

### `MapController` constraints in CRS views

`MapController`'s `normalize` constraints (longitude/bearing wrapping, world-fit min zoom, `maxBounds` clamp) and `maxBounds` itself are computed through the current viewport rather than hardcoded Web Mercator math, so both work the same way with a non-Mercator `crs` as they do with Web Mercator:

* **`maxBounds` corners are still given as `[[west, south], [east, north]]` in degrees** — the same shape as for Web Mercator — and are projected through the view's `CRSViewport` (its exact `transform`, not a linear approximation) into an axis-aligned box in the CRS's own common space. A corner outside the CRS's valid domain (including the library's own default whole-world bounds, `[[-Infinity, -90], [Infinity, 90]]`) is clamped into the domain first, the same way the view center is (see above), and a non-finite component (as in that default) resolves to the CRS extent's own edge in that direction — a projected CRS is a finite, non-repeating plane (see "No repeated worlds" above), so "unconstrained" there means "as far as the extent goes," not literally unbounded.
* **Zoom-out with the default `normalize: true` clamps to the CRS extent's own fit**, not Web Mercator's fixed `512`-unit world height: past the zoom where the extent's width/height fills the viewport, the view center is pinned near the extent's own center rather than snapping toward `(0, 0)` (Web Mercator's equator/prime-meridian origin, which has no special meaning in another CRS).
* `MapView` no longer defaults the controller's `normalize` option to `false` for non-Mercator `crs` — it passes `controller` options straight through, same as for Web Mercator.

### Known not to work yet (Phase 2/3 scope)

* **`TileLayer`** supports CRS views via the [`tileMatrixSet` prop](../geo-layers/tile-layer.md#tilematrixset) (OGC TileMatrixSet indexing). Without it, `TileLayer` still assumes the Web Mercator tile pyramid.
* Web-Mercator raster basemaps (OSM, Esri) render in CRS views via the experimental
  [`_WarpedTileLayer`](../geo-layers/warped-tile-layer.md) (client-side triangulated
  reprojection).
* **`MVTLayer`** renders correctly in CRS views for both real-world source shapes: a classic
  Mercator-pyramid vector-tile source (no `tileMatrixSet` — the common case, e.g. Esri's "Ocean
  Reference" service) is automatically reprojected via `MercatorCRSTileset2D`; a CRS-native
  tiled source (set [`tileMatrixSet`](../geo-layers/tile-layer.md#tilematrixset)) uses
  `_CRSTileset2D`. Both go through the same `wgs84`-decode route `GlobeView` already uses; the
  `binary` typed-array fast path is not available in CRS views (same cost already accepted for
  Globe). See [`MVTLayer`'s CRS views doc](../geo-layers/mvt-layer.md#crs-views).
* **`_WMSLayer`** is not yet CRS-aware.
* **`TerrainLayer`** renders CRS-native tiled elevation sources (set
  [`tileMatrixSet`](../geo-layers/tile-layer.md#tilematrixset)) correctly in CRS views;
  warping a public Web-Mercator terrain-RGB source (no `tileMatrixSet`) is not supported.
* **`TerrainExtension`** — its anchor math assumes a Mercator viewport.
* **Aggregation layers** (`@deck.gl/aggregation-layers`) work in CRS views:
  `GridLayer`/`HexagonLayer`/`ScreenGridLayer`/`ContourLayer` bin/aggregate correctly
  (cell/radius sizing already goes through the CRS-correct `distanceScales`). `HeatmapLayer`
  also works correctly by default, but if an app explicitly overrides its `coordinateSystem`
  prop to `'lnglat'`, its bounds-clipping guard hardcodes Web Mercator's ±85.051129° latitude
  singularity as a constant, which is meaningless for another CRS's own valid domain (a UTM
  zone's domain has nothing to do with that latitude) — not yet fixed. See the CRS
  aggregation-layer audit spec (`docs/superpowers/specs/2026-07-05-crs-aggregation-audit.md`)
  for the full per-layer trace.

### Multi-view: sharing a layer across a Mercator view and a CRS view

deck.gl layers are shared across `views`: a single layer instance is drawn once per `View`,
using that view's own `Viewport`, in one `Deck`. This already comes with a general caveat for
tile-fetching/aggregating layers — see [Rendering Layers in Multiple
Views](/docs/developer-guide/views.md#rendering-layers-in-multiple-views), which recommends
duplicating the layer per view with `layerFilter` for `TileLayer`, `MVTLayer`, `HeatmapLayer`,
and `ScreenGridLayer`. CRS support does not remove that caveat — it raises the stakes for it, and
adds one CRS-specific instance of it (`_MapLibreStyleLayer`'s zoom-dependent styling). This is
because sublayer *generation* for these layers (`renderLayers()`/`renderSubLayers()`, tile
selection, `getTileData()`) runs once per update cycle against a single, shared
`context.viewport` — not once per viewport a frame draws into (only per-vertex GPU projection is
re-done per viewport at draw time; see the [multi-view mixed-projection audit
report](https://github.com/visgl/deck.gl/blob/feat/crs-mapview/docs/superpowers/specs/2026-07-06-crs-multiview-audit.md)
for the full trace). Concretely, if you share one of these layer instances across a Mercator view
and a CRS view (or live-swap a single view's `crs` on an existing instance):

* **`TileLayer`/`MVTLayer` with a `tileMatrixSet` (CRS-native tiling) or an `_WarpedTileLayer`**
  fail loudly and safely: `CRSTileset2D`/`MercatorCRSTileset2D` throw an explicit
  `... requires a CRS view — set the crs prop on MapView` error the moment the shared context
  lands on a non-CRS viewport. deck.gl isolates the error to that one layer (`layer.raiseError`),
  so the rest of the scene keeps rendering — but the layer itself stops updating in whichever
  view doesn't have the CRS it needs, until the shared context swings back. It is not
  deduplicated, so it can re-fire on every update cycle while the mismatch persists (e.g. while
  panning).
* **`MVTLayer` without a `tileMatrixSet`** (the common classic Mercator-pyramid vector-tile
  source, auto-routed through `MercatorCRSTileset2D` for a CRS view) does not throw, because both
  branches are valid tilesets — but tile selection, and the `binary`/`wgs84`-decode routing
  (`usesFeatureRoute`), is computed once for whichever viewport is currently "active" and shared
  by every view drawing the layer. The other view silently gets tiles selected for the wrong
  camera/zoom.
* **`_MapLibreStyleLayer`** evaluates zoom-dependent style expressions and `minzoom`/`maxzoom`
  gating, and keys its per-tile sublayer cache, on `mercatorEquivalentZoom(context.viewport)` —
  also computed once per update and shared. A CRS view's `mercatorEquivalentZoom` can differ from
  a same-nominal-zoom Mercator view's by 5+ zoom levels (a small-extent CRS like a UTM zone
  reaches the same zoom *number* at a far more zoomed-in ground scale), so whichever view isn't
  "active" gets label/line/fill styling — and `minzoom`/`maxzoom` gating — evaluated for the
  wrong view's ground scale.
* **Plain geometry layers are unaffected.** `GeoJsonLayer` and friends (`PathLayer`,
  `SolidPolygonLayer`, `ScatterplotLayer`, ...) never read `context.viewport` while deciding what
  to build; projection is entirely a per-viewport, per-vertex GPU operation at draw time. Sharing
  these across a Mercator view and a CRS view works exactly as it does for any other pair of
  views.

**Recommendation:** do not share a `TileLayer`/`MVTLayer`/`_WarpedTileLayer`/
`_MapLibreStyleLayer` instance across views with different projections (Mercator vs. CRS, or two
different CRS `crs`). Create one instance per view and use `layerFilter` to route each to its own
view, per the general multi-view guidance linked above. This is a known architectural limitation
(sublayer generation is not currently per-viewport) rather than something CRS support introduces
from scratch, and is tracked as future-work for the upstream RFC rather than special-cased here.

## Source

[modules/core/src/viewports/crs-viewport.ts](https://github.com/visgl/deck.gl/blob/master/modules/core/src/viewports/crs-viewport.ts)
