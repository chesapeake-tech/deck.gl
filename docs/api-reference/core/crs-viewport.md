# CRSViewport (Experimental)

The `CRSViewport` class takes map view states (`latitude`, `longitude`, `zoom`, `pitch`, `bearing` etc.), and performs projections between world and screen coordinates in an arbitrary projected coordinate reference system (CRS), instead of Web Mercator.

## Usage

The `CRSViewport` is created under the hood by a [MapView](./map-view.md) whenever its [`crs`](./map-view.md#crs) prop is set to anything other than `'EPSG:3857'`.

Common space is the CRS plane: the CRS's own units, offset so that the extent minimum sits at the origin, and scaled so the extent width maps to a 512-unit world at zoom `0` — the same convention `WebMercatorViewport` uses for Web Mercator meters. Because zoom is defined relative to each CRS's own extent, it is **extent-relative** rather than universally ground-comparable — see [Zoom is extent-relative](#zoom-is-extent-relative) below.

```js
import proj4 from 'proj4';
import {_CRSViewport as CRSViewport} from '@deck.gl/core';

const converter = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');

const viewport = new CRSViewport({
  width: 600,
  height: 400,
  crs: {
    code: 'EPSG:32618',
    transform: {
      forward: lnglat => converter.forward(lnglat),
      inverse: xy => converter.inverse(xy)
    },
    // UTM zone 18N's WGS84 extent - simpler to find than the projected extent
    extentGeographic: [-78, 0, -72, 84],
    units: 'meters'
  },
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
* **`maxBounds` is not supported with a non-Mercator `crs`.** `MapController` converts `maxBounds` via Web Mercator world coordinates, so with a CRS view it produces an incorrect constraint region rather than the intended geographic bounds.
* **`MapController` normalization uses Web Mercator math.** `MapController.applyConstraints` normalizes view state using Web Mercator world coordinates, which with a CRS view would snap the view toward the equator on zoom-out and clamp zoom-out to `log2(viewportHeight/512)`, making the map appear to vanish. `MapView` therefore defaults the controller's `normalize` option to `false` for non-Mercator `crs` (an explicit `controller: {normalize: ...}` takes precedence). Opting back in to `normalize: true` with a non-Mercator `crs` reintroduces the incorrect Mercator constraints; a proper fix delegating this math to the viewport is future work.
* **`FlyToInterpolator` interpolates in Mercator world coordinates.** With a CRS view, the transition's destination view state is still correct, but the pacing of the transition (how the camera eases toward it) may be slightly off since the interpolation path itself is computed in Mercator space.

### Known not to work yet (Phase 2/3 scope)

* **`TileLayer`** supports CRS views via the [`tileMatrixSet` prop](../geo-layers/tile-layer.md#tilematrixset) (OGC TileMatrixSet indexing). Without it, `TileLayer` still assumes the Web Mercator tile pyramid.
* Web-Mercator raster basemaps (OSM, Esri) render in CRS views via the experimental
  [`_WarpedTileLayer`](../geo-layers/warped-tile-layer.md) (client-side triangulated
  reprojection). `MVTLayer` and `_WMSLayer` are not yet CRS-aware.
* **`TerrainLayer`** renders CRS-native tiled elevation sources (set
  [`tileMatrixSet`](../geo-layers/tile-layer.md#tilematrixset)) correctly in CRS views;
  warping a public Web-Mercator terrain-RGB source (no `tileMatrixSet`) is not supported.
* **`TerrainExtension`** — its anchor math assumes a Mercator viewport.

## Source

[modules/core/src/viewports/crs-viewport.ts](https://github.com/visgl/deck.gl/blob/master/modules/core/src/viewports/crs-viewport.ts)
