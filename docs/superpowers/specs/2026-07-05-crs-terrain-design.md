# Design: Terrain/3D in CRS Views (Phase 4)

**Date:** 2026-07-05
**Status:** Proposed
**Motivation:** Chunk A, item A4 of the CRS follow-on roadmap
(`docs/superpowers/specs/2026-07-05-crs-roadmap.md`): "Terrain/3D in CRS views —
`TerrainExtension` + terrain-style meshes with Mercator anchor math generalized to CRS common
space. Biggest item; spec-first (own design doc)." This is the last Chunk-A item before the
Fathom cutover; Fathom (Clarity's underwater-survey platform) needs 3D bathymetry — gridded
depth surfaces and triangulated seabed meshes — inside a UTM `MapView`.
**Depends on:** Phase 1 (`MapView.crs`, `_CRSViewport`, `NormalizedCRS`, `PROJECTION_MODE.CRS`,
`unitsPerMeter`/`distanceScales`); Phase 2 (`_CRSTileset2D`, `tile-matrix-set.ts`, `TileLayer`'s
`tileMatrixSet` prop); Phase 3 (`_WarpedTileLayer`, precedent for CPU-exact tile-bounds
reprojection).

## Decisions for review

Settled below with justification; flagged here because they are user-facing:

1. **Scope cut: only CRS-native (TileMatrixSet-indexed) elevation sources get `TerrainLayer`
   support in v1.** Warping a *public Web-Mercator terrain-RGB pyramid* (Mapbox Terrain-RGB,
   AWS/Terrarium tiles — the Phase-3 problem, but with a Z channel) into a CRS view is deferred
   to future work. It would need a from-scratch, in-repo elevation-decode + regular-grid mesh
   builder that bypasses `@loaders.gl/terrain`'s Martini simplification (Martini's adaptive
   triangulation can't be losslessly reprojected after simplification without forking an
   external package — out of scope, no new runtime deps). Fathom's own architecture doc lists
   its bathymetry plan as CRS-native `TerrainLayer` (BAG/GeoTIFF grids, served from
   infrastructure Fathom controls) and direct `SimpleMeshLayer` (triangulated seabed meshes) —
   not a public Mercator DEM service — so this cut does not block the driving use case. See
   Non-goals.
2. **`TerrainExtension` is descoped entirely to future work, not fixed here.** Its Mercator
   anchor math is pervasive — a CPU reference viewport hardcoded to `WebMercatorViewport`
   regardless of the active viewport (`modules/extensions/src/utils/projection-utils.ts:65-119`,
   with its own acknowledged `// TODO - find a more generic way...` at line 116-117) plus a
   shader-side assumption that common-space XY *is* Mercator XY
   (`modules/extensions/src/terrain/shader-module.ts:95-125`, `terrainMercPos = commonPos.xy`)
   with a conversion branch only for `PROJECTION_MODE_GLOBE`, none for CRS. Properly
   generalizing it needs both a CRS-aware reference-viewport constructor and a shader-side
   `PROJECTION_MODE_CRS` branch analogous to the globe one — a project close in size to this
   whole item, not a mechanical fix, and Fathom's architecture doc does not use
   `TerrainExtension` anywhere in its layer table. Descoped; tracked as a roadmap follow-up (see
   Non-goals).
3. **No elevation Z-scaling change.** Phase 1's design doc is explicit: CRS-view elevation
   keeps "`unitsPerMeter` z-scaling as today" (`2026-07-02-crs-mapview-design.md:134`) — i.e.
   `TerrainLayer`'s existing convention (decoded elevation in real meters baked directly as
   common-space Z, independent of the projection's XY warping, unaffected by latitude/CRS) is
   unchanged. This item's fix is XY tile-bounds conversion only.
4. **`SimpleMeshLayer` + `COORDINATE_SYSTEM.CARTESIAN` 3D positioning is verified, not built.**
   Phase 1 kept the camera (pitch/bearing/altitude matrices) and `CARTESIAN` positioning
   viewport-generic, not Mercator-specific — an app that projects its own mesh positions
   through `crs.transform.forward` (or via `_CRSViewport`) and treats elevation as raw meters
   should already render pitched 3D meshes correctly in a CRS `MapView`, with zero new code.
   This is exactly Fathom's current/planned mesh-bathymetry path (`SimpleMeshLayer` from zarr
   data, positioned app-side — confirmed in the trial's architecture doc, not app-side
   Mercator-only math). This item adds a regression test proving the invariant and documents
   the convention; it does not add layer code.

## Problem

Two "terrain" systems exist in `@deck.gl/geo-layers` and `@deck.gl/extensions`, both hard-wired
to Web Mercator assumptions:

