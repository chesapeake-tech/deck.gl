// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global ImageData */
import {test, expect} from 'vitest';
import {MapView} from '@deck.gl/core';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {testLayerAsync} from '@deck.gl/test-utils/vitest';
import {_WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import {MercatorCRSTileset2D} from '@deck.gl/geo-layers/warped-tile-layer/mercator-crs-tileset-2d';
import {Proj4Projection} from '@math.gl/proj4';

const utm18n = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});
const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18n.project(lnglat) as [number, number],
    inverse: xy => utm18n.unproject(xy) as [number, number]
  },
  extent: [166021.44, 0, 833978.56, 9329005.18] as [number, number, number, number],
  units: 'meters' as const
};

test('WarpedTileLayer#renders SimpleMeshLayer sublayers in a UTM view', async () => {
  const view = new MapView({crs: UTM18N});
  const viewport = view.makeViewport({
    width: 800,
    height: 600,
    viewState: {longitude: -72, latitude: 40, zoom: 7}
  })!;

  const testCases = [
    {
      title: 'warped tiles',
      props: {
        getTileData: () => Promise.resolve(new ImageData(4, 4))
      },
      onAfterUpdate: ({layer, subLayers}) => {
        expect(layer.state.tileset).toBeInstanceOf(MercatorCRSTileset2D);
        if (layer.isLoaded) {
          const meshLayers = subLayers.filter(l => l instanceof SimpleMeshLayer);
          expect(meshLayers.length).toBeGreaterThan(0);
          for (const meshLayer of meshLayers) {
            const {mesh, getPosition} = meshLayer.props;
            const positions = mesh.attributes.positions.value;
            for (const v of positions) {
              expect(Number.isFinite(v)).toBe(true);
            }
            const origin = getPosition(0);
            expect(Number.isFinite(origin[0])).toBe(true);
            // common-space origin is inside the 512-unit world
            expect(origin[0]).toBeGreaterThanOrEqual(0);
            expect(origin[0]).toBeLessThanOrEqual(512);
          }
          // memoized: the mesh is cached on the tile
          const tile = layer.state.tileset.selectedTiles[0];
          expect(tile.userData?.warpedMesh).toBeDefined();
        }
      }
    }
  ];

  await testLayerAsync({
    Layer: WarpedTileLayer,
    viewport,
    testCases,
    onError: err => expect(err).toBeFalsy()
  });
});
