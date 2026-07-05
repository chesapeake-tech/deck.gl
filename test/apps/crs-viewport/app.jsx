// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global document */
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import DeckGL from '@deck.gl/react';
import {MapView} from '@deck.gl/core';
import {BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {TileLayer, _WarpedTileLayer as WarpedTileLayer} from '@deck.gl/geo-layers';
import proj4 from 'proj4';

const utm18n = proj4('EPSG:4326', '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs');

const UTM18N = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18n.forward(lnglat),
    inverse: xy => utm18n.inverse(xy)
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};

const CRS_OPTIONS = {
  'Web Mercator': 'EPSG:3857',
  'EPSG:4326': 'EPSG:4326',
  'UTM 18N': UTM18N
};

// NASA GIBS EPSG:4326 '500m' TileMatrixSet, verbatim from the WMTS capabilities.
// Non-power-of-two matrix dimensions and grids that overflow the world extent —
// a good generality test for the TileMatrixSet indexing.
const GIBS_SCALE_DENOMINATORS = [
  223632905.6114871, 111816452.8057436, 55908226.40287178, 27954113.20143589, 13977056.60071795,
  6988528.300358973, 3494264.150179486, 1747132.075089743
];
const GIBS_MATRIX_SIZES = [
  [2, 1],
  [3, 2],
  [5, 3],
  [10, 5],
  [20, 10],
  [40, 20],
  [80, 40],
  [160, 80]
];
const GIBS_4326_TMS = {
  id: '500m',
  crs: 'EPSG:4326',
  tileMatrices: GIBS_SCALE_DENOMINATORS.map((scaleDenominator, z) => ({
    id: String(z),
    scaleDenominator,
    pointOfOrigin: [-180, 90],
    tileWidth: 512,
    tileHeight: 512,
    matrixWidth: GIBS_MATRIX_SIZES[z][0],
    matrixHeight: GIBS_MATRIX_SIZES[z][1]
  }))
};

// Demo UTM 18N TMS derived from the zone extent (non-square: 14 rows at level 0)
const UTM_TMS = {
  crs: 'EPSG:32618',
  tileMatrices: Array.from({length: 10}, (_, z) => {
    const cellSize = (UTM18N.extent[2] - UTM18N.extent[0]) / 512 / 2 ** z;
    return {
      id: String(z),
      cellSize,
      pointOfOrigin: [UTM18N.extent[0], UTM18N.extent[3]],
      tileWidth: 512,
      tileHeight: 512,
      matrixWidth: 2 ** z,
      matrixHeight: Math.ceil((UTM18N.extent[3] - UTM18N.extent[1]) / (cellSize * 512))
    };
  })
};

// Graticule: a lnglat grid to make projection distortion visible
function makeGraticule() {
  const paths = [];
  for (let lng = -80; lng <= -66; lng += 1) {
    paths.push({path: Array.from({length: 41}, (_, i) => [lng, 35 + i * 0.25])});
  }
  for (let lat = 35; lat <= 45; lat += 1) {
    paths.push({path: Array.from({length: 57}, (_, i) => [-80 + i * 0.25, lat])});
  }
  return paths;
}

// Zoom is extent-relative (see docs/api-reference/core/crs-viewport.md#zoom-is-extent-relative):
// this same zoom looks much more zoomed-in under the UTM 18N CRS than under Mercator/EPSG:4326,
// since UTM 18N's extent is a single zone rather than the whole globe.
const INITIAL_VIEW_STATE = {longitude: -72, latitude: 40, zoom: 7, pitch: 0, bearing: 0};

const CONTROLS_STYLE = {
  position: 'absolute',
  top: 10,
  left: 10,
  zIndex: 1,
  background: 'white',
  padding: 8
};