1. **`TerrainLayer`** (`modules/geo-layers/src/terrain-layer/terrain-layer.ts`, single 424-line
   file) fetches terrain-RGB height tiles + optional texture tiles, decodes elevation, and
   builds a mesh (via the external `@loaders.gl/terrain` `TerrainWorkerLoader`, Martini RTIN
   simplification). When `elevationData` is a `{z}/{x}/{y}` template
   (`isTileSetURL`, line 422-423), it composes an internal, plain `TileLayer` (line 364) that
   **never forwards the `tileMatrixSet` prop** the generic `TileLayer` already supports for CRS
   indexing (`tile-layer.ts:277-279`: `if (tileMatrixSet && TilesetClass === Tileset2D) return
   CRSTileset2D;`) — so `TerrainLayer` always gets the plain Mercator-XYZ `Tileset2D`, even
   though the surrounding machinery to do better already exists on this branch. Worse, the
   per-tile bounds fed to the mesh builder are computed via `viewport.projectFlat(lnglat)`
   (`getTiledTerrainData`, lines 237-240) — in `_CRSViewport` this is the Phase 1
   Jacobian-linearized approximation (exact only near the view center), not the exact CRS
   transform.
2. **`TerrainExtension`** (`modules/extensions/src/terrain/`) drapes arbitrary layers onto a
   shared height-map/terrain-cover texture. Both its CPU bounds math
   (`getMercatorReferenceViewport`/`lngLatToMercatorCommon`,
   `modules/extensions/src/utils/projection-utils.ts:19-30,65-119`) and its shader
   (`shader-module.ts:92-125`) hard-code Web Mercator as the only non-globe geospatial
   projection. This was flagged by the Phase 2 review and is called out explicitly in
   `docs/api-reference/core/crs-viewport.md:226`: "`TerrainExtension` — its anchor math assumes
   a Mercator viewport."

Both block Fathom's 3D bathymetry from working correctly in the UTM `MapView` this branch adds.

## Goals / acceptance

1. `TerrainLayer` renders correctly-positioned tiled terrain (gridded elevation + hillshade
   texture) in a non-Mercator CRS `MapView`, for elevation sources indexed with the same
   `tileMatrixSet` mechanism Phase 2 already gave `TileLayer` — no reprojecting server, no new
   runtime dependency, no shader changes.
2. `SimpleMeshLayer` (`COORDINATE_SYSTEM.CARTESIAN`), positioned app-side via the CRS's forward
   transform, renders correctly under pitch/rotation in a CRS `MapView` — proven by a
   regression test, not new source.
3. Zero behavior change for existing paths: classic Mercator `TerrainLayer`/`TileLayer` usage,
   the non-tiled single-mesh `TerrainLayer` path (`bounds` prop already documented as "world
   coordinates" — i.e. already common-space units the caller supplies; unaffected by this
   item), and all `TerrainExtension` usage (untouched, unchanged Mercator-only behavior,
   explicitly documented as such).

## Non-goals

