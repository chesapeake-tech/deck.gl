// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreSpriteAtlas} from './types';

/** Structurally matches `@deck.gl/layers`' `IconLayer` `iconMapping` entry shape
 * (`modules/layers/src/icon-layer/icon-manager.ts`, `PrepackedIcon`:
 * `{x, y, width, height, anchorX?, anchorY?, mask?}`). Deviation (Task 8): `IconMapping`/
 * `PrepackedIcon` are not re-exported from `@deck.gl/layers`'s public index (only
 * `IconLayerProps`), so this is declared locally rather than imported — the shape is a plain
 * data contract, not a class, so structural equivalence is sufficient for `IconLayer.iconMapping`. */
export interface DeckIconMappingEntry {
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX?: number;
  anchorY?: number;
  mask?: boolean;
}

export type DeckIconMapping = Record<string, DeckIconMappingEntry>;

/** A MapLibre/Mapbox sprite JSON entry (`{x,y,width,height,pixelRatio,sdf}`) is almost exactly
 * deck.gl's `IconMapping` entry shape — same rectangle keys, no restructuring. Only
 * `pixelRatio` (deck.gl doesn't need it; the atlas image is used at its native resolution) is
 * dropped and `sdf` (recolorable single-channel icon) is renamed to deck.gl's `mask`. */
export function spriteToIconMapping(sprite: MapLibreSpriteAtlas['mapping']): DeckIconMapping {
  const mapping: DeckIconMapping = {};
  for (const [name, entry] of Object.entries(sprite)) {
    mapping[name] = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      mask: Boolean(entry.sdf)
    };
  }
  return mapping;
}
