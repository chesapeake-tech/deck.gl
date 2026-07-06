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
  /** Review fix (I3b): deck.gl's own atlas rendering doesn't need this (the atlas image is
   * sampled at its native resolution), but it must be carried through — not dropped — because
   * `icon-size` (mapSymbolIconLayer) is a multiplier of the sprite's *native/logical* size,
   * which is `height / pixelRatio`, not the raw atlas rect `height`. Defaults to 1 (a MapLibre
   * sprite JSON entry with no `pixelRatio` is a 1x/non-retina sprite). */
  pixelRatio: number;
}

export type DeckIconMapping = Record<string, DeckIconMappingEntry>;

/** A MapLibre/Mapbox sprite JSON entry (`{x,y,width,height,pixelRatio,sdf}`) is almost exactly
 * deck.gl's `IconMapping` entry shape — same rectangle keys, no restructuring. `sdf`
 * (recolorable single-channel icon) is renamed to deck.gl's `mask`; `pixelRatio` is carried
 * through (Review fix I3b — previously dropped, needed by the icon-size mapping) rather than
 * removed. */
export function spriteToIconMapping(sprite: MapLibreSpriteAtlas['mapping']): DeckIconMapping {
  const mapping: DeckIconMapping = {};
  for (const [name, entry] of Object.entries(sprite)) {
    mapping[name] = {
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      mask: Boolean(entry.sdf),
      pixelRatio: entry.pixelRatio ?? 1
    };
  }
  return mapping;
}
