// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {
  TileLayer,
  _CRSTileset2D as CRSTileset2D,
  _Tileset2D as Tileset2D
} from '@deck.gl/geo-layers';
import {makeWorldCRS84Quad512} from '../tileset-2d/tms-fixtures';

test('TileLayer#default TilesetClass without tileMatrixSet (Mercator regression)', async () => {
  // Plain Mercator viewport (the harness default): no tileMatrixSet -> base Tileset2D
  const testCases = [
    {
      title: 'default tileset',
      props: {
        getTileData: () => Promise.resolve([])
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(Tileset2D);
        expect(layer.state.tileset).not.toBeInstanceOf(CRSTileset2D);
      }
    }
  ];
  await testLayerAsync({Layer: TileLayer, testCases, onError: err => expect(err).toBeFalsy()});
});

test('TileLayer#tileMatrixSet selects CRSTileset2D and recreates on change', async () => {
  const view = new MapView({crs: 'EPSG:4326'});
  const viewport = view.makeViewport({
    width: 1024,
    height: 512,
    viewState: {longitude: 0, latitude: 0, zoom: 1}
  })!;
  const tileMatrixSet = makeWorldCRS84Quad512(6);
  const otherTileMatrixSet = makeWorldCRS84Quad512(4); // different identity
  let firstTileset = null;

  const testCases = [
    {
      title: 'with tileMatrixSet: CRS tileset selects level-0 tiles',
      props: {
        tileMatrixSet,
        getTileData: () => Promise.resolve([])
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(CRSTileset2D);
        firstTileset = layer.state.tileset;
        const indices = layer.state.tileset.selectedTiles.map(t => t.index);
        expect(indices).toHaveLength(2);
        expect(indices).toEqual(
          expect.arrayContaining([expect.objectContaining({x: 0, y: 0, z: 0, tm: '0'})])
        );
      }
    },
    {
      title: 'changing tileMatrixSet identity recreates the tileset',
      updateProps: {
        tileMatrixSet: otherTileMatrixSet
      },
      onAfterUpdate: ({layer}) => {
        expect(layer.state.tileset).toBeInstanceOf(CRSTileset2D);
        expect(layer.state.tileset).not.toBe(firstTileset);
      }
    }
  ];

  await testLayerAsync({
    Layer: TileLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
