#!/usr/bin/env node
// Download the Whisper-tiny ONNX model that the in-browser voice fallback uses
// and place it under public/models/ so it ships INSIDE the packaged app and is
// served locally at /models/ — no runtime fetch from huggingface.co / a CDN.
//
// Default source is ModelScope's mirror of the transformers.js ONNX repo
// (Xenova/whisper-tiny), which is reachable where huggingface.co is blocked.
// Override with CLIGATE_STT_MODEL_BASE_URL (e.g. an hf-mirror.com resolve URL),
// or just drop the files into public/models/Xenova/whisper-tiny/ by hand — this
// script skips files that already exist (use --force to re-download).
//
// Run before packaging:  node scripts/fetch-whisper-model.mjs
// (wired into `npm run electron:build`). See docs/voice-recognition-design.zh-CN.md.

import { mkdir, stat, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_ID = 'Xenova/whisper-tiny';
const DEFAULT_BASE = 'https://www.modelscope.cn/models/Xenova/whisper-tiny/resolve/master';
const BASE = (process.env.CLIGATE_STT_MODEL_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
const FORCE = process.argv.includes('--force');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'public', 'models', MODEL_ID);

// `required` files must all be present for the bundle to work; the rest are
// best-effort extras the tokenizer/feature-extractor may reference. The two
// ONNX files match the frontend's `dtype: 'q8'` (→ *_quantized.onnx).
const FILES = [
  { path: 'config.json', required: true },
  { path: 'generation_config.json', required: true },
  { path: 'preprocessor_config.json', required: true },
  { path: 'tokenizer.json', required: true },
  { path: 'tokenizer_config.json', required: true },
  { path: 'special_tokens_map.json', required: false },
  { path: 'added_tokens.json', required: false },
  { path: 'normalizer.json', required: false },
  { path: 'merges.txt', required: false },
  { path: 'vocab.json', required: false },
  // Whisper in transformers.js uses the encoder + the MERGED decoder (with-past
  // built in); the separate decoder/with-past variants are not loaded, so we do
  // not bundle them (keeps the app ~57MB smaller).
  { path: 'onnx/encoder_model_quantized.onnx', required: true },
  { path: 'onnx/decoder_model_merged_quantized.onnx', required: true }
];

async function fileSize(p) {
  try { return (await stat(p)).size; } catch { return -1; }
}

async function download(url, dest, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      await mkdir(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      const size = await fileSize(dest);
      if (size <= 0) throw new Error('empty file');
      return size;
    } catch (error) {
      await rm(dest, { force: true }).catch(() => {});
      if (attempt === attempts) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  console.log(`[stt-model] source: ${BASE}`);
  console.log(`[stt-model] target: ${OUT_DIR}`);
  const missingRequired = [];
  let downloaded = 0;
  let skipped = 0;

  for (const file of FILES) {
    const dest = path.join(OUT_DIR, file.path);
    if (!FORCE && (await fileSize(dest)) > 0) {
      skipped++;
      continue;
    }
    const url = `${BASE}/${file.path}`;
    try {
      const size = await download(url, dest);
      downloaded++;
      console.log(`[stt-model]  ✓ ${file.path} (${human(size)})`);
    } catch (error) {
      console.warn(`[stt-model]  ✗ ${file.path} — ${String(error?.message || error)}`);
      if (file.required) missingRequired.push(file.path);
    }
  }

  console.log(`[stt-model] done: ${downloaded} downloaded, ${skipped} already present.`);
  if (missingRequired.length > 0) {
    console.error(`\n[stt-model] FAILED — missing required files:\n  - ${missingRequired.join('\n  - ')}`);
    console.error('[stt-model] Fix: ensure the source is reachable, set CLIGATE_STT_MODEL_BASE_URL to a mirror,');
    console.error('[stt-model] or download those files manually into public/models/Xenova/whisper-tiny/.');
    process.exit(1);
  }
  console.log('[stt-model] OK — model is bundled; the app will transcribe offline with no HF/CDN fetch.');
}

main().catch((error) => {
  console.error('[stt-model] unexpected error:', error);
  process.exit(1);
});
