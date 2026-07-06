// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect, vi} from 'vitest';
import {fetchSpriteAtlas} from '@deck.gl/geo-layers/maplibre-style-layer/sprite-fetch';

// Round 8 (real-integration feedback) finding, fork feedback #5: a `sprite` base-URL convenience
// -- fetch the JSON + PNG (and @2x variant, when present) a style's `sprite` field points at --
// as an alternative to a caller pre-fetching/pre-building the `spriteAtlas` prop by hand. Plain
// `fetch` only (no new runtime dependency); this is an opt-in helper invoked before constructing
// `_MapLibreStyleLayer`, not something the layer does itself.

const PNG_BYTES = new Uint8Array([1, 2, 3, 4]);
const SPRITE_JSON = {marker: {x: 0, y: 0, width: 16, height: 16, pixelRatio: 1}};

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    arrayBuffer: async () => (body as Uint8Array).buffer
  } as unknown as Response;
}

test('fetchSpriteAtlas#fetches {base}.json and {base}.png and assembles the atlas', async () => {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('.json')) return okResponse(SPRITE_JSON);
    return okResponse(PNG_BYTES);
  }) as unknown as typeof fetch;

  const atlas = await fetchSpriteAtlas('https://example.com/sprite', {fetch: fetchFn});
  expect(calls.sort()).toEqual([
    'https://example.com/sprite.json',
    'https://example.com/sprite.png'
  ]);
  expect(atlas.mapping).toEqual(SPRITE_JSON);
  expect(atlas.image).toMatch(/^data:image\/png;base64,/);
});

test('fetchSpriteAtlas#requests the @2x variant when pixelRatio >= 2', async () => {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('.json')) return okResponse(SPRITE_JSON);
    return okResponse(PNG_BYTES);
  }) as unknown as typeof fetch;

  await fetchSpriteAtlas('https://example.com/sprite', {fetch: fetchFn, pixelRatio: 2});
  expect(calls.sort()).toEqual([
    'https://example.com/sprite@2x.json',
    'https://example.com/sprite@2x.png'
  ]);
});

test('fetchSpriteAtlas#falls back to @1x when the style has no @2x sheet', async () => {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.includes('@2x')) return {ok: false, status: 404} as unknown as Response;
    if (url.endsWith('.json')) return okResponse(SPRITE_JSON);
    return okResponse(PNG_BYTES);
  }) as unknown as typeof fetch;

  const atlas = await fetchSpriteAtlas('https://example.com/sprite', {
    fetch: fetchFn,
    pixelRatio: 2
  });
  expect(atlas.mapping).toEqual(SPRITE_JSON);
});

test('fetchSpriteAtlas#rejects with a clear error when the JSON fetch fails (no @2x fallback to hide it)', async () => {
  const fetchFn = vi.fn(async (url: string) => {
    if (url.endsWith('.json')) return {ok: false, status: 500} as unknown as Response;
    return okResponse(PNG_BYTES);
  }) as unknown as typeof fetch;

  await expect(fetchSpriteAtlas('https://example.com/sprite', {fetch: fetchFn})).rejects.toThrow(
    /sprite JSON fetch failed/i
  );
});

test('fetchSpriteAtlas#throws when no fetch implementation is available', async () => {
  // `null` (not `undefined`) so the options default parameter doesn't fall through to a real
  // global `fetch` that may exist in this test environment.
  await expect(
    fetchSpriteAtlas('https://example.com/sprite', {fetch: null as unknown as typeof fetch})
  ).rejects.toThrow(/fetch/i);
});
