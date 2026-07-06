// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {spriteToIconMapping} from '@deck.gl/geo-layers/maplibre-style-layer/sprite-mapping';

test('spriteToIconMapping#renames sdf to mask', () => {
  const mapping = spriteToIconMapping({
    'harbor-15': {x: 0, y: 0, width: 15, height: 15, pixelRatio: 2, sdf: true},
    'park-11': {x: 15, y: 0, width: 11, height: 11, pixelRatio: 2}
  });
  expect(mapping['harbor-15']).toEqual({
    x: 0,
    y: 0,
    width: 15,
    height: 15,
    mask: true,
    pixelRatio: 2
  });
  expect(mapping['park-11']).toEqual({
    x: 15,
    y: 0,
    width: 11,
    height: 11,
    mask: false,
    pixelRatio: 2
  });
});

// Review finding I3(b): `pixelRatio` was previously dropped entirely — deck.gl's IconLayer
// doesn't need it for its own atlas math, but the adapter's icon-size mapping (icon-size is a
// MULTIPLIER of the sprite's native/logical size, i.e. `height / pixelRatio`) does. Carry it
// through (defaulting to 1, matching a MapLibre sprite JSON's own "absent = 1" convention) so
// the symbol-icon mapper can compute the correct on-screen size.
test('spriteToIconMapping#defaults pixelRatio to 1 when absent from the sprite JSON entry', () => {
  const mapping = spriteToIconMapping({
    'plain-icon': {x: 0, y: 0, width: 20, height: 20}
  });
  expect(mapping['plain-icon'].pixelRatio).toBe(1);
});
