#!/usr/bin/env node
/**
 * Fetch the (MIT-licensed) Live2D web runtime into public/mascot/vendor/ so the
 * mascot's live2d renderer can load it offline. Mirrors fetch-whisper-model.mjs.
 *
 *   npm run fetch:mascot-runtime
 *
 * This downloads ONLY the open-source pieces:
 *   - pixi.js (MIT)
 *   - pixi-live2d-display cubism4 bundle (MIT)
 *
 * It deliberately does NOT download Live2D Cubism Core — that file is
 * proprietary (Live2D Cubism Core License). As the product owner you must obtain
 * it from Live2D and place it at public/mascot/vendor/live2dcubismcore.min.js,
 * agreeing to Live2D's license. See public/mascot/vendor/README.md.
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'mascot', 'vendor');

const ASSETS = [
  {
    file: 'pixi.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
    license: 'MIT (PixiJS)'
  },
  {
    file: 'pixi-live2d-display.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
    license: 'MIT (pixi-live2d-display)'
  }
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function main() {
  await mkdir(VENDOR_DIR, { recursive: true });
  let ok = 0;
  for (const asset of ASSETS) {
    const dest = join(VENDOR_DIR, asset.file);
    try {
      const res = await fetch(asset.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      console.log(`[mascot-runtime]  ✓ ${asset.file} (${Math.round(buf.length / 1024)} KB) — ${asset.license}`);
      ok += 1;
    } catch (err) {
      console.error(`[mascot-runtime]  ✗ ${asset.file} — ${err.message}`);
    }
  }
  console.log(`[mascot-runtime] done: ${ok}/${ASSETS.length} downloaded into public/mascot/vendor/.`);

  const corePath = join(VENDOR_DIR, 'live2dcubismcore.min.js');
  if (!(await exists(corePath))) {
    console.log('');
    console.log('[mascot-runtime] NOTE: Live2D Cubism Core is NOT downloaded (proprietary).');
    console.log('[mascot-runtime]   Obtain live2dcubismcore.min.js from Live2D under their license and place it at:');
    console.log(`[mascot-runtime]   ${corePath}`);
    console.log('[mascot-runtime]   Until then, the placeholder character is used and Live2D packs fall back gracefully.');
  }

  if (ok < ASSETS.length) process.exitCode = 1;
}

main();
