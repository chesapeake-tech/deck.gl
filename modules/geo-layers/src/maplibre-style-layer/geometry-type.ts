// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** Review fix (C3): `@maplibre/maplibre-gl-style-spec`'s `featureFilter`/`createPropertyExpression`
 * both implement `$type`/`["geometry-type"]` against `VectorTileFeature`'s numeric `type` code
 * (1 = Point/MultiPoint, 2 = LineString/MultiLineString, 3 = Polygon/MultiPolygon — the vector-tile
 * spec's own convention, mirrored by `@mapbox/vector-tile`/`@loaders.gl/mvt`), not a GeoJSON
 * `Feature`'s string `type: 'Feature'`/`geometry.type`. Handed a plain GeoJSON feature (this
 * adapter's feature shape throughout — Design, "Feature access mirrors GeoJsonLayer's existing
 * accessor convention"), both entry points silently evaluate `$type`/`geometry-type` against
 * `feature.type` ('Feature', matching none of the three codes) and drop every feature a legacy
 * `["==", "$type", "Polygon"]` or expression `["==", ["geometry-type"], "Polygon"]` filter/paint
 * expression was written to match — with no error, just an empty result set. */
const GEOMETRY_TYPE_CODE: Record<string, number> = {
  Point: 1,
  MultiPoint: 1,
  LineString: 2,
  MultiLineString: 2,
  Polygon: 3,
  MultiPolygon: 3
};

/** A minimal `VectorTileFeature`-shaped view: same `properties`, but `type` replaced with the
 * numeric geometry-type code `featureFilter`/`createPropertyExpression` require. Geometries with
 * no known code (e.g. `GeometryCollection`) pass through with `type: 0` — `featureFilter`'s own
 * codes start at 1, so `0` never matches any `$type`/`geometry-type` comparison, matching
 * upstream mapbox/maplibre behavior for unrecognized geometry types (no match, not a throw). */
export function withGeometryTypeCode(feature: {
  type?: unknown;
  geometry?: {type?: string};
  properties?: Record<string, unknown>;
}): {type: number; properties: Record<string, unknown>} {
  const geometryType = feature.geometry?.type;
  return {
    ...feature,
    type: (geometryType && GEOMETRY_TYPE_CODE[geometryType]) || 0,
    properties: feature.properties ?? {}
  } as {type: number; properties: Record<string, unknown>};
}
