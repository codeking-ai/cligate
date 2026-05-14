import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveOnceTriggerMs,
  computeNextOccurrenceIso,
  computeNextOccurrenceMs,
  describeFireMoment,
  normalizeDayOfWeek,
  normalizeDayOfWeekList,
  __test__
} from '../../src/assistant-core/schedule-helpers.js';

const { getTimezoneOffsetMs, wallClockToUtcMs, dayOfWeekFromUtcMs } = __test__;

test('getTimezoneOffsetMs returns +8h for Asia/Shanghai', () => {
  const offset = getTimezoneOffsetMs('Asia/Shanghai', Date.parse('2026-05-14T12:00:00.000Z'));
  assert.equal(offset, 8 * 60 * 60 * 1000);
});

test('wallClockToUtcMs treats 20:00 Asia/Shanghai as 12:00 UTC', () => {
  const ms = wallClockToUtcMs('Asia/Shanghai', 2026, 5, 14, 20, 0);
  assert.equal(new Date(ms).toISOString(), '2026-05-14T12:00:00.000Z');
});

test('normalizeDayOfWeek accepts short names case-insensitively', () => {
  assert.equal(normalizeDayOfWeek('Mon'), 1);
  assert.equal(normalizeDayOfWeek('SUN'), 0);
  assert.equal(normalizeDayOfWeek('sat'), 6);
  assert.equal(normalizeDayOfWeek(0), 0);
  assert.equal(normalizeDayOfWeek(7), 0); // cron-style Sunday normalization
  assert.throws(() => normalizeDayOfWeek('xyz'), /invalid dayOfWeek/);
});

test('normalizeDayOfWeekList sorts and deduplicates', () => {
  assert.deepEqual(normalizeDayOfWeekList(['fri', 'mon', 'mon', 'wed']), [1, 3, 5]);
});

test('resolveOnceTriggerMs: delayMinutes adds N minutes to now', () => {
  const now = Date.parse('2026-05-14T10:00:00.000Z');
  const ms = resolveOnceTriggerMs({ delayMinutes: 5 }, { now });
  assert.equal(new Date(ms).toISOString(), '2026-05-14T10:05:00.000Z');
});

test('resolveOnceTriggerMs: delaySeconds adds N seconds', () => {
  const now = Date.parse('2026-05-14T10:00:00.000Z');
  const ms = resolveOnceTriggerMs({ delaySeconds: 90 }, { now });
  assert.equal(new Date(ms).toISOString(), '2026-05-14T10:01:30.000Z');
});

test('resolveOnceTriggerMs: localTime alone picks next future occurrence', () => {
  // 12:00 UTC = 20:00 Beijing. 20:10 Beijing is still in the future today.
  const now = Date.parse('2026-05-14T12:00:00.000Z');
  const ms = resolveOnceTriggerMs({ localTime: '20:10', timezone: 'Asia/Shanghai' }, { now });
  assert.equal(new Date(ms).toISOString(), '2026-05-14T12:10:00.000Z');
});

test('resolveOnceTriggerMs: localTime past today rolls to tomorrow', () => {
  // 13:00 UTC = 21:00 Beijing. Today's 20:10 Beijing has already passed.
  const now = Date.parse('2026-05-14T13:00:00.000Z');
  const ms = resolveOnceTriggerMs({ localTime: '20:10', timezone: 'Asia/Shanghai' }, { now });
  assert.equal(new Date(ms).toISOString(), '2026-05-15T12:10:00.000Z');
});

test('resolveOnceTriggerMs: date + localTime pins to that calendar moment', () => {
  const ms = resolveOnceTriggerMs(
    { date: '2026-06-01', localTime: '09:00', timezone: 'Asia/Shanghai' },
    { now: Date.parse('2026-05-14T00:00:00.000Z') }
  );
  assert.equal(new Date(ms).toISOString(), '2026-06-01T01:00:00.000Z');
});

test('resolveOnceTriggerMs: throws if nothing usable provided', () => {
  assert.throws(
    () => resolveOnceTriggerMs({}),
    /delayMinutes \/ delaySeconds \/ localTime/
  );
});

test('computeNextOccurrenceIso: once recurrence returns empty (handled by resolveOnceTriggerMs)', () => {
  const iso = computeNextOccurrenceIso({ recurrence: 'once', localTime: '20:00' });
  assert.equal(iso, '');
});

