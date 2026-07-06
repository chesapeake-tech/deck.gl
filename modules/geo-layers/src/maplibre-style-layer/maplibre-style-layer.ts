// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {CompositeLayer, Layer, LayersList, log} from '@deck.gl/core';
import {binaryToGeojson} from '@loaders.gl/gis';
import type {Feature} from 'geojson';

import type {UpdateParameters} from '@deck.gl/core';

import MVTLayer from '../mvt-layer/mvt-layer';
import {
  mapBackgroundLayer,
  mapFillLayer,
  mapLineLayer,
  mapFillExtrusionLayer,
  isStyleLayerVisible,
  isStyleLayerInZoomRange
} from './style-layer-mappers';
import type {StyleLayer} from './style-layer-mappers';
import {mapSymbolIconLayer, mapSymbolTextLayer} from './symbol-mappers';
import {zoomBucket} from './compile-expression';
import type {CompileCache} from './compile-expression';
import type {MapLibreStyleLayerProps} from './types';
import {mercatorEquivalentZoom} from './style-eval-zoom';
import {backgroundCoveringFeature} from './background-coverage';

const SUPPORTED_TYPES = new Set(['fill', 'line', 'fill-extrusion', 'symbol']);

/** Review fix (M2): these warn-once ledgers were previously module-scope `Set`s, shared by
 * EVERY `MapLibreStyleLayer` instance for the lifetime of the JS module (i.e. the whole page) —
 * a style layer id warned once by one map/layer instance would never warn again even for a
 * brand-new, unrelated instance (e.g. a different map in the same app, or the same map
 * recreated after a style swap reusing an id). Moved to per-instance layer `state` instead. */
function warnUnsupportedOnce(styleLayer: StyleLayer, warned: Set<string>): void {
  if (warned.has(styleLayer.id)) return;
  warned.add(styleLayer.id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${styleLayer.id}" has unsupported type "${styleLayer.type}" ` +
      '(raster/hillshade/heatmap are not implemented in v1) — skipped.'
  )();
}

function warnLinePlacementOnce(id: string, warned: Set<string>): void {
  if (warned.has(id)) return;
  warned.add(id);
  log.warn(
    `_MapLibreStyleLayer: style layer "${id}" uses symbol-placement:'line' — approximated as a ` +
      'single horizontal label at the line midpoint (no curved along-line placement in v1).'
  )();
}

/** In a classic Mercator `MapView` (`usesFeatureRoute` false, `mvt-layer.ts`), `MVTLayer`'s own
 * `renderSubLayers` sets `modelMatrix`/`coordinateOrigin`/`coordinateSystem`/`extensions`
 * (the power-of-two tile transform + `ClipExtension`) onto the props object handed to
 * `this.props.renderSubLayers` (i.e. this module's tile-render callback) *before* calling it —
 * see `mvt-layer.ts`'s `renderSubLayers`, `super.renderSubLayers(props)` region. Style-layer
 * mapper functions (Tasks 10/11) build fresh layers with their own (lnglat) coordinate
 * defaults and know nothing about that transform, so it must be re-applied here to every mapped
 * sublayer for the Mercator case — otherwise Mercator-mode content renders at the wrong
 * position/scale (only the CRS/Globe feature-route case, where content already arrives as
 * plain lnglat, needs no adjustment). Deviation from the plan's Task 12 sketch, which did not
 * carry these tile-positioning props through to the mapped layers; caught before commit by
 * reasoning through `MVTLayer.renderSubLayers`'s actual prop-mutation behavior, and pinned by
 * this file's `maplibre-style-layer.spec.ts` Mercator-positioning test. */
export interface TileRenderProps {
  id: string;
  data: unknown;
  tile: unknown;
  modelMatrix?: unknown;
  coordinateOrigin?: unknown;
  coordinateSystem?: unknown;
  extensions?: unknown[];
  [key: string]: unknown;
}

export function applyTilePositioning(layer: Layer, tileProps: TileRenderProps): Layer {
  if (tileProps.modelMatrix === undefined) {
    return layer;
  }
  return layer.clone({
    modelMatrix: tileProps.modelMatrix,
    coordinateOrigin: tileProps.coordinateOrigin,
    coordinateSystem: tileProps.coordinateSystem,
    extensions: [...((layer.props.extensions as unknown[]) ?? []), ...(tileProps.extensions ?? [])]
  } as never) as Layer;
}

