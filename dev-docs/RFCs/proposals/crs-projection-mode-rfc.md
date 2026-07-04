# RFC: Non-Web-Mercator CRS Support in MapView

* **Authors**: Adam
* **Date**: July 2026
* Status: **Draft**

Notes:
* See discussion [#6216](https://github.com/visgl/deck.gl/discussions/6216) and issue [#6217](https://github.com/visgl/deck.gl/issues/6217)
* Prior attempts: [#5607](https://github.com/visgl/deck.gl/issues/5607), [#6090](https://github.com/visgl/deck.gl/issues/6090); draft PR [#5504](https://github.com/visgl/deck.gl/pull/5504)
* See also the 2017 [Projection Mode Improvements RFC](./projection-mode-improvements-rfc.md), which first raised generic projection support

## Summary

This RFC proposes a `crs` prop on `MapView` that renders a geospatial view in an arbitrary
projected coordinate reference system (CRS) — not just Web Mercator (EPSG:3857) — while keeping
`MapView`'s existing `{longitude, latitude, zoom, bearing, pitch}` view state, controller, and
`COORDINATE_SYSTEM.LNGLAT` layer authoring model unchanged.

## Motivation

`MapView` is hardcoded to Web Mercator. Four projection modes (`WEB_MERCATOR`,
`WEB_MERCATOR_AUTO_OFFSET`, `GLOBE`, `IDENTITY`) flow from `Viewport.projectionMode` into GLSL
branches in the `project` shader module, but none of them can render a view in another CRS.

Two independent needs converge on the same gap:

* [Discussion #6216](https://github.com/visgl/deck.gl/discussions/6216) and
  [issue #6217](https://github.com/visgl/deck.gl/issues/6217) ask for native support for
  alternate geospatial CRSs, in particular displaying EPSG:4326 (plate carrée) tile services
  without a reprojecting proxy.
* Applications with survey-grade data in projected CRSs (UTM zones, NZTM, OSGB, NAD27/83 grids)
  currently work around this by rendering through `OrthographicView` plus CPU canvas-warping of
  basemap tiles, losing `MapView` semantics, basemap quality, and interaction performance.

This has been attempted before without landing: [#5607](https://github.com/visgl/deck.gl/issues/5607)
and [#6090](https://github.com/visgl/deck.gl/issues/6090) discuss the problem, and
[draft PR #5504](https://github.com/visgl/deck.gl/pull/5504) prototyped part of a solution. This
proposal generalizes both asks into a single mechanism: EPSG:4326 is just a CRS whose forward
transform happens to be the identity on degrees.

## Proposal

### `crs` prop and `CRSViewport`

`MapView` gains a `crs` prop:

```ts
new MapView({
  crs: {
    code: 'EPSG:32618',                     // identifier, used for caching/debug
    transform: {                             // WGS84 degrees ↔ CRS units
      forward: (lnglat: [number, number]) => [x, y],
      inverse: (xy: [number, number]) => [lng, lat]
    },
    extent: [minX, minY, maxX, maxY],        // CRS-unit bounds; defines world scale
    units: 'meters'                          // CRS axis unit; relates elevation and
                                              // distance scales to CRS units
  }
})
```

`crs` accepts a `CRSDefinition` object as above, or a string for the two built-ins: unset or
`'EPSG:3857'` selects today's `WebMercatorViewport` (zero behavior change); `'EPSG:4326'` selects
a built-in trivial (identity) transform. Any other string throws — there is no CRS registry
lookup, since transforms are always supplied by the caller.

`getViewportType()` on `MapView` returns a new `CRSViewport` when `crs` is set to anything other
than `'EPSG:3857'`, and `WebMercatorViewport` otherwise. `CRSViewport`:

* Defines common space as the CRS plane, offset by `extent`'s minimum corner and scaled so that
  `extent`'s width maps to deck.gl's 512-unit world at zoom `0` — the same convention
  `WebMercatorViewport` uses, so zoom levels stay meaningful across CRSs.
* Keeps `{longitude, latitude, zoom, bearing, pitch}` view state geographic, so `MapController`,
  transitions, and view-state persistence work unchanged, and switching `crs` is a one-prop
  change. The internal projected center is `transform.forward([longitude, latitude])`.
* Implements `projectFlat`/`unprojectFlat` (and therefore `project`, `unproject`, `panByPosition`,
  `fitBounds`, picking, and tooltips) via the injected transform directly — these CPU paths are
  exact, with no linearization error.
* Derives `distanceScales` from the Jacobian of the transform at the view center.
* Clamps the view center into `extent` on construction and on pan, since an out-of-domain center
  can otherwise produce non-finite output from the transform (e.g. panning a UTM viewport past
  the edge of its zone).
* Has no `repeat` option: a projected CRS is a finite plane, not a wrapping globe, so there is no
  analog of Mercator's low-zoom world repetition.

### `PROJECTION_MODE.CRS` and shader-side linearization

PROJ-style projections cannot run in GLSL, so per-vertex `COORDINATE_SYSTEM.LNGLAT` positions are
projected with a **local affine approximation**: uniforms carry the view center's projected
position in common space and the local 2×2 Jacobian of the transform at that center (scale *and*
grid convergence — the rotation between the CRS grid and true north — computed CPU-side by finite
differences of `transform.forward`). This generalizes the offset/scale trick deck.gl already uses
for `METER_OFFSETS` and `WEB_MERCATOR_AUTO_OFFSET`, extended from a diagonal scale to a full 2×2
matrix so that convergence is representable.

This adds a fifth `PROJECTION_MODE.CRS` alongside `WEB_MERCATOR`, `WEB_MERCATOR_AUTO_OFFSET`,
`GLOBE`, and `IDENTITY`, touching three files: `lib/constants.ts` (the new mode constant),
`shaderlib/project/viewport-uniforms.ts` (uploads the projected center and full Jacobian instead
of a single `unitsPerDegree` scale), and `shaderlib/project/project.glsl.ts` (a new branch:
`common_xy = center + J * (lnglat - center_lnglat)`, with elevation handled by the existing
`unitsPerMeter` z-scaling). `COORDINATE_SYSTEM.CARTESIAN` data is not run through the CRS
transform or its approximation — it is assumed already normalized to common space, matching how
Cartesian data behaves under the other offset-based projection modes.

**Error characteristics:** zero at the view center, growing with distance from it and with the
curvature of the projection. For `'EPSG:4326'` the transform is linear, so the approximation is
exact everywhere. For a projected CRS like UTM, error is sub-pixel at city/survey extents
(kilometers from center) and degrades only for continental-scale views in strongly curved
projections — a documented limit, not a correctness bug, since the Jacobian is recomputed every
frame from the current view center and error resets to zero as the user pans toward any location.

**No dependency policy.** deck.gl core bundles no projection library. The `transform` is always
supplied by the application (e.g. via proj4js, as shown in the `MapView.crs` docs); `'EPSG:4326'`
is the only built-in, and it is a trivial identity transform, not a general-purpose CRS library.

## Alternatives considered

* **Shader-side fixed EPSG:4326 mode.** A narrower change adding only a plate-carrée projection
  mode would satisfy the #6216 tile-service ask but not the projected-CRS (UTM/NZTM/OSGB) use
  case, and would need to be re-generalized later to cover any other CRS. The chosen design
  handles EPSG:4326 as the trivial case of the general mechanism instead of a special case.
* **CPU attribute reprojection** (OpenLayers-style: reproject every vertex on CPU, exact at any
  scale). This is exact everywhere and needs no shader changes, but it touches every layer's
  attribute-generation pipeline and adds nontrivial per-update cost for large point clouds or
  meshes. Neither motivating use case requires exactness away from the view center — sub-pixel
  error at survey/city scales is sufficient — so this is deferred as an opt-in future mode rather
  than the default (see Future work).
* **App-level only**, via a custom viewport with `PROJECTION_MODE.IDENTITY` and pre-transformed
  data. This requires every application to reimplement CRS support from scratch (as the workaround
  this RFC replaces already does) and gives no automatic support for
  `COORDINATE_SYSTEM.LNGLAT` layers. It has no leverage over the generic mechanism proposed here.

## Future work

This RFC covers Phase 1 (core CRS support in `@deck.gl/core`: `CRSTransform`, `CRSViewport`, the
`MapView.crs` prop, and `PROJECTION_MODE.CRS`) only. Two further phases are anticipated as
separate specs/PRs:

* **Phase 2 — CRS-aware tiles in `@deck.gl/geo-layers`.** Pluggable `Tileset2D` indexing driven
  by OGC TileMatrixSet definitions, with `TileLayer`/`WMSLayer` gaining a `tileMatrixSet`/`crs`
  prop. Enables TiTiler-style basemaps in UTM and `WorldCRS84Quad` tile services — the remaining
  half of the #6216 ask not covered by Phase 1's rendering support alone.
* **Phase 3 — GPU warping of Web-Mercator sources.** Per-tile gridded meshes, with vertices
  transformed Mercator → target CRS on CPU and the tile texture-mapped on GPU (OpenLayers-style
  triangulated reprojection). Lets existing Web Mercator basemaps (OSM, Esri, etc.) render in any
  CRS without a reprojecting server.
* **Opt-in exact CPU reprojection.** An additional, non-default mode that reprojects
  `COORDINATE_SYSTEM.LNGLAT` attributes exactly via the injected transform on CPU, for
  applications that need correctness at continental extents in strongly curved CRSs and can
  afford the attribute-generation cost. This is additive and does not require breaking changes to
  the API proposed here.
