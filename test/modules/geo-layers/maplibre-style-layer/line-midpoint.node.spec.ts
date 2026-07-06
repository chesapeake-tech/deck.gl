// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {lineMidpoint} from '@deck.gl/geo-layers/maplibre-style-layer/line-midpoint';

test('lineMidpoint#straight 2-point line: exact midpoint', () => {
  expect(
    lineMidpoint([
      [0, 0],
      [10, 0]
    ])
  ).toEqual([5, 0]);
});

test('lineMidpoint#3-point line: half cumulative length, not bbox center', () => {
  // Segment lengths: 1 (0,0)->(1,0), then 9 (1,0)->(1,9). Total 10; midpoint at length 5,
  // i.e. 4 units into the second segment: (1, 4).
  const [x, y] = lineMidpoint([
    [0, 0],
    [1, 0],
    [1, 9]
  ]);
  expect(x).toBeCloseTo(1, 6);
  expect(y).toBeCloseTo(4, 6);
});

test('lineMidpoint#single point: returns it unchanged', () => {
  expect(lineMidpoint([[3, 4]])).toEqual([3, 4]);
});
