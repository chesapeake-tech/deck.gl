// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/* eslint-disable no-console, no-process-exit */
// Driver for the CRS WebGPU smoke test (see ./app.js).
//
// WebGPU needs a real GPU, so this launches HEADED Chromium via Playwright
// (Metal-backed on macOS), serves the app with Vite (using the repo-local
// aliases so @deck.gl/* resolves to modules/*/src), renders the scene on both
// a WebGL2 and a WebGPU device, and cross-checks:
//   1. no device/pipeline/WGSL-compile errors (deck onError + console errors)
//   2. every marker rendered (pixel count > 0) on both devices
//   3. marker centroid matches the CPU CRSViewport.project position
//   4. WebGL vs WebGPU centroids agree to (sub)pixel level
//
// Pixel readback uses Playwright page screenshots (deviceScaleFactor 1, clipped
// to the canvas): Chrome returns transparent black when drawing a presented
// WebGPU canvas into a 2D context, so in-page readback is not an option.
//
// Usage: node test/apps/crs-webgpu-smoke/run-smoke.mjs

import {createServer} from 'vite';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {fileURLToPath} from 'url';
import {dirname, join} from 'path';

const appDir = dirname(fileURLToPath(import.meta.url));

// GL-vs-WebGPU agreement: same math on both devices, expect (sub)pixel.
const CROSS_DEVICE_TOLERANCE_PX = 1.5;
// GPU-vs-CPU: LNGLAT has the Hessian correction (cubic error). The offset
// branches are first-order (linear Jacobian), so allow a slightly larger
// linearization error at ~9km from the origin (still ~1px at 41 m/px).
const CPU_TOLERANCE_PX = {lnglat: 2, 'meter-offsets': 3, 'lnglat-offsets': 3};
const MIN_PIXELS = 200; // a 14px-radius disc is ~600px; require a solid blob
const CANVAS = {x: 0, y: 0, width: 800, height: 600};

/** Pixel centroid + count of all pixels matching a color (channel tolerance) */
function findColor(png, [r, g, b], tolerance = 48) {
  const {data, width, height} = png;
  let count = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (
        Math.abs(data[i] - r) < tolerance &&
        Math.abs(data[i + 1] - g) < tolerance &&
        Math.abs(data[i + 2] - b) < tolerance
      ) {
        count++;
        sx += x;
        sy += y;
      }
    }
  }
  return count ? {x: sx / count + 0.5, y: sy / count + 0.5, count} : {x: NaN, y: NaN, count: 0};
}

async function main() {
  const server = await createServer({
    configFile: join(appDir, '..', 'vite.config.local.mjs'),
    root: appDir,
    server: {open: false, port: 8917, strictPort: true},
    logLevel: 'warn'
  });
  await server.listen();
  const url = `http://localhost:${server.config.server.port}/`;

  const browser = await chromium.launch({
    headless: false, // WebGPU needs a real (Metal) GPU on macOS
    args: ['--enable-unsafe-webgpu']
  });
  const page = await browser.newPage({
    viewport: {width: 900, height: 650},
    deviceScaleFactor: 1 // 1:1 CSS px to screenshot px for centroid math
  });

  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      const text = msg.text();
      // Surface anything that smells like a shader/pipeline/device failure
      if (/error|tint|wgsl|pipeline|validation|uncaptured|not supported/i.test(text)) {
        consoleErrors.push(`[console.${msg.type()}] ${text.slice(0, 500)}`);
      }
    }
  });
  page.on('pageerror', error => consoleErrors.push(`[pageerror] ${error.message}`));

  const failures = [];
  try {
    await page.goto(url, {waitUntil: 'load'});
    await page.waitForFunction(() => Boolean(window.__crsSmoke), {timeout: 30000});

    const gpu = await page.evaluate(() => window.__crsSmoke.hasWebGPU());
    console.log('WebGPU adapter:', JSON.stringify(gpu));
    if (!gpu.available) {
      throw new Error('navigator.gpu unavailable or no adapter — cannot run WebGPU smoke test');
    }
    if (/swiftshader|software/i.test(`${gpu.vendor} ${gpu.architecture} ${gpu.description}`)) {
      throw new Error(`WebGPU adapter appears to be a software renderer: ${JSON.stringify(gpu)}`);
    }

    const results = {};
    for (const type of ['webgl', 'webgpu']) {
      const scene = await page.evaluate(t => window.__crsSmoke.run(t), type);
      console.log(`\n=== ${type} ===`);
      console.log('device:', JSON.stringify(scene.deviceInfo));
      if (scene.fatal) {
        failures.push(`${type}: fatal: ${scene.fatal}`);
        continue;
      }
      if (scene.errors.length) {
        failures.push(`${type}: deck onError: ${scene.errors.join(' | ')}`);
      }
      if (scene.renderCount < 2) {
        failures.push(`${type}: never rendered (renderCount=${scene.renderCount})`);
        continue;
      }

      const png = PNG.sync.read(await page.screenshot({clip: CANVAS}));
      const markers = {};
      for (const [name, m] of Object.entries(scene.markers)) {
        const found = findColor(png, m.color);
        const cpuDelta =
          found.count > 0 ? Math.hypot(found.x - m.expected[0], found.y - m.expected[1]) : null;
        markers[name] = {...m, found, cpuDelta};
        console.log(
          `${name.padEnd(6)} (${m.kind.padEnd(14)}) expected=[${m.expected.map(v => v.toFixed(1))}] ` +
            `actual=[${found.x.toFixed(1)},${found.y.toFixed(1)}] pixels=${found.count} ` +
            `cpuDelta=${cpuDelta === null ? 'n/a' : cpuDelta.toFixed(2)}px`
        );
        if (found.count < MIN_PIXELS) {
          failures.push(`${type}/${name}: marker not rendered (pixels=${found.count})`);
        } else if (cpuDelta > CPU_TOLERANCE_PX[m.kind]) {
          failures.push(
            `${type}/${name}: GPU position off CPU projection by ${cpuDelta.toFixed(2)}px ` +
              `(tolerance ${CPU_TOLERANCE_PX[m.kind]}px)`
          );
        }
      }
      results[type] = markers;
    }

    // Cross-device comparison — the strongest check: identical scene, identical
    // math, different shading language + uniform layout.
    if (results.webgl && results.webgpu) {
      console.log('\n=== WebGL vs WebGPU ===');
      for (const name of Object.keys(results.webgl)) {
        const a = results.webgl[name].found;
        const b = results.webgpu[name].found;
        if (a.count < MIN_PIXELS || b.count < MIN_PIXELS) {
          continue; // already reported above
        }
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        console.log(`${name.padEnd(6)} delta=${d.toFixed(3)}px`);
        if (d > CROSS_DEVICE_TOLERANCE_PX) {
          failures.push(
            `${name}: WebGL/WebGPU positions differ by ${d.toFixed(2)}px (tolerance ${CROSS_DEVICE_TOLERANCE_PX}px)`
          );
        }
      }
    }

    if (consoleErrors.length) {
      console.log('\nConsole errors/warnings:');
      for (const e of consoleErrors) {
        console.log(' ', e);
      }
      failures.push(...consoleErrors.filter(e => /wgsl|tint|pipeline|validation/i.test(e)));
    }
  } catch (error) {
    failures.push(`driver: ${error.stack || error}`);
  } finally {
    await browser.close();
    await server.close();
  }

  if (failures.length) {
    console.error('\nFAIL');
    for (const f of failures) {
      console.error(' -', f);
    }
    process.exit(1);
  }
  console.log('\nPASS: CRS projection mode renders correctly on WebGPU (matches WebGL + CPU)');
}

main();
