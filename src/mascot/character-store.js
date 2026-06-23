/**
 * Mascot character-pack discovery + import.
 *
 * A "character" is a folder with a character.json manifest. Two sources:
 *   - built-in:  public/mascot/characters/<id>/   (served at /mascot/characters/<id>)
 *   - user:      ~/.cligate/mascot-characters/<id>/ (served at /mascot-characters/<id>)
 *
 * Built-ins are hardcoded (robust across Electron asar packaging — the public
 * dir is inside app.asar.unpacked and awkward to scan); the user dir is a plain
 * filesystem dir we scan, so users can drop in / import packs and switch freely.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, cpSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_DIR } from '../account-manager.js';

export const VALID_RENDERERS = Object.freeze(['placeholder', 'live2d', 'lottie', 'sprite']);

// Known built-in packs (their files are served statically from public/).
const BUILTIN = [
  { id: 'placeholder', name: 'Pal', gender: 'neutral', renderer: 'placeholder', source: 'builtin', baseUrl: '/mascot/characters/placeholder', thumbnail: '' }
];

function toText(v) { return String(v ?? '').trim(); }
function isSafeId(id) { return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..'; }

export function userCharactersDir() {
  return path.join(CONFIG_DIR, 'mascot-characters');
}

export function ensureUserCharactersDir() {
  const dir = userCharactersDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readManifest(dir) {
  const file = path.join(dir, 'character.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEntry(manifest, { id, source, baseUrl }) {
  const renderer = VALID_RENDERERS.includes(toText(manifest.renderer)) ? toText(manifest.renderer) : 'placeholder';
  const thumb = toText(manifest.thumbnail);
  return {
    id,
    name: toText(manifest.name) || id,
    gender: toText(manifest.gender) || 'neutral',
    renderer,
    source,
    baseUrl,
    thumbnail: thumb ? `${baseUrl}/${thumb.replace(/^\/+/, '')}` : ''
  };
}

export function listUserCharacters() {
  const dir = ensureUserCharactersDir();
  const out = [];
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!isSafeId(name)) continue;
    const full = path.join(dir, name);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    const manifest = readManifest(full);
    if (!manifest) continue;
    out.push(normalizeEntry(manifest, { id: name, source: 'user', baseUrl: `/mascot-characters/${name}` }));
  }
  return out;
}

export function listCharacters() {
  return [...BUILTIN, ...listUserCharacters()];
}

export function getCharacter(id) {
  const wanted = toText(id);
  return listCharacters().find((c) => c.id === wanted) || null;
}

/**
 * Import a character pack from a local folder (must contain character.json)
 * by copying it into the user characters dir. Returns the imported entry.
 */
export function importCharacterFromPath(sourcePath) {
  const src = toText(sourcePath);
  if (!src || !existsSync(src) || !statSync(src).isDirectory()) {
    throw new Error('source path must be an existing directory');
  }
  const manifest = readManifest(src);
  if (!manifest) {
    throw new Error('the folder must contain a valid character.json');
  }
  const id = toText(manifest.id) || path.basename(src);
  if (!isSafeId(id)) {
    throw new Error('character id must match [A-Za-z0-9._-]');
  }
  if (BUILTIN.some((b) => b.id === id)) {
    throw new Error(`"${id}" collides with a built-in character; rename it in character.json`);
  }
  const dest = path.join(ensureUserCharactersDir(), id);
  cpSync(src, dest, { recursive: true });
  return normalizeEntry(readManifest(dest) || manifest, { id, source: 'user', baseUrl: `/mascot-characters/${id}` });
}

export default {
  VALID_RENDERERS,
  userCharactersDir,
  ensureUserCharactersDir,
  listUserCharacters,
  listCharacters,
  getCharacter,
  importCharacterFromPath
};
