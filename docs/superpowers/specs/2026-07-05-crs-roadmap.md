# CRS Feature Roadmap — chunked follow-on work

**Date:** 2026-07-05 · **Branch:** feat/crs-mapview · **Status:** Approved (chunk order confirmed by Adam)

All items surfaced by reviews, the clarity-client trial, or documented v1 limitations. Each chunk
is independently shippable; big items get their own spec/plan before implementation. Execution
rule: one writer in this checkout at a time; every task goes through the implement→review→fix
pipeline recorded in `.superpowers/sdd/progress.md`.

## Chunk A — Fathom cutover blockers (first)

- **A1. METER_OFFSETS grid-convergence rotation** — apply the view-center Jacobian's rotation to
  offset coordinate frames in CRS mode so anchored point clouds/meshes don't drift (~tens of m
  per km in a UTM zone). Contained: uniforms + offset-path shader math + tests, patterned on the
  Hessian work. No spec needed.
- **A2. North-arrow/compass correctness** — a widget (or docs recipe) exposing grid-north vs
  true-north (convergence angle is already computable from the Jacobian). Tiny.
- **A3. editable-layers / drawing & measure tools in CRS views** — audit `@deck.gl-community/
  editable-layers` against CRSViewport (exact CPU unproject should carry most of it), fix what
  breaks, document what can't work. Medium; audit report first, then fixes.
- **A4. Terrain/3D in CRS views** — `TerrainExtension` + terrain-style meshes with Mercator
  anchor math generalized to CRS common space. Biggest item; spec-first (own design doc).

## Chunk B — tile/raster quality

- **B1. Far-field LOD for pitched views** — multi-level traversal for `_CRSTileset2D` and
  `MercatorCRSTileset2D` (both currently single-level AABB; documented over-fetch).
- **B2. Warped-layer seams + adaptive mesh** — texture gutters/edge clamp to kill hairline
  seams; distortion-adaptive grid resolution (both flagged v1 simplifications).
- **B3. Non-Mercator warp sources** — generalize `warp-mesh` input from WebMercatorQuad to any
  TMS (e.g. warp 4326 GIBS into a UTM view).

## Chunk C — upstream PR sweeteners (cheap, do before the visgl PR)

- **C1. Fix pre-existing `_WMSLayer` srs/crs field bug** (`renderLayers` reads
  `lastRequestParameters.srs`; field is `crs` — `_imageCoordinateSystem` always defaulted).
- **C2. `createProj4CRS` helper** — optional utility building a `CRSDefinition` from a proj4
  instance + EPSG code (adapter now hand-written 3× in demos/trials).
- **C3. Aggregation-layer audit** — Heatmap/ScreenGrid/GridLayer behavior in CRS views; fix or
  document per layer.

## Chunk D — controller completeness

- **D1. Viewport-delegated constraints** — make `normalize: true` and `maxBounds` work in any
  CRS (`applyConstraints`/`_constrainZoom` delegate to the viewport). Removes the
  normalize-off default for CRS views. RFC future-work item.

## Chunk E — deferred features (largest, last)

- **E1. MVT in CRS views** — wgs84-decode route + `MercatorCRSTileset2D` selection; costs the
  binary fast path. Spec-first.
- **E2. Exact CPU reprojection opt-in (Approach B)** — per-layer flag transforming attributes
  through the real projection; exact at any extent. Spec-first.

## Order

A1 → A2 → A3 (audit, then fixes) → A4 (spec, then impl) → C1–C3 → B1–B3 → D1 → E1/E2 as demanded.
C may be pulled earlier if the visgl PR is opened before A completes.
