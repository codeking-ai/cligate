// Declarative scheduling helpers. The LLM-facing API speaks in terms of:
//
//   recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly'
//   timezone:   IANA name (default 'Asia/Shanghai')
//   localTime:  'HH:MM' wall-clock time interpreted in `timezone`
//   dayOfWeek:  'sun'..'sat' or 0..6 (or array thereof) — for weekly
//   dayOfMonth: 1..31                                    — for monthly / yearly
//   month:      1..12                                    — for yearly
//
// The LLM never sees UTC, never writes cron, never computes time math.
// All conversion happens inside these helpers, and recurrence-after-fire is
// computed FRESH each time from the declarative schedule (not by adding 24h
// to a stored anchor) — this keeps daily fires correctly anchored to the
// wall-clock time even across DST transitions.

function toText(value) {
  return String(value || '').trim();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKAHEAD_DAYS = 366 * 5;

const WEEKDAY_NAME_TO_NUM = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
};

export function normalizeDayOfWeek(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error('dayOfWeek is required');
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 7) {
      throw new Error(`dayOfWeek must be 0-6 (Sunday=0), got ${value}`);
    }
    return value === 7 ? 0 : value;
  }
  const key = String(value).trim().toLowerCase().slice(0, 3);
  if (Object.prototype.hasOwnProperty.call(WEEKDAY_NAME_TO_NUM, key)) {
    return WEEKDAY_NAME_TO_NUM[key];
  }
  throw new Error(`invalid dayOfWeek "${value}" — expected "mon".."sun" or 0..6`);
}

export function normalizeDayOfWeekList(value) {
  if (Array.isArray(value)) {
    const set = new Set(value.map((entry) => normalizeDayOfWeek(entry)));
    if (set.size === 0) {
      throw new Error('dayOfWeek list cannot be empty');
    }
    return [...set].sort((a, b) => a - b);
  }
  return [normalizeDayOfWeek(value)];
}

function getTimezoneOffsetMs(timezone, atMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const localAsUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return localAsUtcMs - atMs;
}

// Build a UTC ms timestamp for "year-month-day hour:minute:00" in `timezone`.
// Robust to DST: we measure the timezone offset at the candidate instant
// itself, not at `now`.
function wallClockToUtcMs(timezone, year, month, day, hour, minute) {
  const tentativeUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = getTimezoneOffsetMs(timezone, tentativeUtcMs);
  return tentativeUtcMs - offset;
}

function getLocalDateParts(timezone, atMs) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day)
  };
}

function parseLocalTime(localTime) {
  const text = toText(localTime);
  if (!/^\d{1,2}:\d{2}$/.test(text)) {
    throw new Error(`localTime must be "HH:MM" (24-hour), got "${localTime}"`);
  }
  const [hour, minute] = text.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`localTime "${localTime}" is out of range`);
  }
  return { hour, minute };
}

function parseIsoDate(date) {
  const text = toText(date);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`date must be "YYYY-MM-DD", got "${date}"`);
  }
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`date "${date}" is out of range`);
  }
  return { year, month, day };
}

function dayOfWeekFromUtcMs(timezone, utcMs) {
  // Use the timezone-local date to determine weekday, NOT the raw UTC date.
  // 2026-05-15 00:30 UTC is already 2026-05-15 08:30 Beijing (Friday), and
  // we want the local weekday — which is also Friday here, but in edge
  // cases (e.g. 23:30 UTC) the local date can roll to the next day.
  const { year, month, day } = getLocalDateParts(timezone, utcMs);
  // Date.UTC for the local date gives us a stable weekday for that local
  // calendar day, independent of timezone.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Compute the absolute UTC ms for a 'once' reminder from the declarative
// inputs. Used at task-create time. Accepts:
//   - delaySeconds / delayMinutes / delayMs  → now + delay (single shot only)
//   - date + localTime + timezone            → specific calendar moment
//   - localTime + timezone                   → next future occurrence
export function resolveOnceTriggerMs(spec = {}, { now = Date.now() } = {}) {
  const delayMs = Number(spec.delayMs);
  const delaySec = Number(spec.delaySeconds);
  const delayMin = Number(spec.delayMinutes);
  if (Number.isFinite(delayMs) && delayMs > 0) {
    return now + delayMs;
  }
  if (Number.isFinite(delaySec) && delaySec > 0) {
    return now + delaySec * 1000;
  }
  if (Number.isFinite(delayMin) && delayMin > 0) {
    return now + delayMin * 60 * 1000;
  }

  const localTime = toText(spec.localTime);
  if (!localTime) {
    throw new Error('once schedule needs delayMinutes / delaySeconds / localTime');
  }
  const { hour, minute } = parseLocalTime(localTime);
  const timezone = toText(spec.timezone) || 'Asia/Shanghai';

  if (spec.date) {
    const { year, month, day } = parseIsoDate(spec.date);
    return wallClockToUtcMs(timezone, year, month, day, hour, minute);
  }

  const today = getLocalDateParts(timezone, now);
  const todayCandidate = wallClockToUtcMs(timezone, today.year, today.month, today.day, hour, minute);
  if (todayCandidate > now) {
    return todayCandidate;
  }
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day) + DAY_MS);
  return wallClockToUtcMs(
    timezone,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    hour,
    minute
  );
}

