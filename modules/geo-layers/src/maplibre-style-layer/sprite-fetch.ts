// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {MapLibreSpriteAtlas} from './types';

export interface FetchSpriteAtlasOptions {
  /** Override for `fetch` (tests, custom auth headers, an offline/cached loader, ...). Defaults
   * to the global `fetch`. */
  fetch?: typeof fetch;
  /** Device pixel ratio, used to request the sprite sheet's `@2x` variant when the caller is on
   * a high-DPI display and the style publishes one. Values `>= 2` request `@2x`; anything else
   * requests `@1x`. Default `1`. */
  pixelRatio?: number;
}

/** A resolved `spriteAtlas` — `{image, mapping}` — is easy
 * to build once fetched (see `spriteToIconMapping`), but every consumer of a real MapLibre style
 * (this v1's own app-side integration included) ends up re-writing the same ~30 lines: fetch the
 * style's `sprite` base URL's `.json` and `.png` (or `@2x` variants) and assemble the atlas
 * object. `_MapLibreStyleLayer` still does not fetch anything itself (the
 * `spriteAtlas`/bring-your-own-resolved-asset contract, matching `IconLayer.iconAtlas`, is
 * unchanged) — this is an opt-in convenience a caller invokes *before* constructing the layer,
 * using plain `fetch` only (no new runtime dependency, consistent with the adapter's
 * injected-evaluator philosophy: `@deck.gl/geo-layers` stays free of both
 * `@maplibre/maplibre-gl-style-spec` and any HTTP client dependency).
 *
 * Falls back from `@2x` to `@1x` on a failed `@2x` fetch (a style may not publish a retina
 * sheet), matching MapLibre GL JS's own sprite-loading fallback behavior. */
export async function fetchSpriteAtlas(
  spriteBaseUrl: string,
  options: FetchSpriteAtlasOptions = {}
): Promise<MapLibreSpriteAtlas> {
  const {fetch: fetchFn = (globalThis as {fetch?: typeof fetch}).fetch, pixelRatio = 1} = options;
  return fetchSpriteAtlasImpl(spriteBaseUrl, fetchFn, pixelRatio);
}

async function fetchSpriteAtlasImpl(
  spriteBaseUrl: string,
  fetchFn: typeof fetch | undefined,
  pixelRatio: number
): Promise<MapLibreSpriteAtlas> {
  if (typeof fetchFn !== 'function') {
    throw new Error(
      '_MapLibreStyleLayer: fetchSpriteAtlas() requires a `fetch` implementation — pass one via ' +
        '`options.fetch` in an environment with no global `fetch`.'
    );
  }
  const useHighDpi = pixelRatio >= 2;
  try {
    return await fetchSpriteVariant(spriteBaseUrl, useHighDpi ? '@2x' : '', fetchFn);
  } catch (error) {
    if (!useHighDpi) throw error;
    // A style may only publish a @1x sheet; fall back rather than fail the whole resolve.
    return fetchSpriteVariant(spriteBaseUrl, '', fetchFn);
  }
}

async function fetchSpriteVariant(
  spriteBaseUrl: string,
  suffix: string,
  fetchFn: typeof fetch
): Promise<MapLibreSpriteAtlas> {
  const jsonUrl = `${spriteBaseUrl}${suffix}.json`;
  const pngUrl = `${spriteBaseUrl}${suffix}.png`;
  const [jsonResponse, pngResponse] = await Promise.all([fetchFn(jsonUrl), fetchFn(pngUrl)]);
  if (!jsonResponse.ok) {
    throw new Error(
      `_MapLibreStyleLayer: sprite JSON fetch failed (${jsonResponse.status}): ${jsonUrl}`
    );
  }
  if (!pngResponse.ok) {
    throw new Error(
      `_MapLibreStyleLayer: sprite PNG fetch failed (${pngResponse.status}): ${pngUrl}`
    );
  }
  const [mapping, image] = await Promise.all([
    jsonResponse.json() as Promise<MapLibreSpriteAtlas['mapping']>,
    arrayBufferToPngDataUrl(pngResponse)
  ]);
  return {image, mapping};
}

/** A `data:` URL (not `URL.createObjectURL`) so the result is usable from either a browser or a
 * Node test environment without a DOM, and needs no explicit revocation. */
async function arrayBufferToPngDataUrl(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  return `data:image/png;base64,${arrayBufferToBase64(buffer)}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // eslint-disable-next-line no-undef
  return btoa(binary);
}
