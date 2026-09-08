// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe} from 'vitest';
import {runRenderTestSuite} from '../render-test-suite';
import type {TestCase} from '../deck-test-utils';
import testCases from './crs-view';

// The CRS projection has its own WGSL branch (project.wgsl.ts) that no upstream
// suite exercises, so the CRS cases run on BOTH devices. Two cases are WebGL-only
// because the gap is upstream's experimental WebGPU path, not the CRS branch —
// both reproduce identically in a plain Web-Mercator MapView (checked 2026-09-08):
//   - crs-utm-mask: MaskExtension has no WGSL (upstream keeps effects.spec.ts and
//     collision-filter-extension.spec.ts WebGL-only for the same reason).
//   - crs-utm-bearing-pitch: under pitch, WebGPU lets a filled polygon occlude
//     co-planar PathLayer/ScatterplotLayer geometry (98.1% match vs the 99% gate).
// Move a name out of WEBGL_ONLY once upstream fixes it; the case itself is unchanged.
const WEBGL_ONLY = new Set(['crs-utm-mask', 'crs-utm-bearing-pitch']);

const allCases = testCases as TestCase[];
const dualDeviceCases = allCases.filter(tc => !WEBGL_ONLY.has(tc.name));
const webglOnlyCases = allCases.filter(tc => WEBGL_ONLY.has(tc.name));

describe.each(['webgl', 'webgpu'] as const)('%s', deviceType => {
  runRenderTestSuite(dualDeviceCases, deviceType);
});

describe('webgl (upstream WebGPU gaps)', () => {
  runRenderTestSuite(webglOnlyCases, 'webgl');
});
