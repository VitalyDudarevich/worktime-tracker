import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, formatDuration, groupByTask, isoDay, liveMs, parseDay } from '../public/time.js';

// A zone with daylight saving time; Node applies a TZ change at runtime.
process.env.TZ = 'Europe/Berlin';

const HOUR = 3_600_000;
const hours = ({ from, to }) => (Date.parse(to) - Date.parse(from)) / HOUR;

test('day range: from midnight of the first day to midnight after the last, in local time', () => {
  assert.deepEqual(dayRange('2026-03-02', '2026-03-02'), {
    from: '2026-03-01T23:00:00.000Z',
    to: '2026-03-02T23:00:00.000Z',
  });
  assert.equal(hours(dayRange('2026-03-02', '2026-03-08')), 7 * 24);
});

test('daylight saving days last 23 and 25 hours', () => {
  assert.equal(hours(dayRange('2026-03-29', '2026-03-29')), 23);
  assert.equal(hours(dayRange('2026-10-25', '2026-10-25')), 25);
});

test('empty dates leave the period open', () => {
  assert.deepEqual(dayRange('', ''), {});
  assert.deepEqual(dayRange('2026-03-02', ''), { from: '2026-03-01T23:00:00.000Z' });
  assert.deepEqual(dayRange('', '2026-03-02'), { to: '2026-03-02T23:00:00.000Z' });
});

test('a "from" date later than the "to" date is rejected', () => {
  assert.throws(() => dayRange('2026-03-03', '2026-03-02'), /later/);
});

test('typed dates must be real days in YYYY-MM-DD', () => {
  assert.equal(parseDay('2026-10-29'), '2026-10-29');
  assert.equal(parseDay('2028-02-29'), '2028-02-29'); // leap year
  for (const bad of ['2026-02-30', '2026-13-01', '29/10/2026', '2026-1-5', 'yesterday', '']) {
    assert.equal(parseDay(bad), null, bad);
  }
  assert.throws(() => dayRange('29/10/2026', ''), /YYYY-MM-DD/);
  assert.equal(isoDay(new Date(2026, 0, 5)), '2026-01-05');
});

test('grouping by task: one row per task, summed time, most recent first', () => {
  const MINUTE = 60_000;
  const entries = [
    { task: 'Call', start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T09:30:00.000Z', periodMs: 30 * MINUTE },
    { task: 'Report', start: '2026-03-02T10:00:00.000Z', end: '2026-03-02T11:00:00.000Z', periodMs: 60 * MINUTE },
    { task: 'Call', start: '2026-03-02T12:00:00.000Z', end: null, periodMs: 15 * MINUTE },
  ];
  const expected = [
    { task: 'Call', count: 2, lastStart: '2026-03-02T12:00:00.000Z', periodMs: 45 * MINUTE, running: true },
    { task: 'Report', count: 1, lastStart: '2026-03-02T10:00:00.000Z', periodMs: 60 * MINUTE, running: false },
  ];
  assert.deepEqual(groupByTask(entries), expected);
  assert.deepEqual(groupByTask([...entries].reverse()), expected); // input order doesn't matter
  assert.deepEqual(groupByTask([]), []);
});

test('live counters grow with running timers and stop at the end of the period', () => {
  const MINUTE = 60_000;
  const since = Date.parse('2026-03-02T10:00:00.000Z');
  const periodEnd = Date.parse('2026-03-02T10:30:00.000Z');
  const at = minutes => since + minutes * MINUTE;

  assert.equal(liveMs(5 * MINUTE, 1, since, Infinity, at(10)), 15 * MINUTE); // one running timer
  assert.equal(liveMs(5 * MINUTE, 2, since, Infinity, at(10)), 25 * MINUTE); // a total with two running timers
  assert.equal(liveMs(5 * MINUTE, 0, since, Infinity, at(10)), 5 * MINUTE); // a finished entry never grows
  assert.equal(liveMs(5 * MINUTE, 1, since, periodEnd, at(90)), 35 * MINUTE); // frozen at the period end
  assert.equal(liveMs(5 * MINUTE, 1, since, periodEnd, since - MINUTE), 5 * MINUTE); // never shrinks
});

test('duration format', () => {
  assert.equal(formatDuration(0), '0:00:00');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatDuration(25 * HOUR), '25:00:00');
  assert.equal(formatDuration(-5000), '0:00:00');
});
