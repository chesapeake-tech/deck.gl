# Design: MVT in CRS Views + MapLibre Style Adapter (Chunk E, E1 — promoted and expanded)

**Date:** 2026-07-05
**Status:** Proposed
**Motivation:** Chunk E, item E1 of the CRS follow-on roadmap
(`docs/superpowers/specs/2026-07-05-crs-roadmap.md:50-51`): "MVT in CRS views — wgs84-decode
route + `MercatorCRSTileset2D` selection; costs the binary fast path. Spec-first." E1 was
originally the last, most-deferred chunk ("Chunk E — deferred features (largest, last)"). It is
promoted here because Fathom's (Clarity's underwater-survey platform) motivating hybrid case
needs it now: a warped Web-Mercator raster reference basemap (Esri Ocean, via Phase 3's
`_WarpedTileLayer`) with a **vector** reference layer of point labels (soundings, place names,
navigation aids — Esri "Ocean Reference" style MVT service) drawn on top, all inside one UTM
`MapView`. This spec expands E1 in two independently shippable stages: Stage 1 is the item as
originally scoped (MVTLayer works in CRS views); Stage 2 is a new, larger surface — a MapLibre
style-spec adapter — added because once vector tiles render correctly in a CRS view, the next
question every evaluator asks is "can I point it at an existing MapLibre style JSON instead of
hand-writing accessors," per visgl/deck.gl discussion #6892 (opened 2022, unresolved, cites the
same ask twice).
**Depends on:** Phase 1 (`MapView.crs`, `_CRSViewport`, `PROJECTION_MODE.CRS`, the
Jacobian+Hessian common-space projection); Phase 2 (`_CRSTileset2D`, `tile-matrix-set.ts`,
`TileLayer`'s `tileMatrixSet` prop, already wired through to any `TileLayer` subclass including
`MVTLayer` — see Design, Stage 1); Phase 3 (`_WarpedTileLayer`, `MercatorCRSTileset2D`,
precedent for a Mercator-specific raster tile-selection class distinct from the CRS-native one —
this spec corrects a roadmap-wording ambiguity between the two; see Decisions for review #1
footnote in Stage 1). Chunk A1 (METER_OFFSETS Jacobian rotation) is orthogonal — Stage 1 uses
only the LNGLAT common-space path, not METER_OFFSETS.

## Decisions for review

Settled below with justification; flagged here because they are user-facing or affect the
branch's stated policies (no new runtime deps, zero behavior change outside CRS views):

1. **Stage 2 module placement: inside `@deck.gl/geo-layers`, not a new package.** No
   `@deck.gl/experimental` package exists on this branch or upstream; the established
   convention is an underscore-aliased export from an existing package's barrel
   (`_WMSLayer`, `_CRSTileset2D`, `_WarpedTileLayer` all in `modules/geo-layers/src/index.ts`;
   `_CRSViewport`, `_GlobeView` in `@deck.gl/core`; `_TerrainExtension` in
   `@deck.gl/extensions`). A new package would add a whole release/build/versioning surface
   for one experimental, single-purpose module, and `geo-layers` is already where the
   adapter's two real dependencies live (`MVTLayer`, `TileLayer`'s tile-source machinery).
   Placement: `modules/geo-layers/src/maplibre-style-layer/`, exported as
   `_MapLibreStyleLayer` (mirroring the `_WarpedTileLayer` naming/doc pattern — "Experimental"
   in its own `.md` page title, no TOC "Experimental" section since none exists).
2. **Style-spec evaluator: injected, not bundled — mirrors `CRSDefinition`/`createProj4CRS`
   exactly.** The branch's established pattern for keeping `@deck.gl/core` free of a
   projection-library runtime dependency is `CRSDefinition.transform: {forward, inverse}` —
   the app constructs the transform (e.g. via `@math.gl/proj4`'s `Proj4Projection`, only ever
   imported by fixtures/tests: `test/modules/core/viewports/crs-fixtures.ts:1,5`) and hands
   deck.gl the two functions (`modules/core/src/viewports/crs-utils.ts:445-469`,
   `createProj4CRS`'s doc comment: "stays free of a runtime dependency on proj4; bring
   whichever converter your app already constructed"). This spec applies the identical shape
   to MapLibre style evaluation: the adapter accepts a small `MapLibreStyleEvaluator`
   interface (`createPropertyExpression`, `featureFilter` — the two entry points actually
   used, not the whole package) as a constructor argument; the app imports
   `@maplibre/maplibre-gl-style-spec` itself and passes its exports through. `@deck.gl/geo-layers`
   never imports it. Precedent for the *devDependency-for-tests* half of this pattern already
   exists: `@math.gl/proj4` is a root `package.json` devDependency (`package.json:54`), used
   only by test fixtures and specs (`test/modules/core/viewports/crs-fixtures.ts`,
   `crs-utils.node.spec.ts`, `create-proj4-crs.node.spec.ts`), never by `@deck.gl/core`'s
   published `dependencies`. `@maplibre/maplibre-gl-style-spec` is added as a root devDependency
   the same way (v25.x; confirmed dual ESM/CJS, ~6 tiny transitive deps of its own, already
   present transitively in this repo's `node_modules` at v24.3.1 via `maplibre-gl`, so no new
   *installed* package tree of consequence — only a new explicit devDependency line and a
   pinned major version for test determinism). Precedent for the adapter architecture itself
   (not just the injection idiom): OpenLayers' `ol-mapbox-style` uses this exact package's
   `createPropertyExpression`/`featureFilter` (aliased `createFilter`) to compile MapLibre
   style layers once and evaluate them per-OpenLayers-feature — the deck.gl adapter mirrors
   its compile-once/evaluate-per-feature architecture, inverting only the dependency direction
   (injected, not imported) to match this branch's policy.
3. **Zoom re-evaluation: per-integer-zoom, not continuous.** MapLibre's own style-spec
   "interpolate"/"exponential" zoom functions are defined as camera functions between integer
   zoom *stops*; `createPropertyExpression`'s `'camera'`/`'composite'` result kinds expose
   `zoomStops`, and upstream mapbox-gl-js/maplibre-gl-js itself re-buckets symbol layout and
   re-evaluates camera expressions once per integer zoom level internally (tile buckets are
   built per integer zoom), not continuously per frame. The adapter's v1 re-evaluation
   strategy: bucket to `Math.floor(viewport.zoom)`, wire it into each generated layer's
   `updateTriggers` (`getFillColor`, `getLineWidth`, `getLineColor`, `getElevation`,
   `getSize`, `getCollisionPriority`, ... — whichever accessors were compiled from
   zoom-dependent (`'camera'`/`'composite'`) expressions only; zoom-independent
   (`'constant'`/`'source'`) expressions get no updateTrigger and are evaluated once).
   Rejected: continuous re-evaluation (recomputing every accessor every render frame,
   regardless of whether the camera function actually changes value within the current
   integer zoom bucket) — this defeats deck.gl's attribute-diffing update model (every
   accessor becomes "always dirty"), for a visual difference that is bounded by the
   MapLibre-defined interpolation curve's max slope over one zoom unit (typically small for
   the base-2 curves used in real styles) and is itself how upstream MapLibre already
   discretizes. Cost/benefit: per-integer bucketing is O(zoom levels) attribute rebuilds per
   session instead of O(frames); a future v2 could special-case "continuous" for cheap
   scalar-only expressions if a style author demonstrably needs sub-zoom-level smoothness, but
   no such case is known today and it is out of v1 scope.
