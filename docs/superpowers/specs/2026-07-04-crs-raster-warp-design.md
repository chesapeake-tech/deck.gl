# Design: GPU Warping of Web-Mercator Raster Sources (Phase 3)

**Date:** 2026-07-04
**Status:** Approved
**Motivation:** Phase 3 of the CRS MapView effort (decomposition in
`docs/superpowers/specs/2026-07-02-crs-mapview-design.md`). Lets existing Web-Mercator raster
basemaps (OSM, Esri World Imagery — plain `{z}/{x}/{y}` XYZ pyramids) render inside a
non-Mercator CRS `MapView` without a reprojecting server, OpenLayers-style: per-tile gridded
mesh warped on CPU, tile image texture-mapped on GPU.
**Depends on:** Phase 1 (`MapView.crs`, `_CRSViewport`, `NormalizedCRS`, CARTESIAN = common
space); Phase 2 (`tile-matrix-set.ts` pure indexing math, `TileLayer` tileset seam).

## Decisions for review

Settled below with justification; flagged here because they are user-facing:

1. **A standalone `_WarpedTileLayer` (experimental), not a mode on `TileLayer`.** A warped
   Mercator source inverts `TileLayer`'s contracts: `tileMatrixSet` is meaningless (the source
   pyramid is fixed), `minZoom`/`maxZoom` refer to *source* OSM levels rather than TMS array
   positions, and the default `renderSubLayers` must produce a mesh, not GeoJSON. Folding this
   into `TileLayer` as a `warpToViewCrs` flag would make half of `TileLayer`'s props change
   meaning under one boolean. A subclass keeps `TileLayer` untouched (zero-behavior-change
   constraint) while inheriting its loading/caching/refinement machinery unchanged.
2. **Rendering via `SimpleMeshLayer` + `COORDINATE_SYSTEM.CARTESIAN`, no new shader code.**
   `TerrainLayer` already renders per-tile `SimpleMeshLayer` meshes in CARTESIAN — the exact
   pattern this reuses — and `@deck.gl/geo-layers` already depends on `@deck.gl/mesh-layers`.
   GLSL/WGSL parity comes for free; no new projection modes. Tradeoff: tile images are sampled
   with the sampler's linear filtering across warped triangles and there is no gutter/edge
   padding, so hairline seams can appear at tile borders under extreme warp (accepted by the
   acceptance criteria; see Quality envelope).
3. **Exact CPU transform at a fixed 16×16 default grid (`_meshResolution` prop).** Error
   analysis below shows ≤0.15 px worst-case for UTM at continental zooms and far below at
   survey scales; 289 vertices/tile is negligible. Not adaptive — YAGNI until a CRS that needs
   it appears.
4. **v1 non-goals users may ask about:** antimeridian-crossing views, cross-zoom fade-in,
   texture gutters, raster *re*-sampling quality settings, and warping non-Mercator sources
   (the general TMS source case) — see Non-goals.

## Problem

Phase 2 made `TileLayer` consume tile services *native to the view CRS*. But the dominant
basemaps (OSM, Esri) exist only as Web-Mercator pyramids. In a CRS view they currently cannot
render at all: the OSM tile indexing runs in the wrong common space, and even with correct
indices a Mercator tile drawn as an axis-aligned lnglat quad is wrong — its edges are curves in
the target CRS and its content needs Mercator→CRS resampling. Fathom's current workaround is
CPU canvas warping outside deck.gl (slow, off-GPU); the standard client-side answer
(OpenLayers) is triangulated reprojection: warp a small vertex grid exactly on CPU, let the GPU
interpolate texture lookups linearly within triangles.

## Goals / acceptance

1. OSM and Esri World Imagery render as basemaps in the UTM 18N mode of
   `test/apps/crs-viewport` with no reprojecting server: correctly georeferenced (graticule and
   state borders sit on the imagery), pan/zoom selects sensible source levels, no console
   errors.
2. Works identically under GLSL and WGSL (inherited from `SimpleMeshLayer`; no new shaders).
3. Zero behavior change for all existing paths (`TileLayer`, tilesets, Mercator views).

## Non-goals

- **Antimeridian-crossing or whole-world CRS views of a Mercator source** — regional projected
  CRSs (the Phase 3 use case) do not cross it; longitude wrap of warped meshes is future work.
- **Warping arbitrary TMS sources** (source CRS ≠ EPSG:3857). The mesh pipeline is written
  against a source-transform interface internally, but only the Mercator source is wired and
  tested; generalizing is future work.
- **Texture gutters / seam elimination and cross-zoom fading** — quality polish, future work.
- **Terrain (3D) warping** — `zRange` is ignored, as in Phase 2 CRS tiles.

## Design

### Architecture

