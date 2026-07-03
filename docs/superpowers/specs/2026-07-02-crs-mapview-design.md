# Design: Non-Web-Mercator CRS Support in deck.gl MapView

**Date:** 2026-07-02
**Status:** Approved
**Motivation:** Fathom (Clarity's underwater-survey platform) and deck.gl community request
[discussion #6216](https://github.com/visgl/deck.gl/discussions/6216) /
[issue #6217](https://github.com/visgl/deck.gl/issues/6217)
**Target:** Upstream contribution to visgl/deck.gl (v9.x), consumed by Fathom from this fork until merged

## Problem

deck.gl's `MapView` is hardcoded to Web Mercator (EPSG:3857). Four projection modes
(`WEB_MERCATOR`, `WEB_MERCATOR_AUTO_OFFSET`, `GLOBE`, `IDENTITY`) flow from
`Viewport.projectionMode` into GLSL branches in the `project` shader module; there is no way to
render a geospatial view in another CRS.

Fathom's survey data lives in projected CRSs (UTM zones, NZTM, OSGB, NAD27/83 grids). Its current
workaround renders native-CRS scenes through `OrthographicView` plus CPU canvas-warping of basemap
tiles — losing MapView semantics, basemap quality, and performance. The community's parallel ask
(#6216) is displaying EPSG:4326 tile services without a reprojecting proxy.

## Goals / acceptance scenarios

1. **UTM survey + basemap:** open a Fathom survey in its native UTM zone (e.g. EPSG:32618) with
   sonar mosaics, track lines, targets, and a basemap all aligned, with full MapView-style
   pan/zoom/rotate/pitch.
2. **4326 tile services:** display EPSG:4326 WMS/WMTS/global-geodetic tile sources without a
   reprojecting proxy (the #6216 ask).

Both fall out of one generic design: EPSG:4326 is just a CRS whose forward transform is trivial
(identity on degrees).

## Non-goals (this spec)

- CPU attribute reprojection (exact-at-any-scale vector transform). The linearization approach
  below is exact for 4326 and sub-millimeter at survey scales; an opt-in exact mode can be added
  later without breaking changes.
- Fathom-side integration (replacing `useReprojectedView`, package overrides) — separate effort.
- Raster-only specialty CRSs with no inverse transform.

## Decomposition

Three separable subsystems, each its own spec → plan → PR. **This spec details Phase 1 only.**

- **Phase 1 — Core CRS support in `@deck.gl/core`** (this document): `CRSTransform` interface,
  `CRSViewport`, `MapView.crs` prop, `PROJECTION_MODE.CRS` shader mode.
- **Phase 2 — CRS-aware tiles in `@deck.gl/geo-layers`:** pluggable `Tileset2D` indexing via OGC
  TileMatrixSet definitions; `TileLayer`/`WMSLayer` gain a `tileMatrixSet`/`crs` prop. Enables
  TiTiler basemaps in UTM and `WorldCRS84Quad` tile services.
- **Phase 3 — GPU warping of Web-Mercator sources:** per-tile gridded mesh, vertices transformed
  Mercator→target CRS on CPU, texture-mapped on GPU (OpenLayers-style triangulated reprojection).
  Lets OSM/Esri basemaps render in any CRS without a reprojecting server; replaces Fathom's canvas
  warper.

## Chosen approach: shader linearization ("CRS auto-offset")

PROJ cannot run in GLSL, so per-vertex lng/lat → CRS projection uses a **local affine
approximation**: uniforms carry the view center projected into the CRS and the local Jacobian of
the transform (scale + grid convergence at that point, computed CPU-side). This generalizes the
trick deck.gl already uses for `METER_OFFSETS` and `WEB_MERCATOR_AUTO_OFFSET`.

Rejected alternatives:

- **CPU attribute reprojection** (OpenLayers-style): exact everywhere, but touches every layer's
  attribute pipeline and adds per-update cost on Fathom-scale data (point clouds, meshes with
  millions of points). Neither acceptance scenario needs it. Kept as future opt-in.
- **App-level only** (custom viewport with `PROJECTION_MODE.IDENTITY`, pre-transformed data):
  no leverage — it is a cleanup of Fathom's existing OrthographicView path, and LNGLAT layers
  don't work automatically.

Error characteristics: zero at view center, growing with distance and projection curvature.
Exact everywhere for EPSG:4326 (linear transform); sub-millimeter for UTM at survey extents
(kilometers); degrades only for continental views in strongly curved CRSs (documented limit,
verified by test #2 below).

## Public API

```ts
new MapView({
  crs: {
    code: 'EPSG:32618',                    // identifier, used for caching/debug
    transform: {                            // WGS84 degrees ↔ CRS units
      forward: (lnglat: [number, number]) => [x, y],
      inverse: (xy: [number, number]) => [lng, lat],
    },
    extent: [minX, minY, maxX, maxY],       // CRS-unit bounds; defines world scale
    units: 'meters',
  },
})
```

- `crs` unset or `'EPSG:3857'` → today's `WebMercatorViewport`; zero behavior change.
- **No proj dependency in core.** The transform is injected. Fathom wires its existing
  `projection-utils.ts` (proj-wasm/proj4 selection); upstream docs show a proj4js recipe.
  `'EPSG:4326'` ships built-in as a trivial transform.
- **No Jacobian in the interface.** The viewport computes it by finite differences of `forward()`
  around the view center (as OpenLayers does); implementers supply only forward/inverse.

## Components

### `CRSViewport` (new, `modules/core/src/viewports/crs-viewport.ts`)

- Common space = the CRS plane, normalized so `extent` width maps to deck's 512-unit world at
  zoom 0 → Mercator-compatible zoom semantics.
- View state stays `{longitude, latitude, zoom, bearing, pitch}` (geographic), so `MapController`,
  transitions, and Fathom's CRS toggle (a one-prop change) work unchanged. Internal center is
  `forward([lng, lat])`.
- Implements `projectFlat`/`unprojectFlat` via the injected transform. All CPU paths — picking,
  `fitBounds`, `panByPosition`, tooltips — are therefore **exact** (no linearization error).
- `distanceScales` derived from the Jacobian at view center.
- `projectionMode` returns the new `PROJECTION_MODE.CRS`.
- No repeated-world longitude wrapping — a projected CRS is a finite plane.

### `MapView` changes (`modules/core/src/views/map-view.ts`)

`getViewportType()` returns `CRSViewport` when `props.crs` is set (and not 3857), else
`WebMercatorViewport`. `ControllerType` remains `MapController`.

### Shader mode (`PROJECTION_MODE.CRS`)

Touches exactly three files:

- `modules/core/src/lib/constants.ts`: new `PROJECTION_MODE.CRS` constant.
- `modules/core/src/shaderlib/project/viewport-uniforms.ts`: new case in `getOffsetOrigin()`;
  upload view center in common space + full 2×2 Jacobian. (Existing offset modes only support a
  diagonal scale — `unitsPerDegree` — which cannot represent grid convergence, the local rotation
  of a UTM grid vs true north; hence the 2×2.)
- `modules/core/src/shaderlib/project/project.glsl.ts`: new branch in `project_position()`:
  `common_xy = center + J * (lnglat - center_lnglat)`; elevation via `unitsPerMeter` z-scaling
  as today.

Vertices are computed relative to the view center, so fp32 is safe despite UTM's 10⁶-magnitude
coordinates (the same rationale as the existing auto-offset mode). The Jacobian is recomputed per
frame from the current center — four `forward()` calls — which keeps error bounded as the user
pans.

## Interaction

`MapController` reused as-is: pan / zoom-around-pointer / rotate / pitch route through
`viewport.unproject` and `panByPosition`, which `CRSViewport` implements exactly. Zoom limits and
`fitBounds` clamp to `extent`. Bearing 0 = CRS grid-north up (Fathom's north arrow already
accounts for convergence).

## Error handling & edge cases

- **Out-of-domain transforms:** view-state center is clamped into `extent`; NaN from a transform
  at viewport construction throws a descriptive error. Layer data outside the CRS domain renders
  where the linearization puts it — documented, not an error (matches OpenLayers).
- **Degenerate Jacobian** near extent edges (finite-difference step out of domain): fall back to
  one-sided differences.
- **View-state interop:** switching `crs` keeps `{longitude, latitude, zoom}` meaningful across
  CRSs because view state is geographic.

## Testing

In deck.gl's existing Vitest + render-test harness:

1. **Unit:** `project`/`unproject` round-trips against fixtures generated with the PROJ CLI for
   EPSG:32618 (UTM 18N), EPSG:2193 (NZTM), EPSG:27700 (OSGB), EPSG:4326; `fitBounds`,
   `panByPosition`, distance-scale checks.
2. **Linearization error bound:** at representative zooms, compare shader-affine positions vs
   exact CPU projection across the full viewport; assert sub-pixel error at survey scales and
   quantify where error exceeds 1px for curved CRSs (documented limit).
3. **Render:** golden-image tests for a GeoJSON + PathLayer scene in UTM and in 4326, including
   bearing/pitch.
4. **Regression:** full existing suite passes — Mercator/Globe/Orthographic untouched.

## Logistics

- Feature branch in this fork (`~/dev/deck.gl`, v9.3 monorepo; `yarn bootstrap` / `yarn test`).
- Structured as an upstream PR with an RFC in `dev-docs/RFCs` referencing #6216, per the
  maintainer's "implement it yourself with our support" offer.
- Fathom consumes the branch build via package overrides until merged (Fathom-side wiring is a
  later phase, out of scope here).

## References

- [Discussion #6216 — Native Support for Alternate Geospatial CRS](https://github.com/visgl/deck.gl/discussions/6216)
- [Issue #6217](https://github.com/visgl/deck.gl/issues/6217), prior attempts #5607, #6090; draft PR #5504
- 2017 RFC: `dev-docs/RFCs/v4.1/projection-mode-improvements-rfc.md`
- BranZhang's EPSG:4326 fork (prior art referenced in #6216)
- Key integration points: `modules/core/src/viewports/viewport.ts`,
  `modules/core/src/viewports/globe-viewport.ts` (template),
  `modules/core/src/shaderlib/project/{project.glsl.ts,viewport-uniforms.ts}`,
  `modules/core/src/lib/constants.ts`, `modules/core/src/views/map-view.ts`
