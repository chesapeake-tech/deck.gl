// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {spriteToIconMapping} from '@deck.gl/geo-layers/maplibre-style-layer/sprite-mapping';

test('spriteToIconMapping#drops pixelRatio, renames sdf to mask', () => {
  const mapping = spriteToIconMapping({
    'harbor-15': {x: 0, y: 0, width: 15, height: 15, pixelRatio: 2, sdf: true},
    'park-11': {x: 15, y: 0, width: 11, height: 11, pixelRatio: 2}
  });
  expect(mapping['harbor-15']).toEqual({x: 0, y: 0, width: 15, height: 15, mask: true});
  expect(mapping['park-11']).toEqual({x: 15, y: 0, width: 11, height: 11, mask: false});
});
