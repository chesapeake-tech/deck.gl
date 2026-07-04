# Design: CRS-Aware Tiles in @deck.gl/geo-layers (Phase 2)

**Date:** 2026-07-04
**Status:** Approved
**Motivation:** Phase 2 of the CRS MapView effort (see
`docs/superpowers/specs/2026-07-02-crs-mapview-design.md` and
`dev-docs/RFCs/proposals/crs-projection-mode-rfc.md`). Enables TiTiler-style basemaps in UTM
and `WorldCRS84Quad`/GIBS EPSG:4326 tile services — the remaining half of the
[#6216](https://github.com/visgl/deck.gl/discussions/6216) ask.
**Depends on:** Phase 1 (merged on `feat/crs-mapview`): `MapView.crs`, `_CRSViewport`,
`NormalizedCRS` (with `commonUnitsPerCRSUnit`), extent-relative zoom.

## Problem

`Tileset2D` routes all geospatial viewports (`viewport.isGeospatial === true`, which includes
`CRSViewport`) into `getOSMTileIndices` — a Web-Mercator quadtree traversal
(`modules/geo-layers/src/tileset-2d/utils.ts:316`). In a CRS view this selects the wrong tiles at
the wrong levels: tile grids for projected CRSs are defined by **OGC TileMatrixSet** (TMS)
definitions — per-level cell size, grid origin, and matrix dimensions in CRS units — not by the
OSM pyramid.

Phase 1's extent-relative zoom was chosen specifically so deck `zoom` maps directly onto
tile-matrix levels (RFC "Design decision: extent-relative zoom").

## Goals / acceptance scenarios

1. **EPSG:4326 tile service:** a `TileLayer` with a `WorldCRS84Quad`-family `tileMatrixSet`
   (e.g. NASA GIBS `EPSG4326_500m`) renders a correct, seamless basemap in a
   `MapView({crs: 'EPSG:4326'})`, fetching the right tiles per zoom.
2. **UTM tile grid:** a `TileLayer` with a custom UTM-zone TMS selects correct indices/levels in
   a `MapView({crs: UTM18N})` view (verified with a debug tile-outline renderer; no public UTM
   server is required for acceptance).
3. **Zero behavior change** for existing `TileLayer` usage (no `tileMatrixSet` prop): the OSM
   path and all existing tests are untouched.

## Non-goals

- **WMSLayer / `_WMSLayer` TMS support** — follow-up; same tileset class will plug in later.
- **MVTLayer in CRS views** — MVT content transform assumes Mercator tiles; follow-up.
- **Reprojecting Mercator tile sources into other CRSs** — that is Phase 3 (GPU warping).
- **TMS with variable-width coalesced tiles** (`variableMatrixWidths`) — rare polar profiles;
  rejected for scope.
- **Cross-CRS TMS** (TMS CRS ≠ view CRS): validated with a one-time warning, not supported.

## Design

### Extension seam

`Tileset2D` already exposes a public subclassing interface — `getTileIndices`, `getTileId`,
`getTileZoom`, `getTileMetadata`, `getParentIndex` — used by carto's `H3Tileset2D`/
`QuadbinTileset2D`, and `TileLayer` already has a `TilesetClass` prop. Phase 2 adds:

1. **`tile-matrix-set.ts`** (new, `modules/geo-layers/src/tileset-2d/`): pure types + math for a
   pragmatic subset of OGC TMS 2.0. No I/O, no viewport dependency.
2. **`crs-tileset-2d.ts`** (new, same dir): `CRSTileset2D extends Tileset2D` implementing
   TMS-driven indexing against a `CRSViewport`.
3. **`TileLayer.tileMatrixSet` prop**: when set (and `TilesetClass` is not customized), the layer
   instantiates `CRSTileset2D` and passes the TMS through tileset options.

### TileMatrixSet model (subset of OGC TMS 2.0)

```ts
type TileMatrix = {
  id: string;                                  // level identifier, e.g. '0'
  cellSize?: number;                           // CRS units per pixel (preferred)
  scaleDenominator?: number;                   // fallback: cellSize = sd * 0.28e-3 / metersPerUnit
  pointOfOrigin: [number, number];             // grid origin in CRS coords
  cornerOfOrigin?: 'topLeft' | 'bottomLeft';   // default 'topLeft'
  tileWidth: number; tileHeight: number;       // pixels
  matrixWidth: number; matrixHeight: number;   // tiles
};
type TileMatrixSet = {id?: string; crs?: string; tileMatrices: TileMatrix[]};
```

Normalization resolves `cellSize` (from `scaleDenominator` using the OGC 0.28 mm pixel and a
`metersPerUnit` parameter: 1 for meters CRSs, 111319.49079327358 for degrees), defaults
`cornerOfOrigin`, precomputes `tileSpanX/Y = cellSize * tileWidth/Height`, and validates that
levels are ordered coarse → fine (strictly decreasing `cellSize`).

### Level selection

Viewport CRS-units-per-pixel: `2^-(viewport.zoom + zoomOffset) / crs.commonUnitsPerCRSUnit`
(Phase 1: pixels per common unit = `2^zoom`; common units per CRS unit =
`512 / extentWidth`). Select the tile matrix minimizing `|log2(cellSize / target)|`, ties to the
finer level — mirroring the OSM `Math.round` behavior in log space, and independent of tile pixel
size (256px vs 512px TMS levels resolve automatically because `cellSize` is per pixel).
`minZoom`/`maxZoom` tileset options clamp the selected **level index**.

### Index range

View bounds in CRS units: unproject the 4 screen corners (`viewport.unproject`) → `crs.transform.forward`
each → min/max, dropping non-finite corners (out-of-domain horizon); intersect with the
forward-projected `extent` option (lnglat `[west, south, east, north]`) when provided. Tile
range at the selected matrix: floor/ceil over `tileSpan` from `pointOfOrigin` (y flipped for
`topLeft`), clamped to `matrixWidth/Height`.

### Tile index and identity

Indices are `{x, y, z, tm}` where `z` is the **array position** in `tileMatrices` (numeric, used
by `getTileZoom` and refinement) and `tm` is the TMS level `id` **string**. Because
`getURLFromTemplate` substitutes every key of `index`, URL templates may use `{z}` (array
position) or `{tm}` (authoritative TMS id) — these differ only for TMSs with non-sequential ids.
`getTileId`/`getTileZoom` are inherited from the base class.

### Tile metadata

`getTileMetadata` returns:
- `bbox: GeoBoundingBox` (`{west, north, east, south}`) — min/max of the 4 inverse-projected
  CRS-rect corners. Exact for 4326; a tight bound for curved CRSs. Keeps `Tile2DHeader.
  boundingBox` and screen-space culling working unchanged.
- `boundsCRS: [minX, minY, maxX, maxY]` — the exact tile rect in CRS units.
- `boundsCommon: [minX, minY, maxX, maxY]` — the same rect in common-space units
  (`(v - crs.extent) * commonUnitsPerCRSUnit`). Raster sublayers position exactly with
  `BitmapLayer` + `COORDINATE_SYSTEM.CARTESIAN` using these bounds (Phase 1 documents CARTESIAN
  as pre-normalized common space). For 4326 views the plain lnglat `bbox` is already exact.

### Parent index (refinement)

TMSs are not guaranteed quadtrees (e.g. `matrixHeight` growing 14 → 28 → 56 in a UTM demo TMS).
`getParentIndex` computes geometrically: child tile center in CRS units → containing tile at
level `z-1`.

### Viewport requirement

`CRSTileset2D.getTileIndices` requires a viewport with a `crs` (i.e. `_CRSViewport`); it throws
an informative error otherwise. If `tileMatrixSet.crs` is provided and its EPSG code does not
match `viewport.crs.code`, warn once via core `log`. The viewport passed to `getTileIndices` is
stashed on the instance for `getTileMetadata`/`getParentIndex` (the base class's `_viewport` is
private).

### TileLayer integration

- New prop `tileMatrixSet?: TileMatrixSet | null` (default `null`, deep-compared).
- Class selection: `tileMatrixSet` set and `TilesetClass === Tileset2D` (the default) →
  `CRSTileset2D`; an explicit custom `TilesetClass` always wins.
- `tileMatrixSet` identity change finalizes and recreates the tileset (the tileset is otherwise
  created once).
- Without `tileMatrixSet`, behavior is bit-identical to today (including in CRS views, where the
  OSM path remains wrong — documented, with the new prop as the fix).

### Exports

From `@deck.gl/geo-layers`: `_CRSTileset2D`, types `TileMatrixSet`, `TileMatrix`
(following the `_Tileset2D` experimental-underscore convention for classes, plain type exports).

## Error envelope

- Level selection and index math are exact (pure arithmetic on the TMS definition).
- `bbox` (lnglat) is the axis-aligned hull of a projected quad — used only for culling and
  data-fetch hints, both tolerant of over-coverage.
- Raster positioning via `boundsCommon`/CARTESIAN is exact in the view CRS. Positioning via
  lnglat `bbox` + LNGLAT linearization inherits Phase 1's error envelope (exact for 4326,
  sub-pixel at survey scales).

## Testing strategy

- Pure math (`tile-matrix-set.ts`): node specs against a GIBS-style `WorldCRS84Quad`-512 fixture
  and a non-square UTM 18N demo TMS; `scaleDenominator` resolution and `bottomLeft` origin cases.
- `CRSTileset2D`: node specs constructing real `_CRSViewport`s (reusing
  `test/modules/core/viewports/crs-fixtures.ts`) asserting level selection, index sets, metadata
  and parent chains for both 4326 and UTM.
- `TileLayer`: headless lifecycle spec (`testLayerAsync`) asserting tileset class selection and
  tile loads under a CRS viewport; full suite for regression.
- Manual/visual: extend `test/apps/crs-viewport` — GIBS BlueMarble basemap in the 4326 mode,
  debug tile outlines in the UTM mode, OSM in Mercator mode (regression).

## Decomposition (this spec → one plan)

Single plan, 4 tasks: (1) TMS types+math, (2) `CRSTileset2D`, (3) `TileLayer` prop + exports +
docs, (4) visual verification app. Plan:
`docs/superpowers/plans/2026-07-04-crs-tiles-phase2.md`.
