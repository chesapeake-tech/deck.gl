// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * CRS/MapLibre-style-adapter perf benchmark. Not part of the vitest suite (no test-runner
 * dependency) -- a small, plain-Node microbenchmark that exercises the same production code
 * paths described in docs/superpowers/specs/2026-07-05-crs-mvt-style-adapter-design.md's
 * Performance section, run on demand to get real numbers rather than guesses.
 *
 * This is a TypeScript file (the modules it measures are TS source with no checked-in plain-JS
 * build -- `modules/*\/src` is the only copy) rather than a plain `.js` -- run it with `tsx`
 * (already available via `npx`, no new dependency needed; every import below is either a real
 * published package already in this repo's `node_modules` or a plain relative import of this
 * repo's own TS source, so no vite/vitest alias resolution is required):
 *
 *   npx tsx test/perf/crs-bench.ts
 *
 * Measures:
 *   1. `buildWarpedTileMesh` cost per tile, mesh resolution N=4..32 (warped-raster CRS path).
 *   2. Real MVT tile decode cost: `wgs84`/geojson (CRS "feature route", `mvt-layer.ts`'s
 *      `usesFeatureRoute` branch -- always non-binary) vs. `local`/binary (classic Mercator fast
 *      path) -- the per-tile-load cost difference a CRS view pays over classic Mercator.
 *   3. Style-expression compile-once cost vs. per-feature evaluate() throughput
 *      (`compile-expression.ts`).
 *   4. The zoom-bucket-crossing sublayer-regen storm this task's fix addresses
 *      (`maplibre-style-layer.ts`'s `renderSubLayers` closure) -- BEFORE (cold cache every
 *      crossing, i.e. the pre-fix behavior: every style layer rebuilds unconditionally) vs.
 *      AFTER (warm cache, this fix's skip logic) -- the key number for the upstream RFC.
 */

import {readFileSync} from 'fs';
import {parse} from '@loaders.gl/core';
import {MVTLoader} from '@loaders.gl/mvt';
import {createPropertyExpression, featureFilter} from '@maplibre/maplibre-gl-style-spec';
import WebMercatorViewport from '../../modules/core/src/viewports/web-mercator-viewport';
import {normalizeCRS} from '../../modules/core/src/viewports/crs-utils';
import {
  buildWarpedTileMesh,
  makeWebMercatorQuadTms
} from '../../modules/geo-layers/src/warped-tile-layer/warp-mesh';
import {getTileBoundsCRS} from '../../modules/geo-layers/src/tileset-2d/tile-matrix-set';
import {compileExpression} from '../../modules/geo-layers/src/maplibre-style-layer/compile-expression';
import {MapLibreStyleLayer} from '../../modules/geo-layers/src/maplibre-style-layer/maplibre-style-layer';
import MVTLayer from '../../modules/geo-layers/src/mvt-layer/mvt-layer';

const evaluator = {createPropertyExpression, featureFilter};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/** Median of N timed repetitions of `fn` (median is far less sensitive to a single GC pause or
 * JIT warmup outlier than a mean would be -- exactly the kind of noise a synchronous main-thread
 * regen storm produces in a real browser). `warmup` reps run first and are discarded. */
function timeMs(fn: () => void, reps = 20, warmup = 3): number {
  for (let i = 0; i < warmup; i++) fn();
  const samples: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

type Row = Record<string, string | number>;

function printTable(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(line(widths.map(w => '-'.repeat(w))));
  for (const r of rows) {
    console.log(line(cols.map((c, i) => String(r[c]).padEnd(widths[i]))));
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Warp-mesh build cost per tile (warped-raster CRS path, warp-mesh.ts)
// ---------------------------------------------------------------------------------------------

function benchWarpMesh(): Row[] {
  const crs = normalizeCRS('EPSG:4326');
  const tms = makeWebMercatorQuadTms(256, 4);
  const boundsWorld = getTileBoundsCRS(tms.tileMatrices[2], 1, 1);
  const rows: Row[] = [];
  for (const n of [4, 8, 16, 32]) {
    const ms = timeMs(() => buildWarpedTileMesh(boundsWorld, crs, n));
    rows.push({
      'mesh N': n,
      vertices: (n + 1) * (n + 1),
      'median ms/tile': ms.toFixed(3)
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 2. wgs84 (non-binary, CRS feature-route) vs. binary (classic Mercator) MVT decode
// ---------------------------------------------------------------------------------------------

async function benchMvtDecode(): Promise<Row[]> {
  // A real, checked-in MVT fixture (test/data/mvt-tiles/3/2/3.mvt) -- large enough (1664+
  // features) to give a meaningful decode cost, not a toy 3-feature tile.
  const buf = readFileSync(new URL('../data/mvt-tiles/3/2/3.mvt', import.meta.url));
  const tileIndex = {x: 2, y: 3, z: 3};

  const variants = {
    'local / geojson (baseline decode, no reprojection)': {shape: 'geojson', coordinates: 'local'},
    'wgs84 / geojson (CRS feature route -- adds per-vertex reprojection)': {
      shape: 'geojson',
      coordinates: 'wgs84'
    },
    'local / binary (classic Mercator -- what MVTLayer actually uses)': {
      shape: 'binary',
      coordinates: 'local'
    }
  } as const;

  // `parse` is async (worker-shaped API even with worker:false) -- time wall-clock await.
  // Interleave the three variants across repetitions (rather than running all reps of one
  // variant, then all reps of the next) so no single variant systematically benefits from
  // whatever JIT/GC state exists at the point it happens to run.
  async function timeAsyncMs(
    fn: () => Promise<unknown>,
    reps: number,
    warmup: number
  ): Promise<number> {
    for (let i = 0; i < warmup; i++) await fn();
    const samples: number[] = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  // Reference feature count from the geojson shape (an array of Features) -- the `binary` shape
  // returns a different, non-array `{points, lines, polygons, ...}` object with no single
  // `.length`, so it's reported against this same reference count rather than its own shape.
  const referenceFeatureCount = (
    (await parse(buf, MVTLoader, {
      core: {worker: false},
      mvt: {shape: 'geojson', coordinates: 'local', tileIndex}
    })) as unknown[]
  ).length;

  const rows: Row[] = [];
  for (const [label, mvtOptions] of Object.entries(variants)) {
    const ms = await timeAsyncMs(
      () => parse(buf, MVTLoader, {core: {worker: false}, mvt: {...mvtOptions, tileIndex}}),
      12,
      3
    );
    rows.push({route: label, features: referenceFeatureCount, 'median ms/tile': ms.toFixed(3)});
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// 3. Style-expression compile-once cost vs. per-feature evaluate() throughput
// ---------------------------------------------------------------------------------------------

function benchExpressionThroughput(): Row[] {
  const zoomExpr = ['interpolate', ['linear'], ['zoom'], 0, '#ff0000', 20, '#0000ff'];
  const feature = {properties: {class: 'water'}, geometry: {type: 'Polygon'}};

  const compileMs = timeMs(
    () => compileExpression(zoomExpr, {type: 'color'}, evaluator, new Map()),
    50,
    5
  );

  const compiled = compileExpression<string>(zoomExpr, {type: 'color'}, evaluator, new Map());
  const N_EVAL = 200_000;
  const evalMs = timeMs(
    () => {
      for (let i = 0; i < N_EVAL; i++) compiled.evaluate(10.5, feature);
    },
    10,
    2
  );
  const perFeatureUs = (evalMs / N_EVAL) * 1000;

  return [
    {metric: 'compile (first-time parse/AST build)', value: `${compileMs.toFixed(3)} ms`},
    {
      metric: `evaluate() throughput (${N_EVAL.toLocaleString()} calls)`,
      value: `${Math.round(N_EVAL / (evalMs / 1000)).toLocaleString()} features/sec (${perFeatureUs.toFixed(4)} us/feature)`
    }
  ];
}

// ---------------------------------------------------------------------------------------------
// 4. Zoom-bucket-crossing regen storm: BEFORE (cold cache every crossing) vs. AFTER (this fix)
// ---------------------------------------------------------------------------------------------

function makeBenchStyle(nStatic: number, nZoomDependent: number) {
  const layers: unknown[] = [];
  for (let i = 0; i < nStatic; i++) {
    layers.push({
      id: `static-${i}`,
      type: i % 2 === 0 ? 'fill' : 'line',
      filter: ['==', ['get', 'class'], `class-${i % 5}`],
      paint:
        i % 2 === 0
          ? {'fill-color': '#a0c8f0', 'fill-opacity': 0.8}
          : {'line-color': '#ffffff', 'line-width': 2}
    });
  }
  for (let i = 0; i < nZoomDependent; i++) {
    layers.push({
      id: `zoomdep-${i}`,
      type: 'fill',
      filter: ['==', ['get', 'class'], `class-${i % 5}`],
      paint: {'fill-color': ['interpolate', ['linear'], ['zoom'], 0, '#ff0000', 20, '#0000ff']}
    });
  }
  return {layers};
}

function makeBenchFeatures(k: number) {
  const features: unknown[] = [];
  for (let i = 0; i < k; i++) {
    features.push({
      type: 'Feature',
      properties: {class: `class-${i % 5}`},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [i, 0],
            [i + 1, 0],
            [i + 1, 1],
            [i, 0]
          ]
        ]
      }
    });
  }
  return features;
}

function makeLayer(style: unknown): MapLibreStyleLayer {
  const layer = new MapLibreStyleLayer({
    style,
    source: {data: 'https://example.com/tiles/{z}/{x}/{y}.mvt'},
    evaluator
  } as never);
  (layer as unknown as {internalState: unknown}).internalState = {subLayers: []};
  (layer as unknown as {props: unknown}).props = layer.props;
  return layer;
}

function crossOnce(
  layer: MapLibreStyleLayer,
  zoom: number,
  tiles: Array<{id: string; data: unknown}>
): number {
  (layer as unknown as {context: unknown}).context = {
    viewport: new WebMercatorViewport({width: 1280, height: 800, longitude: 0, latitude: 0, zoom})
  };
  const layers = layer.renderLayers() as unknown[];
  const mvt = layers.find(l => l instanceof MVTLayer) as {
    props: {renderSubLayers: (t: unknown) => unknown};
  };
  const t0 = performance.now();
  for (const t of tiles) mvt.props.renderSubLayers(t);
  return performance.now() - t0;
}

function benchBucketCrossingRegen(
  nTiles: number,
  nStatic: number,
  nZoomDep: number,
  k: number
): Row {
  const style = makeBenchStyle(nStatic, nZoomDep);
  const tiles = Array.from({length: nTiles}, (_, i) => ({
    id: `tile-${i}`,
    data: makeBenchFeatures(k)
  }));

  // Warm the COMPILE cache only (a real one-time cost paid once per style, before OR after this
  // fix -- see section 3's ~0.01ms/expression compile cost) on a throwaway instance, then copy
  // just `compileCache`/`cacheStyle`/`cacheEvaluator` (not `subLayerCache`) onto each BEFORE
  // sample's fresh instance below. This isolates "cost of one regen pass" from "one-time compile
  // cost" for a fair BEFORE number -- the real pre-fix code paid the former on every crossing but
  // the latter only once ever (Review fix I6 predates this task).
  const warmup = makeLayer(style);
  crossOnce(warmup, 5.7, [{id: 'warmup-tile-only', data: makeBenchFeatures(k)}]);
  const warmCompileState = (warmup as unknown as {state: Record<string, unknown>}).state;

  // BEFORE (pre-fix behavior): a fresh sublayer cache (`subLayerCache: new Map()`) on every
  // sampled crossing reproduces exactly what the pre-fix code did -- `renderSubLayers` had no
  // memoization at all, so EVERY style layer re-ran `mapOneStyleLayer`'s full filter/compile-
  // lookup/feature-loop on EVERY zoom-bucket crossing, regardless of zoom-dependence.
  const N_SAMPLES = 6;
  const beforeSamples: number[] = [];
  for (let i = 0; i < N_SAMPLES; i++) {
    const layer = makeLayer(style);
    (layer as unknown as {state: Record<string, unknown>}).state = {
      compileCache: warmCompileState.compileCache,
      cacheStyle: warmCompileState.cacheStyle,
      cacheEvaluator: warmCompileState.cacheEvaluator,
      warnedUnsupportedIds: new Set(),
      warnedLinePlacementIds: new Set(),
      subLayerCache: new Map() // cold every sample -- the pre-fix behavior, forever
    };
    beforeSamples.push(crossOnce(layer, 6.2 + i, tiles));
  }
  beforeSamples.sort((a, b) => a - b);
  const before = beforeSamples[Math.floor(beforeSamples.length / 2)];

  // AFTER (this fix): ONE instance, ONE warm sublayer cache, repeated crossings against the SAME
  // tile data references -- exactly the real "continuous zoom gesture" access pattern this fix
  // targets (see maplibre-style-layer.ts's `renderSubLayers` doc comment).
  const layer = makeLayer(style);
  crossOnce(layer, 5.7, tiles); // first pass: populates the sublayer cache for every tile
  const afterSamples: number[] = [];
  for (let i = 0; i < N_SAMPLES; i++) {
    afterSamples.push(crossOnce(layer, 6.2 + i, tiles));
  }
  afterSamples.sort((a, b) => a - b);
  const after = afterSamples[Math.floor(afterSamples.length / 2)];

  return {
    'tiles x layers (static/zoom-dep) x features': `${nTiles} x ${nStatic + nZoomDep} (${nStatic}/${nZoomDep}) x ${k}`,
    'BEFORE median ms/crossing': before.toFixed(2),
    'AFTER median ms/crossing': after.toFixed(2),
    speedup: `${(before / after).toFixed(2)}x`
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  console.log('=== CRS / MapLibre-style-adapter perf benchmark ===');
  console.log(`node ${process.version}, ${new Date().toISOString()}`);

  printTable(
    '1. Warp-mesh build cost per tile (warp-mesh.ts#buildWarpedTileMesh)',
    benchWarpMesh()
  );

  printTable(
    '2. MVT tile decode: wgs84/geojson (CRS feature route) vs. local/binary (classic Mercator)',
    await benchMvtDecode()
  );

  printTable(
    '3. Style expression compile-once cost vs. per-feature evaluate() throughput',
    benchExpressionThroughput()
  );

  printTable('4. Zoom-bucket-crossing sublayer regen: BEFORE vs. AFTER this fix', [
    benchBucketCrossingRegen(24, 9, 3, 200),
    benchBucketCrossingRegen(48, 18, 6, 500),
    benchBucketCrossingRegen(48, 22, 2, 500)
  ]);

  console.log('\nDone.');
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
