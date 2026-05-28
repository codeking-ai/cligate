import { stat as fsStat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';

import assistantDesktopClient from '../desktop/client.js';
import assistantRunStore from '../../assistant-core/run-store.js';
import { ASSISTANT_RUN_STATUS } from '../../assistant-core/models.js';

const execFile = promisify(execFileCb);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000; // 10 minutes is plenty for downloads / installs
const DEFAULT_POLL_MS = 1_500;
const MIN_POLL_MS = 250;

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait tools must abort the moment a supervisor LLM calls cancel_assistant_run
// against THIS run. Otherwise a long wait_for_* would lock the run for minutes
// even after the user said "stop". Check the run's status between polls and
// throw a cancellation error so the ReAct loop unwinds cleanly.
function checkCancellation(context = {}, runStore = assistantRunStore) {
  const runId = String(context?.run?.id || '').trim();
  if (!runId) return;
  const run = runStore.get(runId);
  const status = String(run?.status || '').trim();
  if (status === ASSISTANT_RUN_STATUS.CANCELLED) {
    const error = new Error(`wait aborted: assistant run ${runId} was cancelled`);
    error.code = 'RUN_CANCELLED';
    throw error;
  }
}

async function pollUntil({
  context,
  runStore,
  timeoutMs,
  pollMs,
  attempt
}) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  let lastResult = null;
  while (Date.now() <= deadline) {
    attempts += 1;
    checkCancellation(context, runStore);
    try {
      const result = await attempt();
      if (result?.matched) {
        return {
          ok: true,
          matched: true,
          attempts,
          elapsedMs: timeoutMs - Math.max(0, deadline - Date.now()),
          details: result.details || null
        };
      }
      lastResult = result;
    } catch (error) {
      if (error?.code === 'RUN_CANCELLED') throw error;
      lastResult = { matched: false, details: { error: String(error?.message || error) } };
    }
    if (Date.now() + pollMs > deadline) break;
    await sleep(pollMs);
  }
  // Final cancellation check before reporting timeout — the user may have
  // cancelled during the last sleep.
  checkCancellation(context, runStore);
  return {
    ok: false,
    matched: false,
    timedOut: true,
    attempts,
    elapsedMs: timeoutMs,
    lastDetails: lastResult?.details || null
  };
}

// ----- desktop_wait_for_file ------------------------------------------------

async function probeFile(path) {
  try {
    const info = await fsStat(path);
    return {
      matched: true,
      details: {
        path,
        size: info.size,
        modifiedAt: info.mtime?.toISOString?.() || null,
        isFile: info.isFile(),
        isDirectory: info.isDirectory()
      }
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { matched: false, details: { path, missing: true } };
    }
    throw error;
  }
}

// ----- desktop_wait_for_process --------------------------------------------

async function probeProcess({ nameOrPid, untilState }) {
  const raw = String(nameOrPid || '').trim();
  if (!raw) {
    return { matched: false, details: { error: 'nameOrPid is required' } };
  }
  const isPid = /^\d+$/.test(raw);
  const args = isPid
    ? ['/FI', `PID eq ${raw}`, '/FO', 'CSV', '/NH']
    : ['/FI', `IMAGENAME eq ${raw}`, '/FO', 'CSV', '/NH'];
  let stdout = '';
  try {
    const result = await execFile('tasklist.exe', args, { timeout: 5_000, windowsHide: true });
    stdout = String(result?.stdout || '');
  } catch (error) {
    return { matched: false, details: { error: String(error?.message || error) } };
  }
  // tasklist emits "INFO: No tasks are running which match the specified criteria."
  // (to stdout, not stderr) when nothing matches.
  const noMatch = /No tasks are running/i.test(stdout);
  const present = !noMatch && stdout.split(/\r?\n/).some((line) => /"[^"]+"\s*,\s*"\d+"/.test(line));
  const state = String(untilState || 'appears').toLowerCase();
  const wantedPresent = state !== 'disappears';
  const matched = wantedPresent ? present : !present;
  return {
    matched,
    details: {
      nameOrPid: raw,
      isPid,
      present,
      untilState: wantedPresent ? 'appears' : 'disappears'
    }
  };
}

// ----- desktop_wait_for_window ---------------------------------------------

function matchesWindowTitle(entry, title, mode) {
  const candidate = String(entry?.title || '');
  const query = String(title || '');
  if (!query) return true;
  const normalizedMode = String(mode || 'contains').toLowerCase();
  if (normalizedMode === 'exact') return candidate === query;
  if (normalizedMode === 'regex') {
    try {
      return new RegExp(query, 'i').test(candidate);
    } catch {
      return candidate.includes(query);
    }
  }
  return candidate.toLowerCase().includes(query.toLowerCase());
}

