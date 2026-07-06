// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global document */
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import DeckGL from '@deck.gl/react';
import {COORDINATE_SYSTEM, MapView} from '@deck.gl/core';
import {normalizeCRS, lngLatToCommon} from '@deck.gl/core/viewports/crs-utils';
import {BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer} from '@deck.gl/layers';
import {
  MVTLayer,
  TerrainLayer,
  TileLayer,
  _WarpedTileLayer as WarpedTileLayer
} from '@deck.gl/geo-layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';
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

// Task 4 (Phase 4 plan) verification: a CRS-native (tileMatrixSet-indexed) TerrainLayer.
// No public UTM 18N elevation service is available for this demo, and no public Web-Mercator
// terrain-RGB service's real tile addresses line up with our demo UTM_TMS's (x, y) indices
// (its rows-tall-vs-columns-wide aspect ratio, needed to cover the whole zone, means most
// (z, x, y) combos fall outside any real Mercator pyramid's valid range at that z — a 404, not
// a registration problem). So this synthesizes each tile's mesh directly via the `fetch` prop
// override, the same network-free pattern this repo's own tests use
// (test/modules/geo-layers/terrain-layer-loading.spec.ts) to exercise TerrainLayer without a
// real elevation service. It bypasses `@loaders.gl/terrain`'s image decode entirely — the
// point of this demo is registration, not decoded content: each tile's mesh quad exactly fills
// `loadOptions.terrain.bounds`, the same `_CRSTileset2D` `boundsCommon` rectangle Task 2's fix
// feeds through `resolveTiledTerrainBounds`/`getOverlappedBounds`, directly checkable against
// the graticule/state overlays below.
function makeSyntheticTerrainMesh(bounds) {
  const [minX, minY, maxX, maxY] = bounds;
  // A visible, deterministic elevation ripple so pitch/rotation reveals real 3D relief.
  const elevation = (x, y) => 400 + 400 * Math.sin(x / 50000) * Math.cos(y / 50000);
  const corners = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY]
  ];
  const positions = new Float32Array(corners.flatMap(([x, y]) => [x, y, elevation(x, y)]));
  const z = positions.filter((_, i) => i % 3 === 2);
  return {
    header: {
      boundingBox: [
        [minX, minY, Math.min(...z)],
        [maxX, maxY, Math.max(...z)]
      ]
    },
    mode: 4, // TRIANGLES
    indices: {value: new Uint32Array([0, 1, 2, 0, 2, 3]), size: 1},
    attributes: {
      POSITION: {value: positions, size: 3},
      NORMAL: {value: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), size: 3},
      TEXCOORD_0: {value: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), size: 2}
    }
  };
}

// Task 4 (Stage 1, E1 plan) verification: a CRS-native (tileMatrixSet-indexed) MVTLayer,
// layered over the warped Esri imagery basemap. No public UTM 18N vector-tile service exists
// (same gap as the TerrainLayer demo above), so this synthesizes each tile's already-decoded
// (lnglat) `Feature[]` content directly via the `fetch` prop override — the same network-free
// pattern used above — one inset polygon plus one labeled point per tile, built from the same
// tileMatrixSet cell math the "tile grid" demo uses for its outline, so registration against
// the graticule/state overlay and the Esri basemap is directly checkable.
function utmTileCrsBounds(z, x, y) {
  const {pointOfOrigin, cellSize} = UTM_TMS.tileMatrices[z];
  const minX = pointOfOrigin[0] + x * cellSize * 512;
  const maxX = minX + cellSize * 512;
  const maxY = pointOfOrigin[1] - y * cellSize * 512;
  const minY = maxY - cellSize * 512;
  return [minX, minY, maxX, maxY];
}

function makeSyntheticMvtFeatures(z, x, y) {
  const [minX, minY, maxX, maxY] = utmTileCrsBounds(z, x, y);
  const inv = UTM18N.transform.inverse;
  const insetX = (maxX - minX) * 0.15;
  const insetY = (maxY - minY) * 0.15;
  const ring = [
    [minX + insetX, minY + insetY],
    [maxX - insetX, minY + insetY],
    [maxX - insetX, maxY - insetY],
    [minX + insetX, maxY - insetY],
    [minX + insetX, minY + insetY]
  ].map(inv);
  const center = inv([(minX + maxX) / 2, (minY + maxY) / 2]);
  return [
    {
      type: 'Feature',
      properties: {class: 'parcel', tile: `${z}/${x}/${y}`},
      geometry: {type: 'Polygon', coordinates: [ring]}
    },
    {
      type: 'Feature',
      properties: {name: `tile ${z}/${x}/${y}`},
      geometry: {type: 'Point', coordinates: center}
    }
  ];
}