Three units in `modules/geo-layers/src/warped-tile-layer/`:

1. **`warp-mesh.ts`** (pure, node-testable): the Web-Mercator source pyramid expressed as a
   Phase 2 `TileMatrixSet` over deck's 512-unit Mercator world, closed-form
   lnglat↔Mercator-world transforms, source-level selection from a CRS viewport, and the
   warped-mesh builder.
2. **`mercator-crs-tileset-2d.ts`**: `MercatorCRSTileset2D extends Tileset2D` — indexes the
   Mercator pyramid from a CRS view. Small because all grid math is Phase 2's
   `tile-matrix-set.ts` functions applied to the WebMercatorQuad TMS.
3. **`warped-tile-layer.ts`**: `_WarpedTileLayer extends TileLayer` — locks the tileset class,
   defaults `renderSubLayers` to a `SimpleMeshLayer` per tile with a memoized warped mesh.

### Source pyramid as a TileMatrixSet (Phase 2 reuse)

The OSM pyramid is `WebMercatorQuad`: in deck's 512-unit Mercator world
(`lngLatToWorld`/`worldToLngLat` from `@math.gl/web-mercator`, already a geo-layers
dependency), level `z` is a `2^z × 2^z` grid with `pointOfOrigin: [0, 512]`,
`cornerOfOrigin: 'topLeft'` (world y grows northward; OSM row 0 is the top), tile span
`512 / 2^z` world units, `cellSize = 512 / (2^z · tileSizePx)`. Expressing it this way lets
`getTileIndicesInBounds` / `getTileBoundsCRS` from Phase 2 do all indexing — one grid-math
implementation across Phases 2 and 3. Parent indexing is the trivial quadtree
`{x >> 1, y >> 1, z − 1}` (no geometric walk needed).

### Tile selection: view in CRS space, source in Mercator

