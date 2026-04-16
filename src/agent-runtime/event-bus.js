import EventEmitter from 'events';

export class AgentRuntimeEventBus {
  constructor({ recentLimit = 200 } = {}) {
    this.emitter = new EventEmitter();
    this.recentLimit = recentLimit;
    this.recentBySession = new Map();
  }

  publish(event) {
    const sessionId = event?.sessionId;
    if (!sessionId) return;

    const recent = this.recentBySession.get(sessionId) || [];
    recent.push(event);
    if (recent.length > this.recentLimit) {
      recent.splice(0, recent.length - this.recentLimit);
    }
    this.recentBySession.set(sessionId, recent);

    this.emitter.emit(sessionId, event);
    this.emitter.emit('*', event);
  }

  subscribe(sessionId, listener) {
    this.emitter.on(sessionId, listener);
    return () => this.emitter.off(sessionId, listener);
  }

  subscribeAll(listener) {
    this.emitter.on('*', listener);
    return () => this.emitter.off('*', listener);
  }

  getRecentEvents(sessionId, limit = this.recentLimit) {
    const events = this.recentBySession.get(sessionId) || [];
    return events.slice(-Math.max(0, limit));
  }
}

export default AgentRuntimeEventBus;
