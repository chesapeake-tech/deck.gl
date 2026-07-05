# CRS aggregation-layer audit (Chunk C3)

**Date:** 2026-07-05 · **Branch:** feat/crs-mapview

Audit of `@deck.gl/aggregation-layers`'s five major layers for CRS-view (`MapView({crs})` /
`_CRSViewport`) correctness: does each layer's own binning/aggregation math assume Web
Mercator common space, separate from the viewport's `distanceScales`
(`unitsPerMeter`/etc.), which Phase 1 of this branch already made correct in any CRS via the
CRS Jacobian?

Method: full code trace of each layer's projection/binning path (`modules/aggregation-layers/
src/*`), cross-referenced against `modules/core/src/viewports/crs-viewport.ts`/`crs-utils.ts`,
plus a small headless probe per broken layer (a `_CRSViewport` + a handful of points) added at
`test/modules/aggregation-layers/crs-view.spec.ts`.

## Verdicts

| Layer | Verdict | Root cause / notes |
| --- | --- | --- |
| ScreenGridLayer | **Works in any CRS** | Pure screen-space binning; no fix needed. |
| GridLayer | **Broken — fixed** (`d4e16775c`) | Crashed under any CRS view with finite data bounds. |
| HexagonLayer | **Broken — fixed** (`d4e16775c`) | Same root cause as GridLayer. |
| ContourLayer | **Broken — fixed** (`d4e16775c`) | Same root cause as GridLayer. |
| HeatmapLayer | **Mostly works; one narrow limitation, documented not fixed** | See below. |

### ScreenGridLayer — works in any CRS

`screen-grid-layer.ts`'s CPU path (`getBin`) and its GLSL counterpart bin purely in
screen/pixel/clip space (`viewport.project`, `project_position_to_clipspace`,
`project.viewportSize`). No lat/lng, no Mercator constants, no `distanceScales` even needed —
the layer never looks at the CRS at all. Clean by construction.

### GridLayer / HexagonLayer / ContourLayer — broken (crash), fixed

All three share one `_updateBinOptions()` structure:

1. Convert `cellSize`/`radius` (meters) to common-space units via
   `viewport.getDistanceScales(centroid).unitsPerMeter` — this is the Phase-1-fixed,
   CRS-correct path (uses the CRS Jacobian at the data centroid). Fine as-is.
2. Reconstruct a fresh "data-centroid" viewport for the GPU aggregator's `project` shader
   module, to remove float-precision variance that would otherwise depend on the app's
   initial view state:
   ```ts
   const ViewportType = viewport.constructor as any;
   viewport = viewport.isGeospatial
     ? new ViewportType({longitude: centroid[0], latitude: centroid[1], zoom: 12})
     : new Viewport({position: [centroid[0], centroid[1], 0], zoom: 12});
   ```

For a `WebMercatorViewport`/`_GlobeViewport`, that 3-key options object is a valid
constructor call. For `_CRSViewport`, `crs` is a *required* constructor option —
`normalizeCRS(opts.crs)` destructures it unconditionally and throws
`Cannot destructure property 'code' of 'definition' as it is undefined` when it's missing.
Since `_CRSViewport.isGeospatial` is `true` (inherited from the base `Viewport`, which sets
it whenever `longitude`/`latitude` are finite), this branch was always taken for a CRS view —
so any GridLayer/HexagonLayer/ContourLayer with finite data bounds crashed on its first
`_updateBinOptions()` call. This is a hard crash, not an accuracy bug, and reproduces with as
few as one data point once bounds are computed.

**Fix** (commit `d4e16775c`, `fix(aggregation-layers): pass crs through when reconstructing
the data-centroid viewport`): duck-type `crs` off the current viewport (matching the
`WMSCRSViewportLike` convention already established in `geo-layers/wms-layer/utils.ts`, so
aggregation-layers gains no new dependency on `_CRSViewport`) and forward it when present:

```ts
const crs = (viewport as unknown as {crs?: unknown}).crs;
viewport = viewport.isGeospatial
  ? new ViewportType({
      longitude: centroid[0],
      latitude: centroid[1],
      zoom: 12,
      ...(crs !== undefined ? {crs} : {})
    })
  : new Viewport({position: [centroid[0], centroid[1], 0], zoom: 12});
```

Behavior for non-CRS viewports (`crs` duck-type absent) is unchanged.

Once the crash stops firing, the rest of each layer's math is already CRS-generic:
- `hexbin.ts`'s `pointToHexbin`/`getHexbinCentroid` are pure Euclidean common-space geometry
  parameterized by `radiusCommon` — no spherical-earth or d3-hexbin geographic assumptions.
- `marching-squares.ts`/`contour-utils.ts`/`value-reader.ts` operate purely on integer
  bin-index grids — no lat/lng or Mercator constants anywhere.
- `common/aggregator/*` (`CPUAggregator`/`WebGLAggregator`) and `common/utils/*`
  (`bounds-utils.ts`, `scale-utils.ts`, `color-utils.ts`) hold no viewport/geospatial logic of
  their own — pure bin-index containers driven by the per-layer `getBin`/`getValue`
  callbacks reviewed above. No `instanceof WebMercatorViewport`, no hardcoded Mercator
  constants (circumference, `cos(latitude)` scale-factor corrections, etc.) anywhere in
  shared code.

Regression/new-coverage test: `test/modules/aggregation-layers/crs-view.spec.ts` mounts all
three layers against a `_CRSViewport` (UTM 18N) with a handful of points and asserts they
don't throw and produce a finite `binIdRange`.

### HeatmapLayer — mostly works; one narrow limitation (documented, not fixed)

- `_updateBounds`'s corner-unprojection (`viewport.unproject` on the four screen corners) is
  generic min/max — no Mercator assumption.
- `_worldToCommonBounds`/`_commonToWorldBounds` route entirely through
  `viewport.projectPosition`/`unprojectPosition`/`projectFlat`, which for a `_CRSViewport`
  call `lngLatToCommon`/`commonToLngLat` — the CRS's *exact* forward/inverse transform, not
  even an approximation. Exactly correct in any CRS.
- `_updateWeightmap`'s `metersPerPixel` calculation reads
  `viewport.distanceScales.metersPerUnit[2]` — the Phase-1-fixed, isotropic, CRS-correct
  value. Fine.
- `weights-vs.glsl.ts` sizes the kernel in common space via the standard `project` shader
  module (CRS-correct per Phase 1). Fine.
- **The one real gap**, `heatmap-layer.ts` (`_updateBounds`):
  ```ts
  // Clip webmercator projection limits
  if (this.props.coordinateSystem === 'lnglat') {
    worldBounds[1] = Math.max(worldBounds[1], -85.051129);
    worldBounds[3] = Math.min(worldBounds[3], 85.051129);
    worldBounds[0] = Math.max(worldBounds[0], -360);
    worldBounds[2] = Math.min(worldBounds[2], 360);
  }
  ```
  This bakes in Web Mercator's ±85.051129° latitude singularity (where Mercator's `y`
  diverges) unconditionally, regardless of the viewport's actual CRS. `coordinateSystem` here
  is `HeatmapLayer`'s own prop (default `'default'`, which most apps never override), not the
  viewport's CRS — the clip only fires when an app *explicitly* passes
  `coordinateSystem: 'lnglat'` to force lnglat position interpretation. That narrows the
  blast radius considerably (most CRS-view apps never hit this), but when it does fire under
  a non-Mercator CRS view, the clip bound is meaningless for that CRS (a UTM zone's own valid
  domain has nothing to do with ±85.05°) and could clip away legitimately in-domain data near
  a CRS's own poleward extent edge, or fail to clip a CRS whose domain is *narrower* than
  ±85.05° (silently passing out-of-domain positions through to the projection).

  **Not fixed here**: a correct fix isn't a one-liner — it requires deriving the CRS's own
  valid lat/lng domain (unproject the CRS `extent` corners, not a hardcoded constant) rather
  than swapping in a different literal, and deserves dedicated test coverage of the interplay
  between the layer's `coordinateSystem` prop and the viewport's CRS. Documented as a
  limitation instead (see `crs-viewport.md` "Limitations" section).

## Files

- Fix: `modules/aggregation-layers/src/grid-layer/grid-layer.ts`,
  `modules/aggregation-layers/src/hexagon-layer/hexagon-layer.ts`,
  `modules/aggregation-layers/src/contour-layer/contour-layer.ts` (commit `d4e16775c`).
- New test: `test/modules/aggregation-layers/crs-view.spec.ts`.
- Docs: `docs/api-reference/core/crs-viewport.md` "Limitations" section, HeatmapLayer bullet.
