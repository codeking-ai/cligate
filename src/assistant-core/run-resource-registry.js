import assistantRunStore from './run-store.js';

// Resource-aware concurrency for assistant runs.
//
// Background: every inbound message spawns its own ReAct run, and runs execute
// concurrently (fire-and-forget). That is correct and desirable — the assistant
// must stay responsive and run independent tasks in parallel. The ONLY thing
// that must be serialized is access to a genuinely exclusive *physical* resource
// — first and foremost the single mouse/keyboard/screen that desktop automation
// drives. Two runs driving the desktop at once corrupt each other's UI state.
//
// This registry is a minimal "shared-device sign-out sheet": it tracks which run
// currently holds a resource, lets another run check/claim it, and self-heals
// when a holder dies. It makes NO policy decisions (queue vs ask vs cancel) — the
// supervisor LLM decides that using the truthful state surfaced into its prompt.
// Everything here is fail-open: any internal error is treated as "resource free"
// so a bug in this layer can never wedge an otherwise healthy run.

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_MAX_HOLD_MS = 10 * 60 * 1000; // 10 min — generous for a login/install
const DEFAULT_STALE_HEARTBEAT_MS = 90 * 1000; // holder considered dead if silent this long past max-hold

// The desktop tools that physically grab the mouse/keyboard (or change the
// foreground / launch apps) and therefore must run one-task-at-a-time. Read-only
// tools (health, list_windows, capture_window, inspect_window, find_*, wait_*,
// cursor_info, get_control_text) deliberately stay OUT — they don't move the
// pointer, so they're safe to run while another task holds the desktop.
export const DESKTOP_INPUT_TOOLS = new Set([
  'desktop_click_at',
  'desktop_click_control',
  'desktop_click_text',
  'desktop_hotkey',
  'desktop_press_key',
  'desktop_type_text',
  'desktop_send_control_keys',
  'desktop_fill_text_field',
  'desktop_set_control_value',
  'desktop_move_mouse',
  'desktop_scroll',
  'desktop_launch_app',
  'desktop_focus_window'
]);

export const DESKTOP_RESOURCE = 'desktop';

export class RunResourceRegistry {
  constructor({
    runStore = assistantRunStore,
    maxHoldMs = DEFAULT_MAX_HOLD_MS,
    staleHeartbeatMs = DEFAULT_STALE_HEARTBEAT_MS,
    now = () => Date.now()
  } = {}) {
    this.runStore = runStore;
    this.maxHoldMs = maxHoldMs;
    this.staleHeartbeatMs = staleHeartbeatMs;
    this._now = typeof now === 'function' ? now : () => Date.now();
    // resourceKey -> { holderRunId, info, acquiredAt, lastHeartbeatAt }
    this.resources = new Map();
  }

  // Is the current holder dead/stuck and therefore safe to evict? A holder is
  // reclaimable when its run has reached a terminal state (or vanished), or when
  // it has held the resource past maxHoldMs without a recent heartbeat.
  _isHolderReclaimable(holder, now) {
    if (!holder || !holder.holderRunId) return true;
    let record = null;
    try {
      record = this.runStore?.get?.(holder.holderRunId) || null;
    } catch {
      record = null;
    }
    if (!record) return true;
    if (TERMINAL_RUN_STATUSES.has(String(record.status || '').trim())) return true;
    if ((now - holder.acquiredAt) > this.maxHoldMs
      && (now - holder.lastHeartbeatAt) > this.staleHeartbeatMs) {
      return true;
    }
    return false;
  }

  _reclaimIfStale(key, now) {
    const cur = this.resources.get(key);
    if (!cur) return;
    if (this._isHolderReclaimable(cur, now)) {
      this.resources.delete(key);
    }
  }

  // Non-blocking claim. Returns { ok:true } if the resource is now held by runId
  // (either freshly acquired or already held by it), otherwise { ok:false, holder }.
  // Fail-open: any internal error resolves to ok:true so the run is never wedged.
  tryAcquire(resourceKey, runId, info = {}) {
    try {
      const key = String(resourceKey || '').trim();
      const rid = String(runId || '').trim();
      if (!key || !rid) return { ok: true, held: false, failOpen: true };
      const now = this._now();
      this._reclaimIfStale(key, now);
      const cur = this.resources.get(key);
      if (!cur || !cur.holderRunId) {
        this.resources.set(key, { holderRunId: rid, info: info || {}, acquiredAt: now, lastHeartbeatAt: now });
        return { ok: true, held: true, acquired: true };
      }
      if (cur.holderRunId === rid) {
        cur.lastHeartbeatAt = now;
        return { ok: true, held: true, acquired: false };
      }
      return {
        ok: false,
        holder: { runId: cur.holderRunId, info: cur.info || {}, since: cur.acquiredAt }
      };
    } catch {
      return { ok: true, held: false, failOpen: true };
    }
  }

  heartbeat(resourceKey, runId) {
    try {
      const cur = this.resources.get(String(resourceKey || '').trim());
      if (cur && cur.holderRunId === String(runId || '').trim()) {
        cur.lastHeartbeatAt = this._now();
      }
    } catch {
      /* fail-open */
    }
  }

  release(resourceKey, runId) {
    try {
      const key = String(resourceKey || '').trim();
      const cur = this.resources.get(key);
      if (cur && cur.holderRunId === String(runId || '').trim()) {
        this.resources.delete(key);
        return true;
      }
    } catch {
      /* fail-open */
    }
    return false;
  }

  // Called when a run reaches a terminal state. Frees every resource it held so
  // the next waiter can proceed immediately (the stale-reclaim path is the
  // backstop if this is ever missed).
  releaseAllForRun(runId) {
    try {
      const rid = String(runId || '').trim();
      if (!rid) return 0;
      let released = 0;
      for (const [key, cur] of this.resources.entries()) {
        if (cur.holderRunId === rid) {
          this.resources.delete(key);
          released += 1;
        }
      }
      return released;
    } catch {
      return 0;
    }
  }

  getHolder(resourceKey) {
    try {
      const key = String(resourceKey || '').trim();
      this._reclaimIfStale(key, this._now());
      const cur = this.resources.get(key);
      if (!cur || !cur.holderRunId) return null;
      return { runId: cur.holderRunId, info: cur.info || {}, since: cur.acquiredAt };
    } catch {
      return null;
    }
  }

  // Snapshot of currently-held resources, for surfacing into the supervisor
  // prompt as <resource_holders>.
  describe() {
    const out = {};
    try {
      const now = this._now();
      for (const key of [...this.resources.keys()]) {
        this._reclaimIfStale(key, now);
        const cur = this.resources.get(key);
        if (cur && cur.holderRunId) {
          out[key] = {
            runId: cur.holderRunId,
            title: String(cur.info?.title || ''),
            conversationId: String(cur.info?.conversationId || ''),
            since: new Date(cur.acquiredAt).toISOString()
          };
        }
      }
    } catch {
      /* fail-open: report nothing held */
    }
    return out;
  }

  reset() {
    this.resources.clear();
  }
}

export const runResourceRegistry = new RunResourceRegistry();

export default runResourceRegistry;
