import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  handleGetMascotConfig,
  handleUpdateMascotConfig,
  handleGetMascotState,
  handleSetMascotState,
  handleMascotEvents
} from '../../src/routes/mascot-route.js';
import mascotStateBus from '../../src/mascot/state-bus.js';
import { setServerSettings } from '../../src/server-settings.js';

function jsonRes() {
  return {
    statusCode: 200,
    setHeader() {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; }
  };
}

function resetMascotConfig() {
  setServerSettings({ mascot: { enabled: true, character: 'placeholder', clickAction: 'open-chat', position: null } });
}

test('config GET returns defaults, PUT persists changes', () => {
  resetMascotConfig();

  const get1 = jsonRes();
  handleGetMascotConfig({}, get1);
  assert.equal(get1.body.success, true);
  assert.equal(get1.body.config.enabled, true);
  assert.equal(get1.body.config.character, 'placeholder');

  const put = jsonRes();
  handleUpdateMascotConfig({ body: { enabled: false, character: 'aria', position: { x: 100, y: 200 } } }, put);
  assert.equal(put.body.config.enabled, false);
  assert.equal(put.body.config.character, 'aria');
  assert.deepEqual(put.body.config.position, { x: 100, y: 200 });

  const get2 = jsonRes();
  handleGetMascotConfig({}, get2);
  assert.equal(get2.body.config.enabled, false);
  assert.equal(get2.body.config.character, 'aria');
});

test('config PUT ignores a malformed position', () => {
  resetMascotConfig();

  const initial = jsonRes();
  handleUpdateMascotConfig({ body: { position: { x: 100, y: 200 } } }, initial);

  const put = jsonRes();
  handleUpdateMascotConfig({ body: { position: { x: 'nope' } } }, put);
  assert.deepEqual(put.body.config.position, { x: 100, y: 200 });
});

test('state GET/POST round-trip; bad state → 400', () => {
  const set = jsonRes();
  handleSetMascotState({ body: { state: 'thinking', text: 'hmm' } }, set);
  assert.equal(set.body.success, true);
  assert.equal(set.body.state, 'thinking');

  const get = jsonRes();
  handleGetMascotState({}, get);
  assert.equal(get.body.state, 'thinking');
  assert.equal(get.body.text, 'hmm');

  const bad = jsonRes();
  handleSetMascotState({ body: { state: 'dancing' } }, bad);
  assert.equal(bad.statusCode, 400);
});

test('events SSE primes with current state, streams changes, cleans up on close', () => {
  mascotStateBus.setState('idle');
  const writes = [];
  const res = { setHeader() {}, flushHeaders() {}, write(c) { writes.push(String(c)); return true; } };
  const req = new EventEmitter();

  handleMascotEvents(req, res);
  assert.ok(writes.some((w) => w.includes('"state":"idle"')), 'primes with current state');

  const before = mascotStateBus.listenerCount('state');
  mascotStateBus.setState('talking', { text: 'hi' });
  assert.ok(writes.some((w) => w.includes('talking')), 'streams new state');

  req.emit('close');
  assert.equal(mascotStateBus.listenerCount('state'), before - 1, 'unsubscribed on close');
});
