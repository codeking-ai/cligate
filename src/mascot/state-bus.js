/**
 * Desktop-mascot state bus.
 *
 * A single, tiny pub/sub for the assistant's "mood": the various places that
 * know what the assistant is doing (chat streaming, the ReAct engine, scheduled
 * tasks, channel confirmations) call setState(); the mascot window subscribes
 * via the /api/mascot/events SSE stream and animates accordingly.
 *
 * Deliberately decoupled and dependency-free so it stays trivially testable and
 * never drags assistant internals into the presentation layer.
 */

import { EventEmitter } from 'node:events';

export const MASCOT_STATES = Object.freeze([
  'idle',       // doing nothing
  'listening',  // user is speaking / typing
  'thinking',   // LLM / tools running
  'talking',    // streaming a reply
  'notify'      // proactive: scheduled task fired, channel confirmation needed, …
]);

function nowIso() {
  return new Date().toISOString();
}

export class MascotStateBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // many SSE subscribers may attach
    this._state = { state: 'idle', text: '', at: nowIso() };
  }

  getState() {
    return { ...this._state };
  }

  /**
   * @param {string} state one of MASCOT_STATES (unknown → coerced to 'idle')
   * @param {{ text?: string }} [opts] optional speech-bubble text
   */
  setState(state, { text = '' } = {}) {
    const next = MASCOT_STATES.includes(state) ? state : 'idle';
    this._state = { state: next, text: String(text || ''), at: nowIso() };
    this.emit('state', this.getState());
    return this.getState();
  }

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.on('state', listener);
    return () => this.off('state', listener);
  }
}

export const mascotStateBus = new MascotStateBus();

export default mascotStateBus;
