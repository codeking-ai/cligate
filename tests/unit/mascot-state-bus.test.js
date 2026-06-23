import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MascotStateBus, MASCOT_STATES } from '../../src/mascot/state-bus.js';

test('defaults to idle', () => {
  const bus = new MascotStateBus();
  assert.equal(bus.getState().state, 'idle');
  assert.equal(bus.getState().text, '');
});

test('setState updates state + text and emits to subscribers', () => {
  const bus = new MascotStateBus();
  const seen = [];
  const unsubscribe = bus.subscribe((s) => seen.push(s.state));
  bus.setState('thinking');
  bus.setState('talking', { text: 'hi there' });
  assert.equal(bus.getState().state, 'talking');
  assert.equal(bus.getState().text, 'hi there');
  assert.deepEqual(seen, ['thinking', 'talking']);
  unsubscribe();
  bus.setState('idle');
  assert.deepEqual(seen, ['thinking', 'talking'], 'no events after unsubscribe');
});

test('unknown state is coerced to idle', () => {
  const bus = new MascotStateBus();
  bus.setState('dancing');
  assert.equal(bus.getState().state, 'idle');
});

test('all advertised states are accepted verbatim', () => {
  const bus = new MascotStateBus();
  for (const s of MASCOT_STATES) {
    bus.setState(s);
    assert.equal(bus.getState().state, s);
  }
});

test('getState returns a copy (callers cannot mutate internal state)', () => {
  const bus = new MascotStateBus();
  const snap = bus.getState();
  snap.state = 'hacked';
  assert.equal(bus.getState().state, 'idle');
});
