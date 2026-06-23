import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listCharacters,
  listUserCharacters,
  importCharacterFromPath,
  userCharactersDir
} from '../../src/mascot/character-store.js';
import {
  handleListMascotCharacters,
  handleSetMascotCharacter,
  handleImportMascotCharacter
} from '../../src/routes/mascot-route.js';
import mascotStateBus from '../../src/mascot/state-bus.js';

function jsonRes() {
  return {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

function makeSourcePack(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'mascot-src-'));
  writeFileSync(join(dir, 'character.json'), JSON.stringify(manifest));
  return dir;
}

test('listCharacters always includes the built-in placeholder', () => {
  const chars = listCharacters();
  const placeholder = chars.find((c) => c.id === 'placeholder');
  assert.ok(placeholder, 'placeholder present');
  assert.equal(placeholder.source, 'builtin');
  assert.equal(placeholder.renderer, 'placeholder');
});

test('importCharacterFromPath copies a pack into the user dir and it gets listed', () => {
  const src = makeSourcePack({ id: 'aria', name: 'Aria', renderer: 'live2d', thumbnail: 'thumb.png' });
  const entry = importCharacterFromPath(src);
  assert.equal(entry.id, 'aria');
  assert.equal(entry.renderer, 'live2d');
  assert.equal(entry.source, 'user');
  assert.equal(entry.baseUrl, '/mascot-characters/aria');
  assert.equal(entry.thumbnail, '/mascot-characters/aria/thumb.png');

  assert.ok(listUserCharacters().some((c) => c.id === 'aria'));
  assert.ok(userCharactersDir().endsWith('mascot-characters'));
  rmSync(src, { recursive: true, force: true });
});

test('importCharacterFromPath rejects bad source / unknown renderer falls back', () => {
  assert.throws(() => importCharacterFromPath('/no/such/dir'), /existing directory/);

  const noManifest = mkdtempSync(join(tmpdir(), 'mascot-empty-'));
  assert.throws(() => importCharacterFromPath(noManifest), /character\.json/);
  rmSync(noManifest, { recursive: true, force: true });

  const weird = makeSourcePack({ id: 'weird', renderer: 'hologram' });
  const entry = importCharacterFromPath(weird);
  assert.equal(entry.renderer, 'placeholder', 'unknown renderer coerced to placeholder');
  rmSync(weird, { recursive: true, force: true });
});

test('importCharacterFromPath refuses to collide with a built-in id', () => {
  const clash = makeSourcePack({ id: 'placeholder', name: 'Fake' });
  assert.throws(() => importCharacterFromPath(clash), /collides with a built-in/);
  rmSync(clash, { recursive: true, force: true });
});

test('route: list characters reports active + the catalogue', () => {
  const res = jsonRes();
  handleListMascotCharacters({}, res);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.characters));
  assert.ok(res.body.characters.some((c) => c.id === 'placeholder'));
  assert.ok(typeof res.body.active === 'string');
});

test('route: set character validates + broadcasts a reload', () => {
  const src = makeSourcePack({ id: 'switchme', name: 'Switch', renderer: 'lottie' });
  importCharacterFromPath(src);

  const missing = jsonRes();
  handleSetMascotCharacter({ body: {} }, missing);
  assert.equal(missing.statusCode, 400);

  const unknown = jsonRes();
  handleSetMascotCharacter({ body: { character: 'ghost' } }, unknown);
  assert.equal(unknown.statusCode, 404);

  let reloaded = false;
  const off = mascotStateBus.subscribeReload(() => { reloaded = true; });
  const ok = jsonRes();
  handleSetMascotCharacter({ body: { character: 'switchme' } }, ok);
  off();
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.config.character, 'switchme');
  assert.equal(reloaded, true, 'switching broadcasts a reload directive');
  rmSync(src, { recursive: true, force: true });
});

test('route: import character validates path', () => {
  const missing = jsonRes();
  handleImportMascotCharacter({ body: {} }, missing);
  assert.equal(missing.statusCode, 400);

  const src = makeSourcePack({ id: 'routeimport', name: 'RI', renderer: 'sprite' });
  const ok = jsonRes();
  handleImportMascotCharacter({ body: { path: src } }, ok);
  assert.equal(ok.body.success, true);
  assert.equal(ok.body.character.id, 'routeimport');
  rmSync(src, { recursive: true, force: true });
});
