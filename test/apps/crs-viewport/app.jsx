// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* global document */
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import DeckGL from '@deck.gl/react';
import {MapView} from '@deck.gl/core';
import {GeoJsonLayer, PathLayer, ScatterplotLayer} from '@deck.gl/layers';
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

  const layers = [
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