4. **Curved-label fallback: horizontal label at the line's midpoint, not omission.** MapLibre's
   `symbol-placement: 'line'` (curved/along-line label placement, arbitrary glyph rotation per
   line segment) has no deck.gl equivalent — `TextLayer` places one anchored, optionally
   rotated (`getAngle`), horizontal-per-instance label per data point; it does not lay out
   glyphs along a path. Two choices: omit the label entirely (silently drop line-placed symbol
   layers), or approximate with a single horizontal `TextLayer` label anchored at the line's
   midpoint (reusing the exact point-symbol code path built for `symbol-placement: 'point'`,
   with `getAngle: 0` — or optionally the line's local bearing at the midpoint, still a single
   flat rotation, not a curve). **Decision: approximate at the midpoint.** Justification:
   silent omission is indistinguishable from an adapter bug (a road/river with a label in the
   source style simply has no rendered label, with nothing in the visual output signaling
   "this is a known, documented gap" — a station reviewing map output has no way to tell
   intentional-cut from broken-adapter); a midpoint label costs zero new sublayer code (it is
   the point-symbol path with one geometry-to-point reduction step) and gives at least
   presence/searchability of the label text, which several simplified/static map renderers
   already treat as an acceptable degradation for exactly this reason. The cost — no curve, no
   repeated-label-along-long-features, wrong anchor for very long or sharply curved lines — is
   real and is documented prominently (adapter emits one `console.warn` per distinct
   style-layer `id` the first time a `symbol-placement: 'line'` layer is encountered, and the
   limitation is called out in the module's doc page). This does not affect Fathom's
   motivating case, which is point-placed reference labels, not line labels.
5. **Stage 1's honest perf cost: `wgs84` decode mode allocates; `binary` mode does not — and
   CRS views cannot use `binary` in v1.** `binary: true` (MVTLayer's default,
   `modules/geo-layers/src/mvt-layer/mvt-layer.ts:52`) exists specifically to avoid per-feature
   JS object/array allocation — tile content stays in typed arrays
   (`BinaryFeatureCollection`) all the way to the GPU buffer upload. `coordinates: 'wgs84'`
   mode (the CRS route; see Stage 1 Design) requires `shape: 'geojson'` (binary forced
   `false`), which allocates a `Feature[]` per tile via `binaryToGeojson` plus a `lerp` +
   `unprojectFlat` call per vertex (`modules/geo-layers/src/mvt-layer/coordinate-transform.ts`)
   to convert tile-local `[0,1]` coordinates to lnglat. This is the exact tradeoff already
   accepted, silently, for `GlobeView` today (`initializeState`,
   `mvt-layer.ts:130-131`: "GlobeView doesn't work well with binary data") — Stage 1 does not
   invent a new cost, it extends an already-shipped one to a second projection mode. It is
   real and should be sized before high-feature-density CRS+MVT deployments: expect the same
   GC/allocation profile Globe-mode MVT users already have. No mitigation is proposed in v1
   (see Non-goals); a future binary-mode CRS path would need typed-array reprojection in the
   loader itself, out of scope here.

## Problem

Two gaps block the Fathom hybrid case and the broader "style the vector tiles like MapLibre
does" ask:

1. **`MVTLayer` is not CRS-aware.** `docs/api-reference/core/crs-viewport.md:260`: "`MVTLayer`
   and `_WMSLayer` are not yet CRS-aware." `dev-docs/RFCs/proposals/crs-projection-mode-rfc.md:193`:
   "`_WMSLayer`/`MVTLayer` support is future work." `docs/superpowers/specs/2026-07-04-crs-tiles-design.md:39`:
   "MVTLayer in CRS views — MVT content transform assumes Mercator tiles; follow-up." Concretely:
   `MVTLayer.renderSubLayers` (`mvt-layer.ts:264-273`) unconditionally builds a Web-Mercator
   power-of-two tile transform (`modelMatrix` scaling by `WORLD_SIZE / 2^z`,
   `coordinateOrigin` from `x/y/2^z`, `COORDINATE_SYSTEM.CARTESIAN`) for every viewport except
   `GlobeView` (gated by `viewport.resolution !== undefined`, a Globe-only signal) — a plain
   `_CRSViewport` falls through to this Mercator branch exactly like a classic
   `WebMercatorViewport` does, which is wrong for non-Mercator CRS content.
2. **No path from a MapLibre/Mapbox style JSON to deck.gl layers.** visgl/deck.gl discussion
   #6892 (opened by corrigancd, 2022; maintainer response declined due to spec-maintenance
   burden, no committed timeline; a second requester in 2023 hit the same gap for a different
   host context) asks exactly this: render MVT content styled by an existing MapLibre style,
   without hand-translating every paint/layout property to deck.gl accessors. OpenLayers solved
   the equivalent problem with `ol-mapbox-style`, proving the architecture (compile style-spec
   expressions once, evaluate per-feature) is portable to a non-Mapbox-GL rendering stack.

