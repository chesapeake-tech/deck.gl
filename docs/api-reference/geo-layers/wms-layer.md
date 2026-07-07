# WMSLayer (Experimental)

<p class="badges">
  <img src="https://img.shields.io/badge/from-v8.9-green.svg?style=flat-square" alt="from v8.9" />
</p>

import {WMSLayerDemo} from '@site/src/doc-demos/geo-layers';

<WMSLayerDemo />

> This class is experimental, which means it does not provide the compatibility and stability that one would typically expect from other layers, detailed in the [limitations](#limitations) section. Use with caution and report any issues that you find on GitHub.


The `WMSLayer` is a composite layer that connects with an image service that can render map images optimized for the current view. Instead of loading a detailed map image covering the entire globe, an image is rendered.

In contrast to the [TileLayer](./tile-layer.md) which loads many small image tiles, the `WMSLayer` loads a single image that covers the entire viewport in one single request, and updates the image by performing additional requests when the viewport changes.

To use this layer, an *image source* must be specified. Image sources are specified by supplying a URL to the `WMSLayer` `data` property. See the section on image sources below for mor information.


import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs groupId="language">
  <TabItem value="js" label="JavaScript">

```js
import {Deck} from '@deck.gl/core';
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';

const layer = new WMSLayer({
  data: 'https://ows.terrestris.de/osm/service',
  serviceType: 'wms',
  layers: ['OSM-WMS']
});

new Deck({
  initialViewState: {
    longitude: -122.4,
    latitude: 37.74,
    zoom: 9
  },
  controller: true,
  layers: [layer]
});
```

  </TabItem>
  <TabItem value="ts" label="TypeScript">

```ts
import {Deck} from '@deck.gl/core';
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';

const layer = new WMSLayer({
  data: 'https://ows.terrestris.de/osm/service',
  serviceType: 'wms',
  layers: ['OSM-WMS']
});

new Deck({
  initialViewState: {
    longitude: -122.4,
    latitude: 37.74,
    zoom: 9
  },
  controller: true,
  layers: [layer]
});
```

  </TabItem>
  <TabItem value="react" label="React">

```tsx
import React from 'react';
import {DeckGL} from '@deck.gl/react';
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';

function App() {
  const layer = new WMSLayer({
    data: 'https://ows.terrestris.de/osm/service',
    serviceType: 'wms',
    layers: ['OSM-WMS']
  });

  return <DeckGL
    initialViewState={{
      longitude: -122.4,
      latitude: 37.74,
      zoom: 9
    }}
    controller
    layers={[layer]}
  />;
}
```

  </TabItem>
</Tabs>


## Installation

To install the dependencies from NPM:

```bash
npm install deck.gl
# or
npm install @deck.gl/core @deck.gl/layers @deck.gl/geo-layers
```

```ts
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';
import type {WMSLayerProps} from '@deck.gl/geo-layers';

new WMSLayer(...props: WMSLayerProps[]);
```

To use pre-bundled scripts:

```html
<script src="https://unpkg.com/deck.gl@^9.0.0/dist.min.js"></script>
<!-- or -->
<script src="https://unpkg.com/@deck.gl/core@^9.0.0/dist.min.js"></script>
<script src="https://unpkg.com/@deck.gl/layers@^9.0.0/dist.min.js"></script>
<script src="https://unpkg.com/@deck.gl/geo-layers@^9.0.0/dist.min.js"></script>
```

```js
new deck._WMSLayer({});
```

## Image Sources

The `WMSLayer` needs a URL to an image source from which it can start loading map images. The `WMSLayer` knows how to build URLs for geospatial image services such as WMS. 

However, it is also possible to connect the WMSLayer to any other REST based service that can render map images from a set of web mercator bounds and a given pixel resolution (perhaps an ArcGIS image server) by specify a custom URL template.

Note that additional features, such as metadata loading, is only supported for known image services, which currently only includes WMS.

### Layers

Image servers such as WMS can render different layers. Typically as list of layers **must** be specified, otherwise requests for map images will fail. For WMS services, this is controlled by [layers](#layers). For other services, layers (if required by that service) can be specified in the template URL, either as a parameter or as a hard-coded part of the template string. 

### Image Service Metadata

Image services like WMS can often provide metadata (aka capabilities) about the service, listing;
- attribution information, 
- available layers
- additional capabilities (pixel/neighborhood queries, legend generation etc). 

The `WMSLayer` will automatically attempt to query metadata for known service types (currently WMS). 

Template URLs only cover image requests and there is no support for providing a custom URL for the metadata queries. This needs to be handled by the application for non-WMS services.

### Interactivity

WMS services sometimes provide a mechanism to query a specific pixel. This is supported through the `getFeatureInfoText()` method on the `WMSLayer`

### Rendering in a non-Mercator CRS view

WMS is a best-case citizen for a [CRS view](../core/map-view.md#crs) (`MapView({crs})`): `GetMap` accepts an arbitrary `CRS`/`SRS` parameter and a bounding box expressed in that CRS's own units, with the *server* doing the reprojection. This lets the layer position the returned image as a single exact rectangle, rather than approximating it in longitude/latitude — the same principle Phase 2/3 use to position tile and mesh content exactly in a CRS view (see [`tileMatrixSet`](./tile-layer.md#tilematrixset)).

```js
import {Deck} from '@deck.gl/core';
import {_WMSLayer as WMSLayer} from '@deck.gl/geo-layers';

const layer = new WMSLayer({
  data: 'https://example.com/wms',
  serviceType: 'wms',
  layers: ['my-layer'],
  // srs: 'auto' (the default) also works here - it resolves to the view's crs.code
  srs: 'EPSG:32618'
});

// rendered with a view in the same CRS:
// new MapView({crs: 'EPSG:32618'}) // UTM zone 18N
```

When [`srs`](#srs) matches the view's `crs.code`, the layer:
1. Computes the visible bounds directly in CRS units from the viewport's common-space corners (un-normalizing them through the CRS's extent offset and unit scale), rather than round-tripping every corner through the CRS's forward/inverse projection formulas — this avoids extra floating-point rounding from transcendental terms (e.g. UTM's trig/log expressions) and is both more exact and cheaper than projecting `getBounds()`'s LNGLAT corners back into CRS units.
2. Requests that bbox from the WMS server with `crs`/`CRS` set to `srs`.
3. Positions the returned image as an exact CRS-unit rectangle in deck's common space, using `COORDINATE_SYSTEM.CARTESIAN` and the same extent-offset normalization as `boundsCommon` (see [`tileMatrixSet`](./tile-layer.md#tilematrixset)).

**WMS 1.1.1 vs. 1.3.0 axis order:** WMS 1.3.0 uses the CRS authority's defined axis order for the bbox, which for most projected CRSs (UTM zones, Web Mercator, etc.) is still `x,y` (easting, northing) — the same order as 1.1.1 — but for geographic CRSs like `EPSG:4326` is `lat,lon`. This layer relies on `@loaders.gl/wms`'s `WMSSource`, which already flips the bbox coordinate order for `'EPSG:4326'` under 1.3.0 (unless `substituteCRS84` is used); this layer does not duplicate or override that logic. Because CRS views in deck.gl are intended for **projected** CRSs, this is sufficient for the layer's CRS-view codepath. If you configure a CRS view with a *geographic* CRS other than `EPSG:4326` (e.g. `EPSG:4269`), be aware `@loaders.gl/wms` does not flip its bbox axis order under WMS 1.3.0 — check your service's actual axis order before relying on `srs` auto-matching in that case.

## Methods

#### `getFeatureInfoText` {#getfeatureinfotext}

This is a method on the layer that can be called to retrieve additional information from the image service about the map near the specified pixel.

Arguments:

- `x` (number) - The x component of the pixel in the image
- `y` (number) - The y component of the pixel in the image

Returns

- `Promise<string>` - Resolves to a string containing additional information about the map around the provided pixel


## Properties

Inherits all properties from [base `Layer`](../core/layer.md).

### Data Options

#### `data` (string) {#data}

A base URL to a well-known service type, or a full URL template from which the map images should be loaded.

If [serviceType](#servicetype) is set to `'template'`, data is expected to be a URL template. The template may contain the following substrings, which will be replaced with a viewport's actual bounds and size at request time:

- `{east}`
- `{north}`
- `{west}`
- `{south}`
- `{width}`
- `{height}`
- `{layers}` - replaced with a string built from the content of [layers](#layers). The array of layer name strings will be joined by commas (`,`) into a single string.


#### `serviceType` (string, optional) {#servicetype}

- Default: `'auto'`

Specifies the type of service at the URL supplied in `data`. Currently accepts either `'wms'` or `'template'`. The default `'auto'` setting will try to autodetect service from the URL.

#### `layers` (string\[\], optional) {#layers}

- Default: `[]`

Specifies names of layers that should be visualized from the image service. 

> Note that WMS services will typically not display anything unless at least one valid layer name is provided.

#### `srs` (string, optional) {#srs}

- Default: `'auto'`

Spatial Reference System for map output, used to query the image from the server (the WMS `CRS`/`SRS` `GetMap` parameter). Accepts any CRS code the WMS service advertises in its `GetCapabilities` (this is not validated by the layer) — commonly `'EPSG:4326'` or `'EPSG:3857'`, but also e.g. a UTM zone code such as `'EPSG:32618'` when rendering into a matching [CRS view](#rendering-in-a-non-mercator-crs-view).

If `'auto'`:
- Outside a CRS view, the layer requests `'EPSG:3857'` in `MapView`, and `'EPSG:4326'` otherwise (unchanged from previous releases).
- Inside a [CRS view](#rendering-in-a-non-mercator-crs-view) (`MapView({crs})`), the layer requests the view's own `crs.code`.

In a CRS view, `srs` should match the view's `crs.code`. The layer positions the returned image as an exact rectangle in the view's CRS, so a mismatch means the WMS server projects the image into a *different* CRS than the one the view renders, which the layer cannot position exactly.

When a mismatch is detected, the layer falls back to a request bbox in lnglat degrees (the same `viewport.getBounds()`-based approach used outside a CRS view) — this only produces a request the WMS server can correctly interpret when the mismatched `srs` is itself `'EPSG:4326'` (degrees) or `'EPSG:3857'` (converted to pseudo-Mercator meters); for either of those two codes, a warning is logged once and the image is positioned via its (approximate) LNGLAT bounds. For any *other* mismatched `srs` (e.g. a different UTM zone than the view's own), the fallback bbox is still built in lnglat degrees but sent tagged with that unrelated `srs` code — most WMS servers will reject or misinterpret this combination — so a distinct warning is logged instead, naming the srs as unsupported. The layer does not silently substitute a different `srs` value in the request, since that could break servers expecting the explicitly declared `srs`/`crs` back from `GetCapabilities`.


### Callbacks

#### `onMetadataLoad` (Function, optional) {#onmetadataload}

`onMetadataLoad` called when the metadata of the image source successfully loads.

- Default: `metadata => {}`

Receives arguments:

- `metadata` (object) - The metadata for the image services has been loaded. 

Note that metadata will not be loaded when [serviceType](#servicetype) is set to `'template`.

#### `onMetadataLoadError` (Function, optional) {#onmetadataloaderror}

`onMetadataLoadError` called when metadata failed to load.

- Default: `console.error`

Receives arguments:

- `error` (`Error`)

#### `onImageLoadStart` (Function, optional) {#onimageloadstart}

`onImageLoadStart` is a function that is called when the `WMSLayer` starts loading metadata after a new image source has been specified.

- Default: `data => null`

Receives arguments:

- `requestId` (`number`) - Allows tracking of specific requests

#### `onImageLoad` (Function, optional) {#onimageload}

`onImageLoad` called when an image successfully loads.

- Default: `() => {}`

Receives arguments:

- `requestId` (`number`) - Allows tracking of specific requests

#### `onImageLoadError` (Function, optional) {#onimageloaderror}

`onImageLoadError` called when an image failed to load.

- Default: `console.error`

Receives arguments:

- `requestId` (`number`) - Allows tracking of specific requests
- `error` (`Error`)

## Limitations

- Each instance of the `WMSLayer` only supports being rendered in one view. See [rendering layers in multiple views](../../developer-guide/views.md#rendering-layers-in-multiple-views) for a workaround.
- This layer currently does not work well with perspective views (i.e. `pitch>0`).
- This layer does not work with non-geospatial views such as the [OrthographicView](../core/orthographic-view.md) or the [OrbitView](../core/orbit-view.md).
- In a [CRS view](#rendering-in-a-non-mercator-crs-view), exact positioning only applies when [`srs`](#srs) matches the view's `crs.code`; a mismatched `srs` falls back to the pre-existing LNGLAT-bounds approximation.

## Source

[modules/geo-layers/src/wms-layer](https://github.com/visgl/deck.gl/tree/master/modules/geo-layers/src/wms-layer)