function App() {
  const [crsName, setCrsName] = useState('UTM 18N');
  const [showTiles, setShowTiles] = useState(true);
  const [utmBasemap, setUtmBasemap] = useState('osm'); // 'grid' | 'osm' | 'esri'

  const tileLayers = [];
  if (showTiles) {
    if (crsName === 'EPSG:4326') {
      tileLayers.push(
        new TileLayer({
          id: 'gibs',
          data: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/500m/{tm}/{y}/{x}.jpeg',
          tileMatrixSet: GIBS_4326_TMS,
          maxZoom: 7,
          renderSubLayers: props => {
            const {west, south, east, north} = props.tile.bbox;
            return new BitmapLayer(props, {
              data: null,
              image: props.data,
              bounds: [west, south, east, north]
            });
          }
        })
      );
    } else if (crsName === 'UTM 18N') {
      if (utmBasemap === 'grid') {
        // No public UTM tile server: render the tile grid itself to verify indexing
        tileLayers.push(
          new TileLayer({
            id: 'utm-grid',
            tileMatrixSet: UTM_TMS,
            getTileData: ({index}) => index,
            renderSubLayers: props => {
              // Exact tile rect: inverse-project the CRS-unit corners (tile.boundsCRS)
              const [minX, minY, maxX, maxY] = props.tile.boundsCRS;
              const inv = UTM18N.transform.inverse;
              const {x, y, z} = props.tile.index;
              return [
                new PathLayer(props, {
                  id: `${props.id}-outline`,
                  data: [
                    {
                      path: [
                        inv([minX, minY]),
                        inv([maxX, minY]),
                        inv([maxX, maxY]),
                        inv([minX, maxY]),
                        inv([minX, minY])
                      ]
                    }
                  ],
                  getPath: d => d.path,
                  getColor: [255, 140, 0, 200],
                  widthMinPixels: 2
                }),
                new TextLayer(props, {
                  id: `${props.id}-label`,
                  data: [
                    {position: inv([(minX + maxX) / 2, (minY + maxY) / 2]), text: `${z}/${x}/${y}`}
                  ],
                  getPosition: d => d.position,
                  getText: d => d.text,
                  getSize: 14,
                  getColor: [200, 100, 0, 255]
                })
              ];
            }
          })
        );
      } else {
        tileLayers.push(
          new WarpedTileLayer({
            id: `warped-${utmBasemap}`,
            data:
              utmBasemap === 'esri'
                ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            tileSize: 256,
            maxZoom: 19
          })
        );
      }
    } else {
      // Web Mercator regression: default OSM indexing, no tileMatrixSet
      tileLayers.push(
        new TileLayer({
          id: 'osm',
          data: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          maxZoom: 19,
          renderSubLayers: props => {
            const {west, south, east, north} = props.tile.bbox;
            return new BitmapLayer(props, {
              data: null,
              image: props.data,
              bounds: [west, south, east, north]
            });
          }
        })
      );
    }
  }

  const layers = [
    ...tileLayers,
    new GeoJsonLayer({
      id: 'states',
      data: 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json',
      stroked: true,
      filled: true,
      getFillColor: [60, 120, 180, 60],
      getLineColor: [60, 120, 180, 255],
      lineWidthMinPixels: 1
    }),
    new PathLayer({
      id: 'graticule',
      data: makeGraticule(),
      getPath: d => d.path,
      getColor: [140, 140, 140, 160],
      widthMinPixels: 1
    }),
    new ScatterplotLayer({
      id: 'anchors',
      data: [{position: [-72, 40]}, {position: [-75, 40]}],
      getPosition: d => d.position,
      getFillColor: [220, 60, 60],
      radiusMinPixels: 6
    })
  ];

  return (
    <>
      <div style={CONTROLS_STYLE}>
        {Object.keys(CRS_OPTIONS).map(name => (
          <button
            key={name}
            onClick={() => setCrsName(name)}
            style={{fontWeight: name === crsName ? 'bold' : 'normal'}}
          >
            {name}
          </button>
        ))}
        <label style={{marginLeft: 8}}>
          <input
            type="checkbox"
            checked={showTiles}
            onChange={e => setShowTiles(e.target.checked)}
          />
          tiles
        </label>
        {crsName === 'UTM 18N' && (
          <select value={utmBasemap} onChange={e => setUtmBasemap(e.target.value)}>
            <option value="grid">tile grid</option>
            <option value="osm">OSM (warped)</option>
            <option value="esri">Esri imagery (warped)</option>
          </select>
        )}
      </div>
      <DeckGL
        views={new MapView({crs: CRS_OPTIONS[crsName]})}
        initialViewState={INITIAL_VIEW_STATE}
        // MapView defaults controller normalization off for non-Mercator CRSs
        // (Mercator world-fit constraints would snap the view out of the CRS
        // extent on zoom-out), so plain `controller` works for all three modes.
        controller={true}
        layers={layers}
        getTooltip={({coordinate}) =>
          coordinate && `${coordinate[0].toFixed(5)}, ${coordinate[1].toFixed(5)}`
        }
      />
    </>
  );
}

createRoot(document.getElementById('app')).render(<App />);
