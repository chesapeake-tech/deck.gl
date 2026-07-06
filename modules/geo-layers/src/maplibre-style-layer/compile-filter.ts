// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';
import {withGeometryTypeCode} from './geometry-type';

export type CompiledFilter = (
  zoom: number,
  feature: {properties: Record<string, unknown>; geometry?: {type?: string}}
) => boolean;

/** Compiles a MapLibre style layer's `filter` once via the injected evaluator's
 * `featureFilter`, returning a cheap per-feature predicate. A style layer with no `filter`
 * (undefined) always passes — MapLibre itself treats a missing filter as "match everything". */
export function compileFilter(filter: unknown, evaluator: MapLibreStyleEvaluator): CompiledFilter {
  if (filter === undefined) {
    return () => true;
  }
  if (typeof evaluator?.featureFilter !== 'function') {
    throw new Error(
      '_MapLibreStyleLayer: the injected `evaluator.featureFilter` is not a function — pass the ' +
        'real `featureFilter` export from `@maplibre/maplibre-gl-style-spec` (or a structurally ' +
        'identical implementation) as `evaluator.featureFilter`.'
    );
  }
  const compiled = evaluator.featureFilter(filter);
  // Review fix (C3): $type / ["geometry-type"] compare against a VectorTileFeature's numeric
  // `type` code (1/2/3), not a GeoJSON feature's `type: 'Feature'` — shim it in per call so a
  // legacy `["==", "$type", "Polygon"]` (or expression `["==", ["geometry-type"], "Polygon"]`)
  // filter matches real GeoJSON features instead of silently dropping all of them.
  return (zoom, feature) => compiled.filter({zoom}, withGeometryTypeCode(feature) as never);
}