function mapOneStyleLayer(
  styleLayer: StyleLayer,
  features: Feature[],
  evaluator: MapLibreStyleLayerProps['evaluator'],
  zoom: number,
  spriteAtlas: MapLibreStyleLayerProps['spriteAtlas'],
  warnLinePlacementOnce: (id: string) => void,
  cache: CompileCache
): Layer | null {
  switch (styleLayer.type) {
    case 'fill':
      return mapFillLayer(styleLayer, features, evaluator, zoom, cache);
    case 'line':
      return mapLineLayer(styleLayer, features, evaluator, zoom, cache);
    case 'fill-extrusion':
      return mapFillExtrusionLayer(styleLayer, features, evaluator, zoom, cache);
    case 'symbol':
      if (
        (styleLayer as {layout?: {'icon-image'?: unknown}}).layout?.['icon-image'] &&
        spriteAtlas
      ) {
        return mapSymbolIconLayer(styleLayer, features, evaluator, zoom, spriteAtlas, cache);
      }
      return mapSymbolTextLayer(
        styleLayer,
        features,
        evaluator,
        zoom,
        warnLinePlacementOnce,
        cache
      );
    default:
      return null;
  }
}

/** Perf fix (bucket-crossing regen storm): per (tile id, style layer id) memoization entry for
 * the `renderSubLayers` closure below. `mapped` is the RAW `mapOneStyleLayer` output (before
 * `applyTilePositioning`/the per-tile id-namespacing `.clone()`, both cheap/idempotent and still
 * re-applied on every call regardless of whether `mapped` itself was rebuilt). See the
 * `updateTriggers.renderSubLayers` doc comment below for why this cache exists at all. */
interface SubLayerCacheEntry {
  /** The `tileProps.data` reference this entry was built from — a changed reference means the
   * tile's actual content changed (a new tile load / `tileset.reloadAll()`), not just a
   * zoom-bucket-crossing regen, and always forces a rebuild regardless of zoom-dependence. */
  data: unknown;
  mapped: Layer | null;
  /** Whether this style layer's own compiled paint/layout expressions reference `["zoom"]` —
   * i.e. whether skipping a rebuild across a zoom-bucket crossing could ever be wrong for this
   * layer. Derived from the built layer's own `updateTriggers` (every mapper function already
   * sets `zoomBucket(zoom)` vs. `undefined` per accessor via `zoomDependentBucket`/inline —
   * see style-layer-mappers.ts/symbol-mappers.ts). Conservatively `true` (never skip) when
   * `mapped` is `null` (this build produced zero matching features) — a style layer can go from
   * zero matches to some matches purely because its `filter` itself references `["zoom"]` (not
   * tracked by `updateTriggers`, and rare enough not to warrant its own compiled-expression
   * plumbing here), so there is nothing safe to compare against on the next crossing. */
  isZoomDependent: boolean;
  /** `isStyleLayerVisible(styleLayer) && isStyleLayerInZoomRange(styleLayer, zoom)` at build
   * time — rechecked (cheaply, O(1)) on every call so a minzoom/maxzoom range crossing always
   * forces a rebuild even for an otherwise fully static (non-zoom-dependent-paint) style layer. */
  inZoomRange: boolean;
}

/** True if any of `layer`'s own `updateTriggers` entries is a real (non-`undefined`) value —
 * every style-layer mapper (style-layer-mappers.ts, symbol-mappers.ts) sets exactly one of
 * `zoomBucket(zoom)`/`undefined` per accessor depending on whether that accessor's compiled
 * expression is zoom-dependent (`CompiledExpression.isZoomDependent`, compile-expression.ts) —
 * so "some updateTriggers entry is defined" is equivalent to "this style layer has at least one
 * zoom-dependent paint/layout expression" without needing to re-derive that from the compile
 * cache directly. */
function layerHasZoomDependentAccessor(layer: Layer): boolean {
  const triggers = layer.props.updateTriggers as Record<string, unknown> | undefined;
  if (!triggers) return false;
  for (const key in triggers) {
    if (triggers[key] !== undefined) return true;
  }
  return false;
}

