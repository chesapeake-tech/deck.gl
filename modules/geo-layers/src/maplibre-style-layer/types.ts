// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {TileMatrixSet} from '../tileset-2d/tile-matrix-set';

/** The two `@maplibre/maplibre-gl-style-spec` entry points the adapter needs. Injected by the
 * caller — mirrors `CRSDefinition.transform` (`modules/core/src/viewports/crs-utils.ts:30-54`):
 * `@deck.gl/geo-layers` never imports `@maplibre/maplibre-gl-style-spec` itself, so it stays
 * free of the runtime dependency; pass the package's own exports directly (they satisfy this
 * interface structurally with zero adaptation — see the accompanying test). */
export interface MapLibreStyleEvaluator {
  createPropertyExpression: (
    value: unknown,
    propertySpec: unknown,
    globalState?: unknown
  ) => {value?: {kind: string; evaluate: (globals: unknown, feature?: unknown) => unknown}};
  featureFilter: (
    filter: unknown,
    globalState?: unknown
  ) => {filter: (globals: unknown, feature?: unknown) => boolean};
  /** Optional: `@maplibre/maplibre-gl-style-spec`'s own `convertFunction` export. Enables the
   * adapter to normalize legacy (pre-expression, Mapbox Style Spec v7-era) `{stops: [...]}`
   * zoom/property functions into a real expression before compiling — real MapLibre style
   * validation performs this same conversion upstream of `createPropertyExpression`, which
   * otherwise rejects a bare `{stops: [...]}` object with an opaque "Bare objects invalid"
   * error (verified against the real package; see `compile-expression.ts`'s
   * `convertLegacyStopsFunction`). Real-world styles (CARTO, Esri) still author zoom-dependent
   * paint/layout this way — omit this field and legacy-function styles fail to compile; it
   * costs nothing to always pass it. */
  convertFunction?: (parameters: unknown, propertySpec: unknown) => unknown;
}

/** A single vector tile source: a `{z}/{x}/{y}` URL template plus optional CRS-native tiling.
 * Mirrors `MVTLayerProps`'s own `data`/`tileMatrixSet` shape. `tileMatrixSet` is
 * optional and unset is the common case, not a fallback:
 * `MVTLayer._getTilesetClass()` auto-routes a `tileMatrixSet`-less source through
 * `_MercatorCRSTileset2D` in a CRS `MapView`. The index signature lets a caller pass through any
 * other `MVTLayer`/`TileLayer` prop the composite forwards verbatim to its inner `MVTLayer`
 * — e.g. `fetch` for a custom/offline loader. */
export interface MapLibreVectorSource {
  data: string;
  tileMatrixSet?: TileMatrixSet;
  [key: string]: unknown;
}

/** A resolved sprite sheet: the fetched atlas image URL/data plus its parsed sprite JSON
 * mapping (app-fetched — the adapter does not fetch `style.sprite` itself, matching
 * `IconLayer.iconAtlas`/`iconMapping`'s existing "you provide the resolved asset" contract). */
export interface MapLibreSpriteAtlas {
  image: string;
  mapping: Record<
    string,
    {x: number; y: number; width: number; height: number; pixelRatio?: number; sdf?: boolean}
  >;
}

export interface MapLibreStyleLayerProps {
  style: {layers: unknown[]; [key: string]: unknown};
  source: MapLibreVectorSource;
  evaluator: MapLibreStyleEvaluator;
  spriteAtlas?: MapLibreSpriteAtlas;
}
