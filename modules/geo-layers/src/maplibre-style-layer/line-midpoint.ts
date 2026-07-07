// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The v1 `symbol-placement: 'line'` fallback: one horizontal label
 * anchored at the point half the cumulative line length along the vertex chain — not the
 * geometric bounding-box center, which can land off the line entirely for bent/L-shaped
 * geometries. No curve, no repeated labeling; documented as a fidelity cut, not silently
 * dropped (the caller emits a console.warn once per style-layer id — see symbol-text mapper). */
export function lineMidpoint(coordinates: [number, number][]): [number, number] {
  if (coordinates.length <= 1) {
    return coordinates[0] ?? [0, 0];
  }
  const segmentLengths: number[] = [];
  let total = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const [x0, y0] = coordinates[i - 1];
    const [x1, y1] = coordinates[i];
    const length = Math.hypot(x1 - x0, y1 - y0);
    segmentLengths.push(length);
    total += length;
  }
  const half = total / 2;
  let cumulative = 0;
  for (let i = 0; i < segmentLengths.length; i++) {
    const length = segmentLengths[i];
    if (cumulative + length >= half || i === segmentLengths.length - 1) {
      const t = length === 0 ? 0 : (half - cumulative) / length;
      const [x0, y0] = coordinates[i];
      const [x1, y1] = coordinates[i + 1];
      return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
    }
    cumulative += length;
  }
  return coordinates[0];
}