function toFeatureArray(tileData: unknown): Feature[] {
  if (Array.isArray(tileData)) return tileData as Feature[];
  // Defensive-only in practice: the inner MVTLayer is always constructed with `binary: false`
  // above, so `tileData` is always already a `Feature[]` (the `Array.isArray` branch). Kept in
  // case a future caller/override changes that. `binaryToGeojson` returns `Feature | Feature[]`
  // directly (not a `{features: [...]}` wrapper, corrected after checking the real
  // @loaders.gl/gis type signature rather than assuming a shape).
  if (tileData) {
    const converted = binaryToGeojson(tileData as never);
    return Array.isArray(converted) ? converted : [converted];
  }
  return [];
}

/** Experimental: converts a MapLibre GL style JSON plus a vector tile source into styled
 * deck.gl layers — one deck.gl layer per style layer, per tile, in style order. Works in both
 * classic Mercator `MapView`s and CRS `MapView`s (Stage 1); `source.tileMatrixSet` follows the
 * same convention as `MVTLayer`/`TileLayer` (optional — unset is the common, Mercator-pyramid
 * case, auto-routed through `_MercatorCRSTileset2D` in a CRS view, not a fallback). See
 * docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md, Stage 2. */
export class MapLibreStyleLayer extends CompositeLayer<MapLibreStyleLayerProps> {
  static layerName = 'MapLibreStyleLayer';

  /** Review fix (C1): `CompositeLayer`'s `activateViewport` (`modules/core/src/lib/layer.ts:628`
   * region) only calls `setNeedsUpdate()` — the thing that actually causes `renderLayers()` to
   * run again next frame — when `needsUpdate()`/`shouldUpdateState()` returns true. `Layer`'s
   * default `shouldUpdateState` is `changeFlags.propsOrDataChanged` only
   * (`modules/core/src/lib/layer.ts:481-483`), which is false for a pure viewport (pan/zoom)
   * change with no prop/data/updateTrigger change. Without this override, zoom-only camera
   * motion never re-ran `renderLayers()` at all, so the per-tile `renderSubLayers` callback
   * (a function prop, invisible to deck.gl's prop diffing) never re-ran and zoom-interpolated
   * paint expressions were evaluated exactly once, at whatever zoom the layer first mounted at.
   * Mirrors `TileLayer.shouldUpdateState` (`tile-layer.ts`), which already reacts to
   * `changeFlags.somethingChanged` (props-or-data OR viewport OR state) for the same reason. */
  shouldUpdateState({changeFlags}: UpdateParameters<this>): boolean {
    return changeFlags.somethingChanged;
  }

  /** Review fix (I6): (re)creates the compile cache and warn-once ledgers whenever `style` or
   * `evaluator` change identity (including first mount) — a stale cache keyed against a
   * since-replaced evaluator/style would be a correctness bug (compiled closures capturing the
   * old evaluator), not just a missed optimization, so identity, not deep-equality, is the
   * right invalidation key: a caller that wants a fresh compile must pass a new object, exactly
   * mirroring how `updateTriggers` identity already works elsewhere in this adapter. */
  initializeState(): void {
    this._ensureState();
  }

  /** Defensive alongside the real `initializeState()` lifecycle hook: guarantees `this.state`
   * (and its warn-once ledgers) exist even if called outside the full layer-manager lifecycle
   * (e.g. a unit test driving `renderLayers()` directly) — cheap, idempotent, and avoids a
   * crash-on-`undefined` far less informative than "the state got lazily created". */
  private _ensureState(): void {
    if (!this.state) {
      (this as unknown as {state: Record<string, unknown>}).state = {};
    }
    if (!this.state.compileCache) this.state.compileCache = new Map();
    if (!this.state.warnedUnsupportedIds) this.state.warnedUnsupportedIds = new Set<string>();
    if (!this.state.warnedLinePlacementIds) this.state.warnedLinePlacementIds = new Set<string>();
    // Perf fix (bucket-crossing regen storm): per-(tile id, style layer id) memoized sublayer
    // cache — see `SubLayerCacheEntry`'s doc comment and the `renderSubLayers` closure below.
    if (!this.state.subLayerCache) this.state.subLayerCache = new Map();
  }