function makeUtmMvtLayers() {
  return [
    new WarpedTileLayer({
      id: 'warped-esri-under-mvt',
      data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      tileSize: 256,
      maxZoom: 19
    }),
    new MVTLayer({
      id: 'utm-mvt',
      // Placeholder template: never fetched over the network, see `fetch` override below.
      data: 'synthetic://{z}/{x}/{y}',
      tileMatrixSet: UTM_TMS,
      fetch: (url, {propName}) => {
        if (propName !== 'data') return Promise.resolve(null);
        const [, z, x, y] = /synthetic:\/\/(\d+)\/(\d+)\/(\d+)/.exec(url);
        return Promise.resolve(makeSyntheticMvtFeatures(Number(z), Number(x), Number(y)));
      },
      getFillColor: [30, 200, 120, 140],
      getLineColor: [10, 120, 60, 255],
      getPointRadius: 6,
      pointRadiusMinPixels: 4,
      pickable: true,
      autoHighlight: true,
      highlightColor: [255, 255, 0, 150]
    })
  ];
}

// Task 3 (Phase 4 plan) verification: a CARTESIAN-positioned mesh, positioned app-side via the
// CRS's own forward transform (+ Phase 1's common-space normalization, `lngLatToCommon` —
// equivalently `viewport.projectFlat`). No new deck.gl code is involved; this proves the
// existing pitch/bearing camera math already renders such a mesh correctly in a CRS view
// (Decisions for review #4), matching Fathom's planned mesh-bathymetry rendering convention.
const UTM18N_NORMALIZED = normalizeCRS(UTM18N);
// `lngLatToCommon` returns common-space units on the "world size" scale (the whole CRS extent
// spans roughly 0-512 units, zoom-independent — the same convention Web Mercator's world tile
// uses), NOT raw meters. The mesh geometry's own local vertex coordinates are in that same
// common-space unit system (CARTESIAN, unscaled) — a radius of a few units is a reasonably
// sized, visible feature at the zone-wide view this demo defaults to.
const PITCH_MESH_GEOMETRY = new SphereGeometry({radius: 4, nlat: 12, nlong: 12});
const PITCH_MESH_POINTS = [
  {lnglat: [-72, 40], elevation: 300},
  {lnglat: [-72.05, 40.05], elevation: 900},
  {lnglat: [-71.95, 39.95], elevation: 600}
];

function makePitchMeshLayer() {
  return new SimpleMeshLayer({
    id: 'pitch-mesh-demo',
    data: PITCH_MESH_POINTS,
    mesh: PITCH_MESH_GEOMETRY,
    coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
    getPosition: d => {
      const [x, y] = lngLatToCommon(UTM18N_NORMALIZED, d.lnglat);
      return [x, y, d.elevation];
    },
    getColor: [255, 100, 40]
  });
}

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
  const [utmBasemap, setUtmBasemap] = useState('osm'); // 'grid' | 'osm' | 'esri' | 'terrain' | 'mvt'
  const [showPitchMesh, setShowPitchMesh] = useState(false);

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
      } else if (utmBasemap === 'terrain') {
        // Task 4 verification (Phase 4 plan): CRS-native tiled TerrainLayer, tileMatrixSet
        // forwarded to _CRSTileset2D (Task 2's fix).
        tileLayers.push(
          new TerrainLayer({
            id: 'utm-terrain',
            // Placeholder template: never fetched over the network, see `fetch` override below.
            elevationData: 'synthetic://{z}/{x}/{y}',
            tileMatrixSet: UTM_TMS,
            fetch: (_url, {propName, loadOptions}) =>
              propName === 'elevationData'
                ? Promise.resolve(makeSyntheticTerrainMesh(loadOptions.terrain.bounds))
                : Promise.resolve(null),
            wireframe: true,
            color: [220, 40, 140]
          })
        );
      } else if (utmBasemap === 'mvt') {
        tileLayers.push(...makeUtmMvtLayers());
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
    ...(crsName === 'UTM 18N' && showPitchMesh ? [makePitchMeshLayer()] : []),
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
            <option value="terrain">TerrainLayer (CRS-native)</option>
            <option value="mvt">MVTLayer (CRS-native)</option>
          </select>
        )}
        {crsName === 'UTM 18N' && (
          <label style={{marginLeft: 8}}>
            <input
              type="checkbox"
              checked={showPitchMesh}
              onChange={e => setShowPitchMesh(e.target.checked)}
            />
            pitch mesh (CARTESIAN)
          </label>
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
