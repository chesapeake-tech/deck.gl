// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Proj4Projection} from '@math.gl/proj4';
import type {CRSDefinition} from '@deck.gl/core/viewports/crs-utils';

// UTM zone 18N. Anchor is definitional: central meridian -75deg at the equator
// maps to easting 500000, northing 0.
const utm18nProjection = new Proj4Projection({
  from: 'WGS84',
  to: '+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs'
});
export const UTM18N: CRSDefinition = {
  code: 'EPSG:32618',
  transform: {
    forward: lnglat => utm18nProjection.project(lnglat) as [number, number],
    inverse: xy => utm18nProjection.unproject(xy) as [number, number]
  },
  extent: [166021.44, 0, 833978.56, 9329005.18],
  units: 'meters'
};