// Compute the next firing time (UTC ms) STRICTLY > now for a recurring
// schedule. For 'once', returns null — once-fires never repeat.
// Throws on malformed schedules.
export function computeNextOccurrenceMs(schedule = {}, { now = Date.now() } = {}) {
  const recurrence = toText(schedule.recurrence).toLowerCase();
  if (!recurrence || recurrence === 'once') {
    return null;
  }

  const timezone = toText(schedule.timezone) || 'Asia/Shanghai';
  const { hour, minute } = parseLocalTime(schedule.localTime);

  let dayOfWeekList = null;
  if (recurrence === 'weekly') {
    dayOfWeekList = normalizeDayOfWeekList(schedule.dayOfWeek);
  }

  let dayOfMonth = null;
  if (recurrence === 'monthly' || recurrence === 'yearly') {
    dayOfMonth = Number(schedule.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error(`dayOfMonth must be 1..31, got "${schedule.dayOfMonth}"`);
    }
  }

  let monthOfYear = null;
  if (recurrence === 'yearly') {
    monthOfYear = Number(schedule.month);
    if (!Number.isInteger(monthOfYear) || monthOfYear < 1 || monthOfYear > 12) {
      throw new Error(`month must be 1..12, got "${schedule.month}"`);
    }
  }

  const startParts = getLocalDateParts(timezone, now);
  let cursor = Date.UTC(startParts.year, startParts.month - 1, startParts.day);

  for (let step = 0; step < MAX_LOOKAHEAD_DAYS; step += 1) {
    const d = new Date(cursor);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const dd = d.getUTCDate();
    const candidate = wallClockToUtcMs(timezone, y, m, dd, hour, minute);

    if (candidate > now) {
      let matches = false;
      if (recurrence === 'daily') {
        matches = true;
      } else if (recurrence === 'weekly') {
        matches = dayOfWeekList.includes(dayOfWeekFromUtcMs(timezone, candidate));
      } else if (recurrence === 'monthly') {
        const local = getLocalDateParts(timezone, candidate);
        matches = local.day === dayOfMonth;
      } else if (recurrence === 'yearly') {
        const local = getLocalDateParts(timezone, candidate);
        matches = local.day === dayOfMonth && local.month === monthOfYear;
      } else {
        throw new Error(`unsupported recurrence "${recurrence}"`);
      }
      if (matches) {
        return candidate;
      }
    }

    cursor += DAY_MS;
  }

  throw new Error(`computeNextOccurrenceMs: no match within ${MAX_LOOKAHEAD_DAYS} days for recurrence "${recurrence}"`);
}

export function computeNextOccurrenceIso(schedule = {}, options = {}) {
  const ms = computeNextOccurrenceMs(schedule, options);
  return ms == null ? '' : new Date(ms).toISOString();
}

// Format an ISO UTC moment into a "YYYY-MM-DD HH:MM (Asia/Shanghai)" string
// the LLM can paste verbatim into a user-facing reply. Avoids LLM doing
// per-locale formatting math.
export function describeFireMoment(utcIso, timezone = 'Asia/Shanghai') {
  const ms = Date.parse(toText(utcIso));
  if (!Number.isFinite(ms)) return '';
  const tz = toText(timezone) || 'Asia/Shanghai';
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${tz})`;
}

// Exposed for direct testing.
export const __test__ = {
  getTimezoneOffsetMs,
  wallClockToUtcMs,
  getLocalDateParts,
  dayOfWeekFromUtcMs,
  parseLocalTime,
  parseIsoDate
};

export default {
  resolveOnceTriggerMs,
  computeNextOccurrenceMs,
  computeNextOccurrenceIso,
  describeFireMoment,
  normalizeDayOfWeek,
  normalizeDayOfWeekList
};
