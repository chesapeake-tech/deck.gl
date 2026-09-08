// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {describe} from 'vitest';
import {runRenderTestSuite} from '../render-test-suite';
import type {TestCase} from '../deck-test-utils';
import testCases from './warped-tile-layer';

// Both devices on purpose: the CRS projection has a WGSL branch (project.wgsl.ts)
// that no other suite exercises, so a WebGPU-only regression in it would otherwise
// ship green.
describe.each(['webgl', 'webgpu'] as const)('%s', deviceType => {
  runRenderTestSuite(testCases as TestCase[], deviceType);
});