Index range: unproject the 4 screen corners to lnglat (view CRS handles this exactly),
clamp latitude to Mercator's domain (±85.051129°), `lngLatToWorld` → min/max → Phase 2 index
math. Non-finite corners fall back to the full world bounds (same policy as Phase 2's fix).

Level selection matches **ground resolution at the view center**. The view's ground
meters-per-pixel is `metersPerUnit[0] · 2^−zoom` (Phase 1 `distanceScales`); a Mercator level
`z` at latitude φ resolves `C·cos(φ) / (tileSizePx · 2^z)` ground meters per pixel
(C = 40 075 016.686 m). Equate and round:

```
zSource = round(log2(C · cos(φ) / (tileSizePx · viewGroundMetersPerPixel)))
```

This is the Phase 1 docs' zoom-conversion formula (ratio of `unitsPerMeter`) specialized to a
Mercator target: for a Mercator view it reduces exactly to the OSM rule
`round(zoom + log2(512/tileSize))`, which the plan pins with a test. `zoomOffset`,
`minZoom`/`maxZoom` (source OSM levels), and `visibleMinZoom`/`visibleMaxZoom` (view zoom) keep
their `TileLayer` meanings.

### Warped mesh

Per tile: an `N×N`-cell grid, `(N+1)²` vertices (`_meshResolution` prop, default `N = 16`).
Each vertex: Mercator world position (linear in the tile rect — equivalently linear in texture
uv, which is what GPU interpolation assumes) → `worldToLngLat` → `crs.transform.forward` →
common space (Phase 1 normalization: `(xy − extent.min) · commonUnitsPerCRSUnit`). The exact
injected transform runs on CPU per vertex — **not** the Phase 1 shader linearization, so the
warp is exact at the vertices at any view scale; between vertices the GPU interpolates
linearly.

**Grid resolution vs error.** Piecewise-bilinear interpolation of a C² map has max error
≈ `(h²/8)·max‖D²f‖`. The Mercator→CRS composite's second derivatives scale as `1/R`
(R ≈ 6.37e6 m — curvature/convergence rates of conformal projections). For a tile of ~256 px
displayed at ground resolution `g` m/px, the on-screen error is ≈ `256²·g / (8R·N²)` px:

| source z (lat 40°) | g (m/px) | N=4 | N=8 | N=16 |
|---|---|---|---|---|
| 2 | ~30 000 | 2.4 px | 0.60 px | 0.15 px |
| 6 | ~1 870 | 0.15 px | 0.04 px | 0.01 px |
| ≥10 | ≤117 | <0.01 px | — | — |

`N = 16` is sub-pixel even at continental zooms in strongly curved CRSs, and costs only 289
vertices + 512 triangles per tile — far below terrain meshes. Exposed as `_meshResolution`
(experimental) rather than adaptive-by-error: no current CRS needs more.

**Precision at high zoom (Phase 1 offset conventions).** Vertex positions are stored `Float32`
**relative to the tile's common-space origin** (its min corner, computed in `Float64`); the
origin is the instance `getPosition`, which deck's attribute pipeline fp64-splits like any
CARTESIAN position. Relative magnitudes are ≤ one tile span, so fp32 quantization is ≤1e−7 of
the on-screen tile (≪0.01 px at any zoom) — the same trick `TerrainLayer` relies on.

**Seams.** Adjacent same-level tiles share edge vertices computed from identical Mercator edge
coordinates → identical CRS positions → watertight within a level. Across refinement levels
(parent shown while children load) hairline cracks are possible; with `refinementStrategy:
'best-available'` the parent renders underneath, which visually fills them. Texture uv spans
[0,1] with linear filtering and no gutter: worst case a hairline of edge-texel bleed at tile
borders. Both accepted per acceptance criteria and documented.

### Caching / memoization

The mesh depends on `(tile index, source tileSize, crs, _meshResolution)`. Within one layer the
last three are fixed per tileset generation, so the mesh is built once per tile and stored on
`tile.userData` (dropped with the tile by the existing cache eviction — no separate cache to
size). The view-CRS-swap flush from Phase 2 applies: `MercatorCRSTileset2D` adopts the same
`crs.code`-keyed flush so stale meshes/metadata cannot survive a `MapView.crs` change
(`finalize()`; skips `onTileUnload`, same documented caveat).

### Relationship to Phase 2's `CRSTileset2D`

Shared: all pure grid math (`tile-matrix-set.ts`), the view-corner → source-units bounds
pattern, the non-finite-corner fallback policy, and the CRS-swap flush. Distinct class because
the *source-units transform* differs (fixed closed-form Mercator vs the view CRS transform),
level selection differs (ground-resolution matching vs native cellSize matching), and parents
are quadtree-trivial. No changes to `CRSTileset2D` or `TileLayer`.

### Public API

```ts
import {_WarpedTileLayer} from '@deck.gl/geo-layers';

new _WarpedTileLayer({
  data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', // or Esri World Imagery
  tileSize: 256,        // source tile pixels (OSM 256; some services 512)
  minZoom: 0,
  maxZoom: 19,          // SOURCE (OSM) levels
  _meshResolution: 16   // grid cells per tile edge (experimental)
});
// rendered inside new MapView({crs: <CRSDefinition | 'EPSG:4326'>})
```

`renderSubLayers` remains overridable (receives `tile` with `bbox`, `boundsWorld`, and the
built mesh); everything else inherits `TileLayer` semantics. In a plain Mercator view the layer
throws the same informative error as `CRSTileset2D` (use `TileLayer` there — warping is
pointless and the error says so).

## Quality / performance envelope

- Geometry exact at vertices; ≤0.15 px interpolation error at N=16 anywhere a UTM-like CRS is
  usable; texture resampling is the GPU's bilinear filter (no supersampling).
- Hairline tile-edge artifacts possible (no gutters); cross-LOD cracks covered by
  `best-available` parents.
- CPU cost: (N+1)² exact transforms per tile once (289 × proj4 ≈ well under 1 ms/tile);
  GPU cost comparable to `TerrainLayer` with tiny meshes.
- Level selection is exact at the view center; away from the center the source resolution
  deviates by the Mercator `cos(φ)` factor across the viewport — negligible for regional CRS
  extents, documented for wide 4326 views.

## Testing strategy

- `warp-mesh.ts` node specs: WebMercatorQuad TMS vs `osmTile2lngLat` known answers; level
  selection reproduces the OSM rule for a Mercator-equivalent target and known UTM answers;
  mesh corner/center vertices vs independently computed lnglat→UTM values; shared-edge
  bitwise equality between neighbor tiles (seam proof); texCoords span.
- `MercatorCRSTileset2D` node specs: index sets from a real UTM `_CRSViewport`; metadata
  `bbox`/`boundsWorld`; quadtree parents; Mercator-view rejection; lat-domain clamping.
- `_WarpedTileLayer` headless spec: tileset class, one `SimpleMeshLayer` per loaded tile with
  finite CARTESIAN attributes, mesh memoized on `tile.userData`.
- Manual/visual: OSM + Esri in the crs-viewport UTM mode (basemap selector), graticule
  alignment, zoom-through-levels, screenshots — the Phase 3 acceptance check.

## Decomposition (this spec → one plan)

Single plan, 4 tasks: (1) `warp-mesh.ts` math + mesh builder, (2) `MercatorCRSTileset2D`,
(3) `_WarpedTileLayer` + exports + docs, (4) app verification. Plan:
`docs/superpowers/plans/2026-07-04-crs-raster-warp-phase3.md`.
