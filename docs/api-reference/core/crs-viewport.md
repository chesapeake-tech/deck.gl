# CRSViewport (Experimental)

The `CRSViewport` class takes map view states (`latitude`, `longitude`, `zoom`, `pitch`, `bearing` etc.), and performs projections between world and screen coordinates in an arbitrary projected coordinate reference system (CRS), instead of Web Mercator.

## Usage

The `CRSViewport` is created under the hood by a [MapView](./map-view.md) whenever its [`crs`](./map-view.md#crs) prop is set to anything other than `'EPSG:3857'`.

Common space is the CRS plane: the CRS's own units, offset so that the extent minimum sits at the origin, and scaled so the extent width maps to a 512-unit world at zoom `0` — the same convention `WebMercatorViewport` uses for Web Mercator meters, so zoom levels behave consistently across CRSs.

```js
import proj4 from 'proj4';
import {CRSViewport} from '@deck.gl/core';

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
    extent: [166021.44, 0, 833978.56, 9329005.18],
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
    - `extent` ([number, number, number, number]) - `[minX, minY, maxX, maxY]` valid bounds in CRS units. Defines the common-space world scale.
    - `units` ('meters' | 'degrees', optional) - CRS axis unit. Relates elevation (meters) and distance scales to CRS units. Default `'meters'`.
  + `id` (string, optional) - Name of the viewport.
  + `x` (number, optional) - Left offset from the canvas edge, in pixels.
  + `y` (number, optional) - Top offset from the canvas edge, in pixels.
  + `width` (number, optional) - Viewport width in pixels.
  + `height` (number, optional) - Viewport height in pixels.

  map view state arguments:

  + `longitude` (number, optional) - Longitude of the view center, in degrees.
  + `latitude` (number, optional) - Latitude of the view center, in degrees.
  + `zoom` (number, optional) - Zoom level.
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

* `crs` and its `extent` are validated on construction: the extent must be `[minX, minY, maxX, maxY]` with positive width and height, and the transform must round-trip at the extent center. An invalid extent or a non-finite round-trip throws.
* The view center is clamped into the CRS `extent` on construction, since an out-of-domain center can produce non-finite results from the transform (for example, panning past the edge of a UTM zone).
* `latitude`/`longitude` remain in WGS84 degrees regardless of `crs`, so `{longitude, latitude, zoom, bearing, pitch}` view state is portable across CRSs — switching `crs` on a `MapView` is a one-prop change.

Inherits all [Viewport methods](./viewport.md#methods).

## Methods

Inherits all methods from [Viewport](./viewport.md).

#### `project` {#project}

Projects world coordinates to pixel coordinates on screen. Same signature as [`WebMercatorViewport#project`](./web-mercator-viewport.md#project). Exact — computed from the injected `transform.forward`, with no linearization error.

#### `unproject` {#unproject}

Unprojects pixel coordinates on screen into world coordinates. Same signature as [`WebMercatorViewport#unproject`](./web-mercator-viewport.md#unproject). Exact — computed from the injected `transform.inverse`, with no linearization error.

#### `projectFlat` / `unprojectFlat` {#projectflat-unprojectflat}

Projects/unprojects a `[longitude, latitude]` to/from common space, via `transform.forward`/`transform.inverse`. Because these CPU-side methods call the injected transform directly, `project`, `unproject`, `panByPosition`, `fitBounds`, and picking/tooltip queries are all exact in any CRS.

This is distinct from how `COORDINATE_SYSTEM.LNGLAT` layer data is projected on the GPU: the vertex shader uses a local affine approximation (the view-center-relative Jacobian returned by `getCRSJacobianAtOrigin`) rather than calling the transform per vertex. That approximation is exact for `'EPSG:4326'`, sub-pixel at survey/city scales for projected CRSs, and degrades only for continental extents in strongly curved projections.

#### `getCRSJacobianAtOrigin` {#getcrsjacobianatorigin}

Returns the column-major 2×2 Jacobian of the lnglat-to-common transform at the given origin, in common units per degree, by finite differences of `transform.forward`. Uploaded as a shader uniform to drive the local affine approximation described above.

Parameters:

* `origin` (number[]) - `[longitude, latitude]` at which to evaluate the Jacobian.

Returns:

* `[dX/dlng, dY/dlng, dX/dlat, dY/dlat]` - a 4-element array representing the 2×2 Jacobian.

#### `panByPosition` {#panbyposition}

Returns a new longitude and latitude that keeps a world coordinate at a given screen pixel. Exact, via `projectFlat`/`unprojectFlat`.

Parameters:

* `coords` (number[]) - `[longitude, latitude]` world coordinate to keep fixed.
* `pixel` (number[]) - `[x, y]` screen pixel position where the coordinate should remain.

Returns:

* An object with `{longitude, latitude}` representing the new viewport center.

#### `fitBounds` {#fitbounds}

Returns a new viewport that fits around the given lnglat bounding box. Viewport `width` and `height` must be either set or provided as options. Only supports non-perspective mode.

Parameters:

* `bounds` (number[2][2]) - Bounding box in `[[west, south], [east, north]]`, in degrees.
* `opts` (object)
  + `padding` (number, optional) - The amount of padding in pixels to add to the given bounds. Default `0`.

Returns:

* New `CRSViewport` fit around the given bounding box, using the same `crs`, `width`, and `height` as the original.

## Limitations

* **No repeated worlds.** `CRSViewport` has no `repeat` option: a projected CRS is a finite plane, not a wrapping globe, so there is no analog of `WebMercatorViewport`'s low-zoom world repetition.
* **`COORDINATE_SYSTEM.CARTESIAN` positions must be pre-normalized to common space.** Unlike `COORDINATE_SYSTEM.LNGLAT`, Cartesian data is not run through the CRS transform or its linear approximation — it is assumed to already be in the viewport's common-space units.
* **`COORDINATE_SYSTEM.METER_OFFSETS` uses diagonal (isotropic) scales.** Distance scales are derived from the magnitude of the Jacobian at the reference point, not its full 2×2 form, so meter offsets do not account for grid convergence (the local rotation between the CRS grid and true north).
* **Data outside the CRS domain renders at linearized positions.** The shader-side affine approximation has no domain check; layer data whose `COORDINATE_SYSTEM.LNGLAT` positions fall outside the CRS's valid extent is rendered wherever the linear approximation places it, rather than erroring.
* **The view center is clamped into the CRS extent.** Panning the view center out of the CRS's valid domain clamps it back inside, so that the projected center never receives a non-finite result from the transform.

## Source

[modules/core/src/viewports/crs-viewport.ts](https://github.com/visgl/deck.gl/blob/master/modules/core/src/viewports/crs-viewport.ts)