test('computeNextOccurrenceIso: daily picks next 20:00 Asia/Shanghai', () => {
  // now = 2026-05-14T10:00 UTC = 18:00 Beijing. Next 20:00 Beijing = today 12:00 UTC.
  const now = Date.parse('2026-05-14T10:00:00.000Z');
  const iso = computeNextOccurrenceIso(
    { recurrence: 'daily', localTime: '20:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  assert.equal(iso, '2026-05-14T12:00:00.000Z');
});

test('computeNextOccurrenceIso: daily rolls to tomorrow if today already passed', () => {
  // 13:00 UTC = 21:00 Beijing. Today's 20:00 Beijing has passed.
  const now = Date.parse('2026-05-14T13:00:00.000Z');
  const iso = computeNextOccurrenceIso(
    { recurrence: 'daily', localTime: '20:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  assert.equal(iso, '2026-05-15T12:00:00.000Z');
});

test('computeNextOccurrenceIso: weekly picks next named weekday', () => {
  // 2026-05-14 is a Thursday (weekday 4). Next Monday is 2026-05-18.
  const now = Date.parse('2026-05-14T10:00:00.000Z');
  const iso = computeNextOccurrenceIso(
    { recurrence: 'weekly', dayOfWeek: 'mon', localTime: '09:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  assert.equal(iso, '2026-05-18T01:00:00.000Z'); // 09:00 Beijing = 01:00 UTC
});

test('computeNextOccurrenceIso: weekly accepts multiple weekdays', () => {
  // From Thursday 2026-05-14 10:00 UTC, "mon/wed/fri" — next is Friday 2026-05-15.
  const now = Date.parse('2026-05-14T10:00:00.000Z');
  const iso = computeNextOccurrenceIso(
    { recurrence: 'weekly', dayOfWeek: ['mon', 'wed', 'fri'], localTime: '09:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  assert.equal(iso, '2026-05-15T01:00:00.000Z');
});

test('computeNextOccurrenceIso: monthly skips months that lack the day', () => {
  // dayOfMonth=31 from 2026-05-14 → next 31 is May 31. Then if we ask
  // for next-of-next from 2026-06-01, we should skip June (30 days) and
  // land on July 31.
  const may = Date.parse('2026-05-14T00:00:00.000Z');
  const isoMay = computeNextOccurrenceIso(
    { recurrence: 'monthly', dayOfMonth: 31, localTime: '09:00', timezone: 'Asia/Shanghai' },
    { now: may }
  );
  assert.equal(isoMay, '2026-05-31T01:00:00.000Z');
  const june = Date.parse('2026-06-01T00:00:00.000Z');
  const isoJune = computeNextOccurrenceIso(
    { recurrence: 'monthly', dayOfMonth: 31, localTime: '09:00', timezone: 'Asia/Shanghai' },
    { now: june }
  );
  assert.equal(isoJune, '2026-07-31T01:00:00.000Z');
});

test('computeNextOccurrenceIso: yearly picks the next month+day match', () => {
  // From 2026-05-14, next "Jan 1" is 2027-01-01.
  const now = Date.parse('2026-05-14T00:00:00.000Z');
  const iso = computeNextOccurrenceIso(
    { recurrence: 'yearly', month: 1, dayOfMonth: 1, localTime: '00:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  // 2027-01-01 00:00 Beijing = 2026-12-31 16:00 UTC.
  assert.equal(iso, '2026-12-31T16:00:00.000Z');
});

test('computeNextOccurrenceIso: missing localTime is rejected for recurring', () => {
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'daily', timezone: 'Asia/Shanghai' }),
    /localTime/
  );
});

test('computeNextOccurrenceIso: malformed localTime is rejected', () => {
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'daily', localTime: '8 PM', timezone: 'Asia/Shanghai' }),
    /HH:MM/
  );
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'daily', localTime: '25:00', timezone: 'Asia/Shanghai' }),
    /out of range/
  );
});

test('computeNextOccurrenceIso: weekly without dayOfWeek is rejected', () => {
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'weekly', localTime: '09:00', timezone: 'Asia/Shanghai' }),
    /dayOfWeek/
  );
});

test('computeNextOccurrenceIso: monthly with bad dayOfMonth is rejected', () => {
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'monthly', dayOfMonth: 0, localTime: '09:00' }),
    /dayOfMonth must be 1..31/
  );
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'monthly', dayOfMonth: 99, localTime: '09:00' }),
    /dayOfMonth must be 1..31/
  );
});

test('computeNextOccurrenceIso: yearly with bad month is rejected', () => {
  assert.throws(
    () => computeNextOccurrenceIso({ recurrence: 'yearly', month: 13, dayOfMonth: 1, localTime: '09:00' }),
    /month must be 1..12/
  );
});

test('computeNextOccurrenceIso: returns a moment strictly > now even when localTime is "now"', () => {
  // If we ask for daily 20:00 at exactly 20:00 today, the next fire must
  // be tomorrow's 20:00 — we never re-fire on the same wall-clock minute.
  const now = Date.parse('2026-05-14T12:00:00.000Z'); // 20:00 Beijing
  const ms = computeNextOccurrenceMs(
    { recurrence: 'daily', localTime: '20:00', timezone: 'Asia/Shanghai' },
    { now }
  );
  assert.ok(ms > now, 'next must be strictly > now');
  assert.equal(new Date(ms).toISOString(), '2026-05-15T12:00:00.000Z');
});

test('describeFireMoment formats UTC ISO into a user-friendly local-timezone string', () => {
  const desc = describeFireMoment('2026-05-14T12:10:00.000Z', 'Asia/Shanghai');
  assert.equal(desc, '2026-05-14 20:10 (Asia/Shanghai)');
});

test('dayOfWeekFromUtcMs returns the local-timezone weekday, not the UTC weekday', () => {
  // 2026-05-14 23:00 UTC is 2026-05-15 07:00 Beijing = Friday (5).
  const ms = Date.parse('2026-05-14T23:00:00.000Z');
  assert.equal(dayOfWeekFromUtcMs('Asia/Shanghai', ms), 5);
  // Same instant in UTC is Thursday (4).
  assert.equal(dayOfWeekFromUtcMs('UTC', ms), 4);
});