async function probeWindow({ title, windowMatch, desktopClient }) {
  try {
    const result = await desktopClient.listWindows({});
    const windows = Array.isArray(result?.windows)
      ? result.windows
      : Array.isArray(result?.list)
        ? result.list
        : [];
    const match = windows.find((entry) => matchesWindowTitle(entry, title, windowMatch));
    if (match) {
      return {
        matched: true,
        details: {
          hwnd: match.hwnd,
          title: match.title || '',
          class: match.class || match.className || '',
          pid: match.pid || 0
        }
      };
    }
    return {
      matched: false,
      details: {
        sampledCount: windows.length,
        sampledTitles: windows.slice(0, 5).map((entry) => String(entry?.title || '').slice(0, 80))
      }
    };
  } catch (error) {
    return { matched: false, details: { error: String(error?.message || error) } };
  }
}

// ----- handler factory ------------------------------------------------------

export function createDesktopWaitToolHandlers({
  desktopClient = assistantDesktopClient,
  runStore = assistantRunStore
} = {}) {
  return {
    desktopWaitForFile: async ({ input = {}, context = {} } = {}) => {
      const path = String(input?.path || '').trim();
      if (!path) {
        const error = new Error('desktop_wait_for_file requires path');
        error.code = 'INVALID_INPUT';
        throw error;
      }
      const timeoutMs = clampInt(input?.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_POLL_MS, MAX_TIMEOUT_MS);
      const pollMs = clampInt(input?.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, timeoutMs);
      const minSizeBytes = Math.max(0, Number(input?.minSizeBytes) || 0);
      const stableForMs = Math.max(0, Number(input?.stableForMs) || 0);

      let lastSize = -1;
      let stableSince = 0;

      const result = await pollUntil({
        context,
        runStore,
        timeoutMs,
        pollMs,
        attempt: async () => {
          const probe = await probeFile(path);
          if (!probe.matched) return probe;
          const size = Number(probe.details?.size || 0);
          if (size < minSizeBytes) {
            return { matched: false, details: { ...probe.details, belowMinSize: true, minSizeBytes } };
          }
          if (stableForMs > 0) {
            if (size === lastSize) {
              if (!stableSince) stableSince = Date.now();
              if (Date.now() - stableSince >= stableForMs) {
                return probe;
              }
              return { matched: false, details: { ...probe.details, waitingForStable: true, stableForMs } };
            }
            lastSize = size;
            stableSince = 0;
            return { matched: false, details: { ...probe.details, waitingForStable: true, stableForMs } };
          }
          return probe;
        }
      });
      return { action: 'wait_for_file', path, timeoutMs, pollMs, ...result };
    },

    desktopWaitForProcess: async ({ input = {}, context = {} } = {}) => {
      const nameOrPid = String(input?.nameOrPid || '').trim();
      if (!nameOrPid) {
        const error = new Error('desktop_wait_for_process requires nameOrPid');
        error.code = 'INVALID_INPUT';
        throw error;
      }
      const untilState = String(input?.untilState || 'appears').toLowerCase();
      const timeoutMs = clampInt(input?.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_POLL_MS, MAX_TIMEOUT_MS);
      const pollMs = clampInt(input?.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, timeoutMs);

      const result = await pollUntil({
        context,
        runStore,
        timeoutMs,
        pollMs,
        attempt: () => probeProcess({ nameOrPid, untilState })
      });
      return { action: 'wait_for_process', nameOrPid, untilState, timeoutMs, pollMs, ...result };
    },

    desktopWaitForWindow: async ({ input = {}, context = {} } = {}) => {
      const title = String(input?.title || '').trim();
      if (!title) {
        const error = new Error('desktop_wait_for_window requires title');
        error.code = 'INVALID_INPUT';
        throw error;
      }
      const windowMatch = String(input?.windowMatch || 'contains');
      const timeoutMs = clampInt(input?.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_POLL_MS, MAX_TIMEOUT_MS);
      const pollMs = clampInt(input?.pollMs, DEFAULT_POLL_MS, MIN_POLL_MS, timeoutMs);

      const result = await pollUntil({
        context,
        runStore,
        timeoutMs,
        pollMs,
        attempt: () => probeWindow({ title, windowMatch, desktopClient })
      });
      return { action: 'wait_for_window', title, windowMatch, timeoutMs, pollMs, ...result };
    }
  };
}

export default createDesktopWaitToolHandlers;
