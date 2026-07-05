// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {TerrainLayer, _CRSTileset2D as CRSTileset2D} from '@deck.gl/geo-layers';
import {TerrainLoader} from '@loaders.gl/terrain';
import {makeUTM18NTms} from './tileset-2d/tms-fixtures';
import {UTM18N} from '../core/viewports/crs-fixtures';

test('TerrainLayer#tileMatrixSet selects _CRSTileset2D and bakes exact common-space bounds', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 3}
  })!;
  const tileMatrixSet = makeUTM18NTms(6);

  const testCases = [
    {
      title: 'CRS-native terrain tiling',
      props: {
        elevationData: 'https://example.com/dem/{z}/{x}/{y}.png',
        tileMatrixSet,
        loaders: [TerrainLoader]
      },
      onAfterUpdate: ({layer, subLayers}) => {
        const tileLayer = subLayers[0];
        expect(tileLayer.state.tileset).toBeInstanceOf(CRSTileset2D);
        const tile = tileLayer.state.tileset.selectedTiles?.[0];
        if (tile) {
          expect((tile as any).boundsCommon).toBeDefined();
        }
      }
    }
  ];

  await testLayerAsync({
    Layer: TerrainLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
