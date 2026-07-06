// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreStyleEvaluator} from './types';

export type CompiledFilter = (
  zoom: number,
  feature: {properties: Record<string, unknown>}
) => boolean;

/** Compiles a MapLibre style layer's `filter` once via the injected evaluator's
 * `featureFilter`, returning a cheap per-feature predicate. A style layer with no `filter`
 * (undefined) always passes — MapLibre itself treats a missing filter as "match everything". */
export function compileFilter(filter: unknown, evaluator: MapLibreStyleEvaluator): CompiledFilter {
  if (filter === undefined) {
    return () => true;
  }
  const compiled = evaluator.featureFilter(filter);
  return (zoom, feature) => compiled.filter({zoom}, feature as never);
}