- **Warping public Web-Mercator terrain-RGB pyramids into CRS views** (Mapbox Terrain-RGB,
  AWS/Terrarium tiles) — the Phase-3-style problem with an added Z channel. Requires an
  in-repo elevation decode + fixed-grid mesh builder bypassing `@loaders.gl/terrain`'s Martini
  simplification (adaptive triangulation can't be losslessly reprojected after simplification).
  Future work; see Decisions for review #1.
- **`TerrainExtension` CRS support** (draping other layers onto terrain in a CRS view). Future
  work; see Decisions for review #2.
- **Adaptive/distortion-aware terrain mesh resolution.** Not attempted here; `meshMaxError`
  (Martini's own error tolerance) is untouched and continues to control mesh density exactly as
  today for the CRS-native path (this item changes only the *bounds rectangle* fed to the
  existing loader, not the loader's mesh-generation algorithm).
- **Elevation Z scaling / vertical datum conversion.** Out of scope; see Decisions for review
  #3.
- **`_WMSLayer`/`MVTLayer` interaction with terrain (`zRange` in CRS views).** Already
  documented elsewhere as ignored in CRS tile/warp views (`crs-tiles-design.md`,
  `crs-raster-warp-design.md:67`); unaffected by this item either way.

## Design

### Part 1 — `TerrainLayer`: CRS-native elevation tiling

**The fix is small because Phase 2 already computed everything it needs.** When
`_CRSTileset2D` indexes a tile from a `tileMatrixSet`, its `getTileMetadata()`
(`modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts:112-152`) already returns, per tile:

```ts
{
  bbox: {west, south, east, north},           // lnglat, for raster sublayers that need it
  boundsCRS: [minX, minY, maxX, maxY],         // native CRS-grid units
  boundsCommon: [                              // common space — a PURE AFFINE of boundsCRS
    (minX - extent[0]) * commonUnitsPerCRSUnit,
    (minY - extent[1]) * commonUnitsPerCRSUnit,
    (maxX - extent[0]) * commonUnitsPerCRSUnit,
    (maxY - extent[1]) * commonUnitsPerCRSUnit
  ]
}
```

`boundsCommon` is exact everywhere, not an approximation of a curved map: a
`tileMatrixSet`-indexed tile is by construction a rectangle in the CRS's own native grid units,
and common space for a CRS view *is* that same plane, only offset and uniformly rescaled
(Phase 1's normalization). No Jacobian, no `transform.forward`, no per-vertex reprojection is
needed — unlike Phase 3's Mercator-*source* problem (a source pyramid in a *different*
projection than the view, requiring an exact nonlinear transform per vertex), a CRS-native
source's tile rectangle already lands in view-CRS common space via one multiply-add.

`TerrainLayer` merely needs to (a) hand `tileMatrixSet` to its internal `TileLayer` so tiles are
indexed by `_CRSTileset2D` in the first place, and (b) consume `boundsCommon` when present
instead of re-deriving bounds via `viewport.projectFlat`:

```ts
// modules/geo-layers/src/terrain-layer/terrain-layer.ts

// renderLayers(): add tileMatrixSet to both the destructure (~line 341) and the
// `new TileLayer(...)` props object (~line 364), exactly mirroring every other
// TileLayer-forwarded prop already there (tileSize, maxZoom, extent, ...).

getTiledTerrainData(tile: TileLoadProps): Promise<MeshAndTexture> {
  const {elevationData, fetch, texture, elevationDecoder, meshMaxError} = this.props;
  const {viewport} = this.context;
  const dataUrl = getURLFromTemplate(elevationData, tile);
  const textureUrl = texture && getURLFromTemplate(texture, tile);
  const {signal} = tile;

  const boundsCommon = (tile as unknown as {boundsCommon?: Bounds}).boundsCommon;
  let bounds: Bounds;
  let clampLngLat: boolean;
  if (boundsCommon) {
    // CRS-native tile (tileMatrixSet set): _CRSTileset2D already computed the tile's
    // exact common-space rectangle — an affine of its native CRS-grid rectangle. No
    // reprojection needed; not an approximation.
    bounds = boundsCommon;
    clampLngLat = false;
  } else if (viewport.isGeospatial) {
    // Unchanged: classic Mercator-XYZ path.
    const bbox = tile.bbox as GeoBoundingBox;
    const bottomLeft = viewport.projectFlat([bbox.west, bbox.south]);
    const topRight = viewport.projectFlat([bbox.east, bbox.north]);
    bounds = [bottomLeft[0], bottomLeft[1], topRight[0], topRight[1]];
    clampLngLat = viewport instanceof GlobeViewport;
  } else {
    // Unchanged: non-geospatial path.
    const bbox = tile.bbox as Exclude<TileBoundingBox, GeoBoundingBox>;
    bounds = [bbox.left, bbox.bottom, bbox.right, bbox.top];
    clampLngLat = false;
  }
  const overlappedBounds = getOverlappedBounds(bounds, this.props.tileSize, clampLngLat);
  // ...unchanged from here: loadTerrain(overlappedBounds, ...), texture fetch, Promise.all
}
```

The two pre-existing branches are copied verbatim (only restructured to compute `bounds`/
`clampLngLat` first) — this is a zero-behavior-change diff for every caller that doesn't set
`tileMatrixSet`. `getOverlappedBounds` (unchanged) already pads proportionally
(`(bounds[2]-bounds[0])/tileSize`), which works in any unit, so no change is needed there beyond
passing `clampLngLat: false` for the new branch (the bounds aren't lnglat degrees, so the
existing ±180/±90 clamp must not apply).

Mesh rendering (`renderSubLayers`, `SimpleMeshLayer` with `_instanced: false`,
`COORDINATE_SYSTEM.CARTESIAN`, `getPosition: () => [0,0,0]`) is untouched: the mesh's own baked
XY is now correct common-space units regardless of source, exactly as it already is for classic
Mercator. Elevation Z is untouched per Decisions for review #3 — `TerrainWorkerLoader` decodes
`elevationDecoder` into raw meters and bakes them directly as mesh Z, same as today.

**The non-tiled path is unaffected and needs no fix.** `TerrainLayer`'s single-mesh `bounds`
prop is documented as "in world coordinates" (`terrain-layer.ts:44`) — the caller already
supplies pre-projected common-space units, the same convention as Part 2 below. It is verified,
not changed, by this item's tests.

### Part 2 — `SimpleMeshLayer`/`CARTESIAN` positioning: verify, document

No source change is proposed. The claim under test: given a `_CRSViewport` (pitch, bearing,
altitude — Phase 1 kept these viewport-generic; `2026-07-02-crs-mapview-design.md` lines 105-116
confirm the camera matrices are shared, CRS-agnostic code, only XY common-space mapping and the
Jacobian are CRS-specific), a `SimpleMeshLayer` with `coordinateSystem:
COORDINATE_SYSTEM.CARTESIAN` and positions computed by the app via `crs.transform.forward(lnglat)`
+ the Phase 1 common-space normalization (or directly via `viewport.projectFlat`, at the
position's own coordinate origin to avoid the Jacobian's off-center drift — same convention
`_WarpedTileLayer` and `MercatorCRSTileset2D` use for per-tile precision) projects to the same
screen position an independently computed camera transform predicts, at multiple pitch/bearing
combinations. This directly matches Fathom's current/planned mesh-bathymetry rendering
(`SimpleMeshLayer` from zarr-derived seabed meshes, positioned app-side) — nothing about the CRS
work changes how that path is used; this item only proves and documents it.

### Part 3 — `TerrainExtension`: explicitly out of scope

Documented as a known gap, not touched:
`docs/api-reference/core/crs-viewport.md:226` already states "`TerrainExtension` — its anchor
math assumes a Mercator viewport." This item leaves that line as-is (no code or doc claiming
otherwise) and files the generalization as a roadmap follow-up (see Decomposition).

## Quality / performance envelope

- Part 1's `boundsCommon` path is exact (an affine of an already-exact native-CRS rectangle) —
  no interpolation error, no grid-resolution tradeoff, unlike Phase 3's Mercator-source warp.
  Mesh detail is controlled entirely by the existing `meshMaxError` (Martini), unchanged.
- Part 1 adds no per-vertex CPU cost beyond what Phase 2's `_CRSTileset2D` already computes per
  tile (`getTileMetadata` runs once per tile load, already the case for classic Mercator's
  `bbox`).
- Part 2 adds zero runtime cost (test-only).
- Both parts: zero GPU/shader changes (no GLSL/WGSL parity risk).

## Testing strategy

- **Part 1, pure logic:** a `.node.spec.ts` for the tiled-bounds branch selection (extracted as
  a small testable function or exercised via a fake `tile`/viewport pair) — asserts
  `boundsCommon` is preferred when present and produces bit-identical bounds, and that the two
  legacy branches are byte-for-byte unchanged when `boundsCommon` is absent (regression against
  today's Mercator/non-geospatial behavior).
- **Part 1, layer integration:** extend `test/modules/geo-layers/terrain-layer.spec.ts`'s
  pattern with a `tileMatrixSet` + UTM `_CRSViewport` case (reusing
  `test/modules/core/viewports/crs-fixtures.ts`'s `UTM18N`), asserting the tileset resolved is
  `_CRSTileset2D` and the mesh's baked bounds match `tile.boundsCommon` exactly; re-run the
  existing Mercator test cases unchanged (regression).
- **Part 2:** a `.node.spec.ts` proving `_CRSViewport.project()` of a `CARTESIAN`-positioned
  point (computed via `crs.transform.forward`) matches an independently computed
  view-projection-matrix expectation at several pitch/bearing/zoom combinations — no headless
  GPU render needed, this is pure math on the viewport's own matrices (same technique Phase 1's
  own viewport tests already use).
- **Manual/visual:** extend `test/apps/crs-viewport` with a `TerrainLayer` + `tileMatrixSet`
  UTM elevation source (or a synthetic in-repo fixture if no public CRS-native DEM service is
  convenient) and a pitched `SimpleMeshLayer` mesh, screenshot both under pitch/rotate.

## Decomposition (this spec → one plan)

Single plan, 3 tasks: (1) `TerrainLayer` CRS-native tiling (Part 1: prop forwarding + bounds
branch + tests), (2) `SimpleMeshLayer`/`CARTESIAN` CRS positioning regression test + docs (Part
2), (3) docs updates (`crs-viewport.md`, `terrain-layer.md`, `table-of-contents.json`, the RFC's
Future work list) + app verification. Plan:
`docs/superpowers/plans/2026-07-05-crs-terrain-phase4.md`.

Filed as roadmap follow-ups, not part of this plan: generalizing `TerrainExtension` to CRS views
(Decisions for review #2), and warping public Web-Mercator terrain-RGB sources into CRS views
(Decisions for review #1, the Phase-3-with-Z problem).