Fathom's driving scenario needs both: a warped Esri Ocean Mercator raster basemap (Phase 3,
already solved) plus Esri's companion "Ocean Reference" vector layer — political boundaries,
soundings, and (critically) point labels — styled per Esri's published MapLibre-compatible
style, rendered correctly co-registered in a UTM `MapView`.

## Goals / acceptance

### Stage 1 — MVT in CRS views (independently shippable; this alone satisfies E1 as originally scoped)

1. `MVTLayer` with `tileMatrixSet` set renders polygon/line/point vector-tile content, correctly
   positioned, inside a non-Mercator CRS `MapView` — via `_CRSTileset2D` tile selection (already
   generic through `TileLayer`, Phase 2) + the `wgs84` coordinate-decode route (already exists,
   currently gated to `GlobeView` only) + the existing `PROJECTION_MODE.CRS` LNGLAT common-space
   path (Phase 1, Jacobian + Hessian; zero new shader code).
1b. **`MVTLayer` *without* `tileMatrixSet` — the universal case — also renders correctly in a CRS
   `MapView`.** This is the shape nearly every real MVT source actually has (Esri's "Ocean
   Reference" service and most other public vector-tile endpoints are classic Mercator XYZ
   pyramids, not CRS-native `tileMatrixSet`-described sources). `MVTLayer._getTilesetClass()`
   (new override) selects `MercatorCRSTileset2D` — the same class `_WarpedTileLayer` (Phase 3)
   already uses to reproject a CRS view's bounds into Mercator source space for raster
   warping — whenever the viewport is a CRS view and no `tileMatrixSet`/custom `TilesetClass`
   is set. Its `getTileMetadata()` lnglat `bbox` feeds the same `wgs84`-decode route item 1 uses,
   with no glue code (see Design). This closes what Stage 1 originally shipped as a warn-once,
   unspecified-behavior gap (review Finding 2) — see Design for the full account.
2. Picking, `autoHighlight`, and `highlightedFeatureId` behave correctly in CRS views — proven
   by regression tests, not new code (see Design: these paths are already coordinate-agnostic
   or already exercised by the pre-existing Globe+wgs84 combination).
3. Tile-edge clipping is skipped for CRS views exactly as it already is for `GlobeView` (same
   generalized condition, not new clip logic).
4. **Zero behavior change** for every existing MVTLayer usage: classic Mercator (`binary: true`
   default) and existing `GlobeView` (`wgs84`, `binary: false`) paths are byte-identical after
   this change — both are regression-tested.