  private _getCompileCache(): CompileCache {
    this._ensureState();
    const {style, evaluator} = this.props;
    if (this.state.cacheStyle !== style || this.state.cacheEvaluator !== evaluator) {
      this.state.compileCache = new Map();
      // A stale memoized sublayer built against the since-replaced style/evaluator is exactly
      // as wrong as a stale compiled expression would be (Review fix I6's reasoning applies
      // identically here) — invalidate together, on the same identity check.
      this.state.subLayerCache = new Map();
      this.state.cacheStyle = style;
      this.state.cacheEvaluator = evaluator;
    }
    return this.state.compileCache as CompileCache;
  }

  private _getSubLayerCache(): Map<string, Map<string, SubLayerCacheEntry>> {
    // `_getCompileCache` performs the identity check (and resets both caches together); call it
    // first so `subLayerCache` reflects the current style+evaluator identity.
    this._getCompileCache();
    return this.state.subLayerCache as Map<string, Map<string, SubLayerCacheEntry>>;
  }

  renderLayers(): LayersList {
    const {style, source, evaluator, spriteAtlas} = this.props;
    // Review fix (C2): fail fast, once, with a clear message if the injected evaluator
    // (Decisions for review #2 — a structural contract, not a typechecked import) is missing or
    // malformed, rather than letting the first per-feature `compileExpression`/`compileFilter`
    // call inside the tile callback throw a less obvious error mid-render.
    if (
      typeof evaluator?.createPropertyExpression !== 'function' ||
      typeof evaluator?.featureFilter !== 'function'
    ) {
      throw new Error(
        '_MapLibreStyleLayer: `evaluator` must provide both `createPropertyExpression` and ' +
          '`featureFilter` as functions — pass the real exports from ' +
          '`@maplibre/maplibre-gl-style-spec` (see the module doc for the injection contract).'
      );
    }
    // Review fix (Round 8 finding 1): style evaluation (minzoom/maxzoom gating, zoom
    // expressions, and the zoom-bucket updateTrigger below) must use the Mercator-equivalent
    // zoom, not the raw viewport zoom -- see `style-eval-zoom.ts`'s doc comment. Identity for a
    // classic Mercator MapView; only the CRS-view case actually shifts the number.
    const zoom = mercatorEquivalentZoom(this.context.viewport);
    const layers: LayersList = [];
    // Review fix (I6): compiled once per style+evaluator identity (see `_getCompileCache`), not
    // once per tile render — passed into every mapper call below and into the per-tile
    // `renderSubLayers` callback's closure, so a style layer's filter/paint expressions are
    // parsed a single time no matter how many tiles or zoom-bucket re-renders follow.
    const compileCache = this._getCompileCache();
    // Perf fix (bucket-crossing regen storm): shared across every tile's `renderSubLayers` call
    // below (and across every zoom-bucket-crossing re-render), same identity-based invalidation
    // as `compileCache` (see `_getSubLayerCache`).
    const subLayerCache = this._getSubLayerCache();
    this._ensureState();
    const warnedUnsupportedIds = this.state.warnedUnsupportedIds as Set<string>;
    const warnedLinePlacementIds = this.state.warnedLinePlacementIds as Set<string>;

    const allStyleLayers = style.layers as StyleLayer[];
    const backgroundStyleLayer = allStyleLayers.find(l => l.type === 'background');
    if (backgroundStyleLayer) {
      // Review fix (Round 8 finding 3): a hardcoded ±180°/±90° LNGLAT world rectangle is not
      // CRS-safe -- a UTM (or other small-extent) transform folds it into a degenerate shape
      // that never covers the viewport. Cover the CRS's own valid extent instead (identity for
      // a classic Mercator/non-CRS viewport, which still gets the whole-world rectangle — see
      // `background-coverage.ts`).
      const backgroundLayer = mapBackgroundLayer(
        backgroundStyleLayer,
        evaluator,
        zoom,
        backgroundCoveringFeature(this.context.viewport),
        compileCache
      );
      if (backgroundLayer) {
        // Review fix (M1): route the background sublayer through `this.getSubLayerProps` —
        // namespaces its id under this composite instance's own id (avoiding a collision with
        // another `MapLibreStyleLayer` instance rendering the same style/background id) and
        // cascades `opacity`/`visible` (and other composite-level sublayer props) from the
        // composite's own props onto it, matching how every other `CompositeLayer` in this
        // codebase threads sublayer props through — the previous code built it as a fully
        // independent, un-namespaced `GeoJsonLayer`.
        layers.push(
          backgroundLayer.clone(
            this.getSubLayerProps({
              id: backgroundStyleLayer.id,
              updateTriggers: backgroundLayer.props.updateTriggers
            })
          )
        );
      }
    }

    const featureStyleLayers = allStyleLayers.filter(l => l.type !== 'background');

    // Review fix (M4): `source` is a caller-supplied, indexed-signature bag of MVTLayer/
    // TileLayer props (Decisions for review — lets a caller pass through e.g. `fetch`); if it
    // happened to include its own `id` (or `updateTriggers`, merged explicitly below instead),
    // spreading it AFTER `this.getSubLayerProps({id: 'source'})` would silently clobber the
    // properly-namespaced inner MVTLayer id with whatever the caller passed — a real risk since
    // `source`'s shape is intentionally open-ended. Strip both out of the spread explicitly so
    // the composite's own namespacing always wins.
    const {
      id: _sourceId,
      updateTriggers: sourceUpdateTriggers,
      onTileUnload: sourceOnTileUnload,
      ...restSource
    } = source as {
      id?: string;
      updateTriggers?: Record<string, unknown>;
      onTileUnload?: (tile: {id: string}) => void;
      [key: string]: unknown;
    };

    layers.push(
      new MVTLayer(this.getSubLayerProps({id: 'source'}), {
        // Spread (not pick data/tileMatrixSet only) so any other MVTLayer/TileLayer prop the
        // caller sets on `source` (e.g. `fetch`, for a custom/offline loader — see the app
        // verification demo, Task 13) passes through verbatim.
        ...restSource,
        // Style-layer mappers (Tasks 10/11) consume plain GeoJSON Feature[] (`f.properties`,
        // `f.geometry`) and fan each tile out into a *list* of mapped layers, one per matching
        // style layer — not the single-GeoJsonLayer-per-tile shape MVTLayer's `binary: true`
        // fast path expects (its own renderSubLayers logs a warning otherwise: "must return
        // GeoJsonLayer when using binary:true"). Force `binary: false` so tile content always
        // arrives pre-parsed as Feature[] (`toFeatureArray`'s binary-fallback branch below is
        // then purely defensive, not the common path) and the warning does not fire on every
        // render in classic Mercator MapViews. Deviation: the plan's Task 12 sketch did not set
        // this and would warn continuously in the Mercator regression case (Task 13).
        binary: false,
        // Review fix (C1): `renderSubLayers` is a function prop — deck.gl's shallow prop diff
        // never considers it "changed" (a fresh closure is created every render, but that's not
        // a value-comparable difference `diffUpdateTrigger` can key on), so `TileLayer`'s own
        // updateState (`tile-layer.ts:242`) never regenerated per-tile sublayers on a zoom
        // bucket change through this prop alone. `updateTriggers` entries, by contrast, ARE
        // value-compared per key (`diffUpdateTrigger`, `modules/core/src/lifecycle/props.ts:251`)
        // — any key name works, not just ones matching a real accessor prop. Keying a
        // `renderSubLayers` entry on the current integer zoom bucket makes
        // `changeFlags.updateTriggersChanged` truthy (but not `.all`/`.getTileData`) whenever the
        // zoom bucket changes, which routes `TileLayer.updateState` into its "regenerate
        // sublayers without refetching" branch (`tile.layers = null` per tile, `tile-layer.ts:
        // 266-268`) instead of a full `tileset.reloadAll()` — exactly the "value-compared path"
        // the review asked for.
        //
        // Review fix (Round 8 finding 2): keying solely on the zoom bucket left already-
        // materialized tile sublayers stale across a *style* swap that didn't also cross an
        // integer zoom boundary (e.g. two styles sharing a source id) — a changed `style` prop
        // never regenerated them. `diffUpdateTrigger`'s `compareProps` falls back to reference
        // (`!==`) equality for values with no registered `propType` (`props.ts`'s
        // `comparePropValues`), so pairing the zoom bucket with the `style` object reference in
        // an array — rather than the bucket alone — makes a new `style` identity (this
        // composite's own cache-invalidation key, see `_getCompileCache`) also flip
        // `updateTriggersChanged`, regenerating sublayers on a style swap exactly as it already
        // does on a zoom-bucket crossing.
        updateTriggers: {
          ...(sourceUpdateTriggers ?? {}),
          renderSubLayers: [zoomBucket(zoom), style]
        },
        // Perf fix (bucket-crossing regen storm): evicts this tile's memoized sublayer cache
        // entries once the tile itself is dropped (cache size, eviction, `maxCacheSize`/
        // `maxCacheByteSize`) — without this, `subLayerCache` would grow unbounded across a long
        // pan/zoom session (an entry per style layer for every tile ID ever visited, never
        // reclaimed).
        onTileUnload: (tile: {id: string}) => {
          subLayerCache.delete(tile.id);
          sourceOnTileUnload?.(tile);
        },
        renderSubLayers: (tileProps: TileRenderProps) => {
          const features = toFeatureArray(tileProps.data);
          const sublayers: LayersList = [];
          let tileCache = subLayerCache.get(tileProps.id);
          if (!tileCache) {
            tileCache = new Map();
            subLayerCache.set(tileProps.id, tileCache);
          }
          for (const styleLayer of featureStyleLayers) {
            if (!SUPPORTED_TYPES.has(styleLayer.type)) {
              warnUnsupportedOnce(styleLayer, warnedUnsupportedIds);
              continue;
            }
            const prevEntry = tileCache.get(styleLayer.id);
            const inZoomRangeNow =
              isStyleLayerVisible(styleLayer) && isStyleLayerInZoomRange(styleLayer, zoom);
            // Perf fix (bucket-crossing regen storm): `updateTriggers.renderSubLayers` above is
            // keyed on the zoom BUCKET (see its doc comment) — any integer-zoom crossing nulls
            // out every cached tile's sublayers (`tile-layer.ts`'s `tile.layers = null` branch),
            // forcing this callback to re-run for EVERY tile, even though the overwhelming
            // majority of a real style's layers have no `["zoom"]`-dependent paint/layout and no
            // minzoom/maxzoom gate anywhere near the crossing — their `mapOneStyleLayer` output
            // (filter pass + compiled-expression evaluation + a fresh GeoJsonLayer/IconLayer/
            // TextLayer instance) would be byte-for-byte identical to what was already built.
            // Reuse the previous build for exactly those layers; only style layers that are
            // actually zoom-dependent (or whose minzoom/maxzoom range just flipped) re-run the
            // full per-feature work.
            const canReuse =
              prevEntry !== undefined &&
              prevEntry.data === tileProps.data &&
              prevEntry.inZoomRange === inZoomRangeNow &&
              prevEntry.mapped !== null &&
              !prevEntry.isZoomDependent;
            let mapped: Layer | null;
            if (canReuse) {
              mapped = prevEntry.mapped;
            } else {
              mapped = mapOneStyleLayer(
                styleLayer,
                features,
                evaluator,
                zoom,
                spriteAtlas,
                id => warnLinePlacementOnce(id, warnedLinePlacementIds),
                compileCache
              );
              tileCache.set(styleLayer.id, {
                data: tileProps.data,
                mapped,
                isZoomDependent: mapped ? layerHasZoomDependentAccessor(mapped) : true,
                inZoomRange: inZoomRangeNow
              });
            }
            if (mapped) {
              const positioned = applyTilePositioning(mapped, tileProps);
              // TileLayer's default renderSubLayers relies on `props.id` (tile-unique, set by
              // TileLayer before calling this callback) flowing straight into `new
              // GeoJsonLayer(props)` for per-tile id uniqueness; unlike that default, mapper
              // functions (Tasks 10/11) hardcode a static `maplibre-${styleLayer.id}` id, which
              // collides across every sibling tile under the same MVTLayer (LayerManager then
              // throws "finalized layer cannot be reused" - caught via the app verification
              // Playwright run, Task 13, not by the node/headless unit tests since none of them
              // render more than one tile at a time). Re-namespace with the tile's own id here.
              sublayers.push(positioned.clone({id: `${tileProps.id}-${positioned.id}`}));
            }
          }
          return sublayers;
        }
      })
    );

    return layers;
  }
}

export default MapLibreStyleLayer;