5. **Acceptance scenario (Fathom hybrid case, corrected — the real, Esri-shaped motivating
   case):** in one UTM `MapView`, a warped Esri Ocean basemap (`_WarpedTileLayer`, Phase 3,
   unchanged) renders underneath an `MVTLayer` **without `tileMatrixSet`** — a classic Mercator
   XYZ vector-tile service (Esri's "Ocean Reference" point-label layer is exactly this shape;
   Esri does not publish a CRS-native/`tileMatrixSet`-described vector service) — automatically
   routed through `MercatorCRSTileset2D` (item 1b) and rendered via `GeoJsonLayer`'s
   point/`TextLayer` sublayer path — both correctly co-registered at multiple zooms and after
   pan/zoom, with the vector point labels landing on their correct UTM-projected positions
   (verified against an independently computed `crs.transform.forward` expectation, the same
   technique Phase 3/4's tests already use). A `tileMatrixSet`-described CRS-native source
   remains supported (item 1) but is the less common case in practice — both are tested.

### Stage 2 — MapLibre style-spec adapter (independently shippable; depends on Stage 1 only insofar as it is commonly used together, not in code)

1. A new experimental module, `_MapLibreStyleLayer` (name TBD at implementation, working name
   used throughout this spec), takes `(style: StyleSpecification, source: {tiles, tileMatrixSet?},
   evaluator: MapLibreStyleEvaluator)` and returns a `LayersList` — one deck.gl layer (or
   sublayer group) per MapLibre style layer, in style-JSON `layers` order (for correct
   z-ordering), each filtered (`filter`) and styled (paint/layout expressions) per-feature.
2. v1 fidelity tiers (see Design for the mapping table):
   - **In scope:** `background`, `fill` (+ `fill-opacity`, `fill-color`, `fill-outline-color`),
     `line` (+ `line-width`, `line-color`, `line-dasharray` via `PathStyleExtension`),
     `fill-extrusion` (+ `fill-extrusion-height`/`-base` via `SolidPolygonLayer`'s
     `extruded`/`getElevation`), a sprite sheet (`sprite` URL pair) mapped to `IconLayer`'s
     `iconAtlas`/`iconMapping` with a thin key-shape transform, and `symbol` point-placement
     labels via `TextLayer` + `CollisionFilterExtension` (font stacks approximated by one
     resolved browser `fontFamily`; `symbol-sort-key`/layer paint priority mapped to
     `getCollisionPriority`).
   - **Out of scope, documented (not silently missing):** `symbol-placement: 'line'` curved
     labels (Decisions for review #4 — approximated at the line midpoint, not omitted, but
     documented as a fidelity cut), `line-gradient`, `fill-pattern`, `raster`/`hillshade`/
     `heatmap` style layers (skipped with a `console.warn` per encountered layer type), glyph
     PBF font parity (browser-font approximation only, no SDF glyph-atlas fetch/parity with
     the style's declared `glyphs` URL).
3. **Acceptance scenario:** the same Fathom hybrid case as Stage 1 (item 5, corrected — the
   `MercatorCRSTileset2D`-auto-routed, no-`tileMatrixSet` vector source, matching Esri's actual
   published service shape), but the vector reference layer's styling (colors, line dash for
   boundaries, point-label text/placement/priority) comes from feeding Esri's actual
   MapLibre-compatible style JSON through the adapter, rather than hand-written deck.gl
   accessors — i.e., Stage 2's acceptance is Stage 1's acceptance scenario with the styling
   authored declaratively instead of by hand.
4. **Zero new runtime dependency** in any published `@deck.gl/*` package (Decisions for review
   #2) — `@maplibre/maplibre-gl-style-spec` is a root devDependency only, imported by tests and
   by consuming applications, never by `@deck.gl/geo-layers`'s own `dependencies`.

## Non-goals

- **Stage 1: `binary: true` (typed-array fast path) in CRS views.** Explicitly unsupported in
  v1, not a TODO — `binary` is forced `false` whenever the wgs84/CRS route is taken (mirroring
  the existing Globe behavior verbatim). See Decisions for review #5.
- **Stage 1: the roadmap's literal wording — corrected twice; both classes are needed, for two
  different source shapes.** `docs/superpowers/specs/2026-07-05-crs-roadmap.md:51` names
  `MercatorCRSTileset2D` as the tile-selection class for E1. An earlier revision of this spec
  (and this branch's first Stage 1 implementation) judged that imprecise and out of scope,
  reasoning that `MercatorCRSTileset2D` (`modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts:36`)
  is Phase 3's raster-only warp mechanism, unrelated to vector content, and that `_CRSTileset2D`
  (`modules/geo-layers/src/tileset-2d/crs-tileset-2d.ts`, already reachable via `tileMatrixSet` +
  `TileLayer._getTilesetClass()`, `tile-layer.ts:275-281`) was the only class this item needs.
  Review caught the gap: `_CRSTileset2D` only covers CRS-native (`tileMatrixSet`-described)
  vector sources — but the *universal* real-world case (Esri's "Ocean Reference" service and
  most public MVT endpoints) is a classic Mercator XYZ pyramid with no `tileMatrixSet` at all,
  and that case had no CRS-view route (Stage 1's original warn-once was unspecified,
  not-actually-working behavior for exactly this case). **Both classes are needed, selected by
  `MVTLayer._getTilesetClass()`'s new override based on whether `tileMatrixSet` is set** (see
  Goals #1/#1b, Design): `_CRSTileset2D` for CRS-native sources, `MercatorCRSTileset2D` for
  classic Mercator-pyramid sources viewed through a CRS `MapView`. The roadmap line's wording
  (`MercatorCRSTileset2D` for E1) turns out to have been correct for the case that matters most
  in practice, if incomplete (it did not mention `_CRSTileset2D` for the CRS-native case, which
  remains supported too) — this spec supersedes the roadmap line's wording with the complete,
  two-class picture.
- **Stage 1: non-integer/adaptive tile LOD, far-field pitched-view over-fetch.** Pre-existing,
  documented `_CRSTileset2D`/`MercatorCRSTileset2D` limitation (Chunk B1); unaffected either way
  by this item.
- **Stage 1: `zRange`/pitch-based visibility culling nuances in CRS views.** Already documented
  elsewhere as a pre-existing limitation (`crs-tiles-design.md`, `crs-raster-warp-design.md:67`,
  `crs-terrain-design.md` Non-goals); unaffected by this item.
- **Stage 2: `symbol-placement: 'line'` true curved labels, `line-gradient`, `fill-pattern`,
  `raster`/`hillshade`/`heatmap` style layers, glyph-PBF font parity.** See Goals #2 and
  Decisions for review #4 for the one partial exception (midpoint-label approximation).
- **Stage 2: style spec versions/features beyond what `@maplibre/maplibre-gl-style-spec`
  itself parses** (e.g. speculative/experimental MapLibre-only spec extensions not yet in a
  released style-spec version) — the adapter is only as current as the evaluator version the
  app injects.
- **Stage 2: a style *editor*, live style-diffing, or MapLibre GL JS interop/co-rendering.**
  This is a one-way style-JSON-to-deck.gl-layers converter, not a MapLibre GL JS replacement or
  companion renderer.
- **Stage 2: continuous (sub-integer-zoom) paint re-evaluation.** See Decisions for review #3.

## Design

### Stage 1 — MVT in CRS views

**Headline finding: `GlobeView` already exercises almost the exact code path this item needs.**
`MVTLayer` already has a second, non-Mercator-CARTESIAN rendering mode — built for `GlobeView`,
gated everywhere by `viewport.resolution !== undefined` (a signal only `GlobeViewport` sets):

| Site | Globe-only condition today | Behavior in that branch |
|---|---|---|
| `initializeState` (`mvt-layer.ts:130-131`) | `viewport.resolution !== undefined` | forces `binary = false` |
| `getTileData` (`mvt-layer.ts:236`) | `viewport.resolution ? 'wgs84' : 'local'` | loader decodes tile-local coords straight to lnglat (`transform()`/`transformTileCoordsToWGS84`, `coordinate-transform.ts:49-62`, a generic lerp between the tile's lnglat bbox corners — works for any viewport, not Mercator-specific) |
| `renderSubLayers` (`mvt-layer.ts:268-273`) | `!viewport.resolution` | Mercator `modelMatrix`/`coordinateOrigin`/`CARTESIAN`/`ClipExtension` branch is **skipped**; sublayer falls through to plain `GeoJsonLayer` defaults (`COORDINATE_SYSTEM.LNGLAT`) |
| `getPickingInfo` (`mvt-layer.ts:326-332`), `_isWGS84()` (`mvt-layer.ts:313-315`) | `!this._isWGS84()` | skips the tile-local→lnglat transform on the picked feature (already lnglat) |

That is: Globe mode already renders MVT content as plain lnglat `GeoJsonLayer` features with no
Mercator tile transform and no `ClipExtension`, and picking/highlight already handle that
combination correctly (`_updateAutoHighlight`/`findIndexBinary`/`getHighlightedObjectIndex` are
feature-ID/index-based, not coordinate-based — no change needed there at any zoom/projection).
**The fix is to route `PROJECTION_MODE.CRS` viewports through this same, already-proven branch**,
not to build a new one.

Concretely:

1. Introduce one shared predicate (replacing the four independent `viewport.resolution`
   checks above) — e.g. `usesFeatureRoute(viewport): boolean` returning true for `GlobeView`
   (`viewport.resolution !== undefined`, unchanged) **or** `viewport.projectionMode ===
   PROJECTION_MODE.CRS` (new). Every one of the four call sites above switches to this
   predicate; no other source change to those methods is needed — the Globe branches were
   already coordinate-system-generic (the lerp-to-lnglat transform, the lnglat `GeoJsonLayer`
   default, the feature-ID picking) precisely because Globe was the branch's first non-Mercator
   consumer.
2. **Tile selection: CRS-native (`tileMatrixSet` set) needs no new code.** `MVTLayer extends
   TileLayer` (`mvt-layer.ts:112` region) and inherits `TileLayerProps.tileMatrixSet`
   (`tile-layer.ts:78`); `TileLayer._getTilesetClass()` (`tile-layer.ts:275-281`) already
   switches to `_CRSTileset2D` whenever `tileMatrixSet` is set, regardless of layer subclass —
   this is the exact mechanism Phase 4's `TerrainLayer` fix reused, and `MVTLayer` gets it for
   free by inheritance. `_CRSTileset2D.getTileMetadata()`'s `bbox` field
   (`crs-tileset-2d.ts:171-176`) already returns the `{west, south, east, north}`
   `GeoBoundingBox` shape `transformTileCoordsToWGS84` already expects
   (`mvt-layer.ts:471-492` region) — no glue code between tile metadata and the coordinate
   transform.
3. **Tile selection: the universal, no-`tileMatrixSet` case — `MVTLayer` overrides
   `_getTilesetClass()`.** (Review Finding 2; corrects Stage 1 as originally shipped.) Most real
   MVT sources — Esri's "Ocean Reference" vector service, most public MVT endpoints — are
   classic Mercator XYZ pyramids, described by no `tileMatrixSet` at all. Before this fix, that
   left a genuine design hole: `TileLayer`'s default `_getTilesetClass()` falls through to the
   base `Tileset2D`, whose implicit tile scheme (`worldScale = 2^z`, `WORLD_SIZE = 512`
   power-of-two Mercator quadtree, `../tileset-2d/utils.ts`) treats the CRS viewport's zoom/
   bounds as if they were Mercator — meaningless for a UTM (or any non-Mercator) view. Stage 1
   as originally shipped only detected this (a `log.warn` once) rather than fixing it; the
   fix routes it through `MercatorCRSTileset2D` (`modules/geo-layers/src/warped-tile-layer/mercator-crs-tileset-2d.ts:36`)
   automatically — the same class `_WarpedTileLayer` (Phase 3) already uses to reproject a CRS
   view's bounds into Mercator source space for raster tile warping. `MVTLayer._getTilesetClass()`
   (new override, `mvt-layer.ts`) selects it when: the viewport is a CRS view
   (`projectionMode === PROJECTION_MODE.CRS`), `tileMatrixSet` is unset, and `TilesetClass` has
   not been explicitly overridden by the caller (that override always wins, matching
   `TileLayer`'s own policy). `MercatorCRSTileset2D`'s `getTileMetadata()` also returns a lnglat
   `bbox` (`{west, south, east, north}`) — the exact same shape `_CRSTileset2D` returns and the
   wgs84 decode route (item 1/step 1 above) already consumes, so no additional glue code is
   needed between the two tileset classes and the rest of `MVTLayer`. Its
   `sourceTileMatrixSet`/`sourceCrs` options (`_WarpedTileLayer`-specific, used to warp a
   *non*-Mercator raster source) are left unset by `MVTLayer`, which is safe: `resolveWarpSource`
   (`warp-mesh.ts`) defaults to the built-in Web-Mercator source when both are omitted — exactly
   the plain Mercator-pyramid vector case this item targets, no raster/warp-specific option
   required outside `_WarpedTileLayer`.
   **Why this lives in `MVTLayer`, not `TileLayer` generically:** only a layer whose sublayer
   rendering consumes `getTileMetadata()`'s lnglat `bbox` (as `MVTLayer`'s wgs84/feature route
   already does, via `transformTileCoordsToWGS84`) can render tiles indexed this way correctly.
   A plain `TileLayer` (or any subclass that hasn't opted into that decode route) still positions
   tiles with the Mercator-quadtree power-of-two `modelMatrix` (`mvt-layer.ts`'s own
   `renderSubLayers`, Mercator branch) — which does not match `MercatorCRSTileset2D`'s tile
   rects. `_WarpedTileLayer` already handles that exact mismatch itself, via its own
   mesh-warping `renderSubLayers` — a generic `TileLayer`-level promotion would bypass that and
   silently mis-render any other `TileLayer` subclass that doesn't do the same. The promotion is
   therefore layer-specific (an `_getTilesetClass()` override), not a `TileLayer`-wide change.
   The previously-shipped warn-once (Stage 1 Task 3) is now obsolete for this combination — it
   is removed, since the combination it flagged is now a supported, tested route, not an
   unspecified one.
4. **`getHighlightedObjectIndex`** (`mvt-layer.ts:344` region) reads `tile.content` and branches
   internally on `this.state.binary`; since `binary` is already forced `false` for the wgs84
   route (step 1), this method's non-binary branch is exactly the one `GlobeView` already
   exercises today — Stage 1 adds a regression test asserting this, not new logic.
5. **`ClipExtension` skip.** `renderSubLayers`'s `if (!this.context.viewport.resolution)`
   (`mvt-layer.ts:268`) becomes `if (!usesFeatureRoute(viewport))` — for CRS views, no
   `ClipExtension` is added, matching Globe (tile seams are a pre-existing, separately tracked
   concern — Chunk B2 — for every non-Mercator-CARTESIAN MVTLayer mode already, not introduced
   here).

No shader/GLSL change: lnglat-coordinate features route through `getOffsetOrigin`
(`modules/core/src/shaderlib/project/viewport-uniforms.ts:81`, `case PROJECTION_MODE.CRS`
already grouped with `WEB_MERCATOR_AUTO_OFFSET` for `coordinateSystem === 'lnglat'`) into
`project.glsl.ts`'s existing `PROJECTION_MODE_CRS` branch (`project.glsl.ts:235-264`, the
Jacobian-times-degree-offset plus the quadratic Hessian correction term, JS-side uniforms from
`getCRSJacobianAtOrigin`/`getCRSHessianAtOrigin`,
`modules/core/src/viewports/crs-utils.ts:243-250,307-348`) — the exact same path every other
lnglat-coordinate layer (`GeoJsonLayer`, `ScatterplotLayer`, ...) already uses in a CRS view.
`MVTLayer`'s only job is to hand its `GeoJsonLayer` sublayer plain lnglat coordinates, which
step 1-2 above already accomplish.

### Stage 2 — MapLibre style-spec adapter

**Shape of the module:**

```ts
interface MapLibreStyleEvaluator {
  createPropertyExpression: typeof import('@maplibre/maplibre-gl-style-spec').createPropertyExpression;
  featureFilter: typeof import('@maplibre/maplibre-gl-style-spec').featureFilter;
}

interface MapLibreStyleLayerProps {
  style: StyleSpecification;        // the MapLibre style JSON (or the relevant `layers`+`sources` subset)
  data: string;                      // {z}/{x}/{y} tile URL template for the vector source (mirrors MVTLayer's `data`)
  tileMatrixSet?: TileMatrixSet;     // CRS-native tiling (Stage 1, item 1); omit for the classic
                                     // Mercator XYZ case (Stage 1, item 1b — MercatorCRSTileset2D
                                     // auto-route, the more common real-world source shape)
  evaluator: MapLibreStyleEvaluator; // injected — see Decisions for review #2
  spriteAtlas?: {image: string; mapping: string}; // resolved sprite PNG + JSON, app-fetched
}
```

`_MapLibreStyleLayer` is a `CompositeLayer` that, per style-layer entry in `style.layers`
(in order, for z-ordering):

1. Resolves `filter` once via `evaluator.featureFilter(layer.filter)` →
   `.filter({zoom}, feature)` called per-feature inside the relevant sublayer's accessor (or,
   for cheap pre-filtering, once per tile against the tile's already-parsed feature array before
   building sublayer data — an optimization left to implementation, not a correctness
   requirement).
2. Compiles each relevant paint/layout property via
   `evaluator.createPropertyExpression(value, propertySpec)` once per style-layer (not per
   feature/frame); the resulting `.evaluate(globals, feature)` closure becomes the deck.gl
   accessor body (`getFillColor: (f) => toDeckColor(compiled.fillColor.evaluate({zoom}, f))`,
   etc.) — mirroring `ol-mapbox-style`'s compile-once/evaluate-per-feature architecture
   (Decisions for review #2).
3. Maps to one deck.gl layer per style-layer `type`:

| MapLibre style-layer `type` | deck.gl layer | Notes |
|---|---|---|
| `background` | `SolidPolygonLayer` over the current viewport bounds, or a full-screen quad | no source data; `background-color`/`background-opacity` only |
| `fill` | `GeoJsonLayer` (polygon sublayer) / `SolidPolygonLayer` | `fill-color`, `fill-opacity`, `fill-outline-color` → `getFillColor`, `getLineColor`, `stroked: true` |
| `line` | `PathLayer` (via `GeoJsonLayer`'s line sublayer) + `PathStyleExtension` | `line-dasharray` → `getDashArray` (`modules/extensions/src/path-style/path-style-extension.ts:34-56,39`); `line-width`, `line-color` → `getWidth`/`getLineColor` |
| `fill-extrusion` | `SolidPolygonLayer` `extruded: true` | `fill-extrusion-height`/`-base` → `getElevation`/`getElevation` offset (base handled by pre-subtracting or a two-layer stack if the style separates base/height per-feature) |
| `symbol` (icon) | `IconLayer` | `icon-image` → `iconMapping` key lookup; sprite sheet → `iconAtlas`/`iconMapping` (`modules/layers/src/icon-layer/icon-layer.ts:33-35`, `IconMapping` shape `{x,y,width,height,anchorX?,anchorY?,mask?}` — a MapLibre sprite JSON's `{x,y,width,height,pixelRatio,sdf}` needs only `pixelRatio` dropped and `sdf → mask` renamed, no restructuring) |
| `symbol` (text) | `TextLayer` + `CollisionFilterExtension` | `text-field` → `getText`; `text-font` → one resolved `fontFamily` (browser-font approximation, Decisions for review — not enumerated as its own decision since it is a known, accepted v1 cut, not a contested tradeoff); `symbol-sort-key`/paint priority → `getCollisionPriority` (`collision-filter-extension.ts:16-37,20`); `symbol-placement: 'point'` → one label per feature; `symbol-placement: 'line'` → midpoint approximation (Decisions for review #4) |
| `raster`, `raster-particle`, `hillshade`, `heatmap` | *(skipped)* | out of scope; `console.warn` once per style-layer `id` |

Feature access mirrors `GeoJsonLayer`'s existing accessor convention exactly:
`Accessor<Feature<Geometry, Properties>, T>`, i.e. accessors receive `{properties, geometry}`
(`modules/layers/src/geojson-layer/geojson-layer.ts:86` region;
`modules/layers/src/geojson-layer/geojson-binary.ts:31-56`'s `binaryToFeatureForAccesor`
reconstructs the same shape even from binary-mode tiles) — the adapter's compiled
`.evaluate(globals, feature)` closures are called with exactly this object, so
`feature.properties['some-tag']`-style style-spec expressions (`["get", "some-tag"]`) work
unmodified.

**Zoom re-evaluation wiring** (Decisions for review #3): for each generated sublayer, build an
`updateTriggers` entry per zoom-dependent accessor keyed on `Math.floor(viewport.zoom)`, sourced
from `this.context.viewport.zoom` inside `updateState`/`renderLayers` (the same place
`TerrainLayer`'s `updateTriggers.getTileData.projectionMode` pattern already reads
`this.context.viewport.projectionMode`, `terrain-layer.ts` — precedent for reading `viewport.*`
into an `updateTriggers` value on this branch). Accessors compiled from `'constant'`/`'source'`
expressions get no zoom entry (never re-evaluated on pan/zoom, only on data change).

## Quality / performance envelope

- **Stage 1** adds no new per-vertex cost beyond what Globe-mode MVT already pays today
  (`wgs84` decode allocation, Decisions for review #5); `_CRSTileset2D`'s tile-metadata cost is
  already paid once per tile load regardless of layer (Phase 2/4 precedent).
- **Stage 2**: expression compilation is O(style layers), once per style (not per tile, not per
  feature); per-feature cost is O(1) evaluator calls per compiled accessor per zoom-bucket
  change — bounded by `Math.floor(zoom)` transitions (Decisions for review #3), not by
  frame rate or continuous camera motion.
- **Stage 2** adds zero GPU/shader changes — all mapped layers (`SolidPolygonLayer`, `PathLayer`,
  `IconLayer`, `TextLayer`) are existing, unmodified deck.gl core/layers/extensions.
- Both stages: zero new runtime dependency in any published package (Stage 1: none needed at
  all; Stage 2: injected, Decisions for review #2).

## Testing strategy

- **Stage 1**: `.node.spec.ts` for the new shared predicate (`usesFeatureRoute`) covering
  Mercator/Globe/CRS/non-geospatial inputs; a `.spec.ts` (headless layer lifecycle, mirroring
  `test/modules/geo-layers/mvt-layer.spec.ts`'s existing structure) asserting a `MVTLayer` with
  `tileMatrixSet` + a UTM `_CRSViewport` selects `_CRSTileset2D`, forces `binary: false`, omits
  `ClipExtension`, and produces `GeoJsonLayer` sublayer features at lnglat coordinates matching
  an independently computed expectation; full regression run of the existing Mercator- and
  Globe-mode MVTLayer spec/render-test suites (byte-identical, no assertion changes). **Added
  after review (Finding 2):** the universal, no-`tileMatrixSet` case — a `.spec.ts` proving
  `MVTLayer._getTilesetClass()` selects `MercatorCRSTileset2D` (not `_CRSTileset2D`, not the
  default `Tileset2D`) for a Mercator-pyramid MVT source in a UTM `_CRSViewport`, with a
  known-answer selected tile level (`selectMercatorSourceZoom`, mirroring
  `mercator-crs-tileset-2d.node.spec.ts`'s own known-answer technique) and known-answer tile
  bbox (closed-form `osmTile2lngLat` corner math); a feature-decode test confirming a tile-local
  point lands at the exact lnglat position `transform()` (the existing wgs84-decode helper)
  produces from that real, `MercatorCRSTileset2D`-computed bbox — not a fabricated one; a
  regression pin that a plain Mercator (non-CRS) view still selects the default `Tileset2D`
  (byte-identical, binary fast path unaffected).
- **Stage 2**: `.node.spec.ts` per style-layer-type mapping (filter compiled+evaluated correctly,
  paint expression compiled+evaluated correctly at 2+ zoom buckets, sprite-mapping key-shape
  transform correct, dasharray/collision-priority wiring correct) using a small
  `MapLibreStyleEvaluator` fixture built directly from `@maplibre/maplibre-gl-style-spec`
  (the real package, as a devDependency — not a hand-rolled fake, so the tests exercise the
  real expression grammar); a headless layer-lifecycle spec for the composite mapping
  (style-layer order → deck.gl layer order); a manual/visual verification recipe in
  `test/apps/crs-viewport` reproducing the Fathom hybrid acceptance scenario.

## Decomposition (this spec → one plan)

Two stages, each independently shippable — the plan is organized so a reviewer/implementer can
stop after Stage 1's tasks and have shipped E1 as originally scoped. Plan:
`docs/superpowers/plans/2026-07-05-crs-mvt-style-adapter-plan.md`.

Filed as roadmap follow-ups, not part of this plan: binary-mode CRS support (Decisions for
review #5), `symbol-placement: 'line'` true curved labels / `line-gradient` / `fill-pattern` /
`raster`/`hillshade`/`heatmap` style layers / glyph-PBF font parity (Stage 2 Non-goals),
continuous zoom re-evaluation (Decisions for review #3), far-field LOD (Chunk B1, unaffected).

## Performance addendum (2026-07-06): zoom-bucket-crossing regen storm — root cause, fix, numbers

The "Quality / performance envelope" section above characterized per-feature style-evaluation
cost as "bounded by `Math.floor(zoom)` transitions, not by frame rate" — true in the sense that
it doesn't re-run continuously during camera motion, but incomplete: it did not account for what
happens *at* one of those bounded transitions. This addendum documents a real-integration finding
(reported as a stutter zooming a vector basemap in a CRS view) and its fix.

### Root cause

`_MapLibreStyleLayer` keys the inner `MVTLayer`'s `updateTriggers.renderSubLayers` on
`[zoomBucket(zoom), style]` (`maplibre-style-layer.ts`, "Review fix (C1)"/"Review fix (Round 8
finding 2)") so that TileLayer regenerates per-tile sublayers when a zoom-interpolated paint
expression needs re-evaluating. But `TileLayer.updateState` (`tile-layer.ts:240-286`) treats any
`updateTriggers` change as "regenerate sublayers" for **every cached tile** — it does not (and,
short of finer-grained triggers, cannot) know that most style layers in a typical style have no
`["zoom"]`-dependent paint/layout expression at all. The result: crossing a single integer zoom
boundary re-ran `mapOneStyleLayer` (full filter pass + compiled-expression lookups + a fresh
`GeoJsonLayer`/`IconLayer`/`TextLayer` construction) for **every style layer × every visible
tile**, synchronously, in one frame — regardless of whether that style layer's output could have
possibly changed.

Measured (Node microbenchmark, `test/perf/crs-bench.ts` section 4; see also the pinning test
`test/modules/geo-layers/maplibre-style-layer/zoom-bucket-regen-skip.node.spec.ts`), before this
fix, driving the real `renderSubLayers` closure across one zoom-bucket crossing:

| Scale (tiles × style layers (static/zoom-dependent) × features/tile) | Regen time (median) |
|---|---|
| 24 × 12 (9/3) × 200 | ~5 ms |
| 48 × 24 (18/6) × 500 | ~37 ms |
| 48 × 24 (22/2) × 500 — a realistic mostly-static style | ~37–38 ms |

At 48 visible tiles (a plausible count for a detailed vector basemap at typical zoom) with a
24-layer style, a single zoom-bucket crossing cost **more than twice a 16 ms (60 fps) frame
budget** — synchronously, on the main thread — which is exactly the reported hitch. This does not
even include the GPU buffer re-upload cost of the freshly-constructed `GeoJsonLayer` instances
that would follow in a real (browser, WebGL) run.

### Fix

Per (tile id, style layer id), memoize the previously-mapped sublayer (`maplibre-style-layer.ts`'s
new `SubLayerCacheEntry`/`subLayerCache`, invalidated together with the existing `compileCache` on
style/evaluator identity change — same contract as "Review fix (I6)"). On each
`renderSubLayers` call, a style layer's cached sublayer is reused **unchanged** (no
`mapOneStyleLayer` call at all) when:

1. the tile's data reference hasn't changed (a real new tile load always forces a rebuild), AND
2. its visibility/`minzoom`/`maxzoom` in-range status hasn't flipped (checked freshly every call —
   O(1), no feature loop), AND
3. none of its compiled paint/layout expressions is zoom-dependent (derived from the built
   layer's own `updateTriggers` — every mapper already reports this per accessor via
   `zoomDependentBucket`/inline checks, so no new compiled-expression bookkeeping was needed).

A style layer that fails any of those checks (has a `["zoom"]`-dependent expression, or just
crossed its `minzoom`/`maxzoom` boundary, or the tile's content genuinely changed) still rebuilds
exactly as before — this is a targeted skip, not a change to *what* gets rendered. Two pinning
tests (`zoom-bucket-regen-skip.node.spec.ts`) confirm both halves: a static layer's mapped
`GeoJsonLayer.props.data` array is the same reference across a bucket crossing (no rebuild), and a
zoom-dependent layer's is not (still rebuilds); a third existing/adjacent scenario (a `minzoom`-
gated, non-zoom-dependent layer) is confirmed to still regenerate exactly when its range flips.
Bounded memory growth: the per-tile cache entry is evicted via the inner `MVTLayer`'s
`onTileUnload` when a tile actually drops out of the tile cache.

### Before / after

| Scale | BEFORE (median ms/crossing) | AFTER (median ms/crossing) | Speedup |
|---|---|---|---|
| 24 × 12 (9/3) × 200 | ~5 | ~1.1 | ~4.5× |
| 48 × 24 (18/6) × 500 | ~37 | ~10 | ~3.7× |
| 48 × 24 (22/2) × 500 (mostly-static style) | ~37–38 | ~3.8–4 | ~9.5× |

The speedup scales with the fraction of style layers that are actually zoom-dependent — most real
basemap styles (e.g. positron/bright-style vector basemaps) are dominated by static fill/line
colors with only a handful of zoom-interpolated widths/label sizes, so the mostly-static (22/2)
row is the more representative real-world number: **roughly an order of magnitude faster**, taking
the regen well back under a 16 ms frame budget at this tile/feature scale.

### Other measured costs (context for the numbers above)

Run `npx tsx test/perf/crs-bench.ts` for current numbers; representative results from one run:

| Measurement | Result |
|---|---|
| `buildWarpedTileMesh` (warped-raster CRS path), N=4 mesh | ~0.01–0.02 ms/tile |
| `buildWarpedTileMesh`, N=32 mesh | ~0.35 ms/tile |
| MVT decode, `local`/geojson (baseline, no reprojection) | ~1.6–5 ms/tile (1664 features) |
| MVT decode, `wgs84`/geojson (CRS feature route — adds per-vertex reprojection) | ~2–3 ms/tile |
| MVT decode, `local`/binary (classic Mercator — what `MVTLayer` actually uses) | ~7.7–8.2 ms/tile |
| Style expression compile (first-time parse/AST build) | ~0.01–0.02 ms/expression |
| Style expression `evaluate()` throughput | ~10M features/sec (~0.1 µs/feature) |

Two notes on reading these: (a) the `binary` shape costs *more* to decode than `geojson`, not
less, in this microbenchmark — it eagerly builds typed-array/spatial-index structures that
`geojson` shape defers, so its benefit is downstream (GPU upload, incremental picking), not raw
parse time; (b) per-feature `evaluate()` throughput is high enough (~10M/sec) that it is not
itself the bottleneck at any realistic tile/feature scale — the bucket-crossing storm above was
dominated by the *filter* pass and repeated object construction across every style layer, not by
per-feature expression evaluation cost.

### Post-review fixes to the bucket-crossing-skip cache

Two review-confirmed bugs in the cache above, both fixed with a RED-test-first reproduction:

1. **Filter-only zoom dependence misclassified as static.** `isZoomDependent` was derived only
   from the built layer's paint/layout `updateTriggers` — a style layer whose only `["zoom"]`
   dependence lives in its `filter` (e.g. `filter: ["<=", ["zoom"], 10]`) with otherwise-static
   paint produced no updateTrigger, so it was classified static and its stale matched-feature set
   was reused across a bucket crossing (a real stale-render regression, confirmed with a test
   where a feature kept rendering past the filter's zoom cutoff). Fixed by also scanning the
   style layer's `filter` for the `["zoom"]` operator (`filterReferencesZoom`, a cheap recursive
   token scan — cheaper than threading an `isZoomDependent` flag through `compileFilter`) and
   OR-ing that into `isZoomDependent`. A filter with no zoom reference is unaffected and keeps the
   skip optimization.
2. **`onTileUnload` eviction key mismatch.** The cache is populated keyed on `tileProps.id` (the
   `TileLayer`-namespaced id, e.g. `"myLayer-source-0,0,0"`), but `onTileUnload` deleted by the
   raw `Tile2DHeader.id` alone (e.g. `"0,0,0"`) — the keys never matched, so eviction was a silent
   no-op and `subLayerCache` grew unbounded for the life of the layer. Fixed by reconstructing the
   same namespaced key inside `onTileUnload` from the `MVTLayer`'s own sub-layer-props id
   (computed once, shared with the `MVTLayer` constructor call) plus the raw tile id.

Both fixes are covered by dedicated RED-then-GREEN tests
(`test/modules/geo-layers/maplibre-style-layer/filter-zoom-dependence.node.spec.ts`,
`test/modules/geo-layers/maplibre-style-layer/sublayer-cache-eviction.node.spec.ts`), and the
benchmark above was re-run after the fixes — the mostly-static (22/2) row still shows the full
~9.5–9.7× speedup, confirming the perf win survives; only style layers whose filter (or
paint/layout) actually references `["zoom"]` now correctly stop skipping regen.
