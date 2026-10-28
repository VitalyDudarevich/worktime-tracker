// Time and report helpers shared by the page and the tests.

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * What a live duration shows at `now`: `baseMs` plus the growth of `rate` running timers since `since`,
 * frozen at `until` (the end of the period). A finished entry has rate 0 and never grows.
 */
export function liveMs(baseMs, rate, since, until, now) {
  return baseMs + rate * Math.max(0, Math.min(now, until) - since);
}

// The day itself if `text` is a real calendar day in YYYY-MM-DD, otherwise null (so 2026-02-30 is rejected).
export function parseDay(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  const real = date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  return real ? text : null;
}

// A local Date as YYYY-MM-DD.
export function isoDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Local calendar days "from".."to" (YYYY-MM-DD, both inclusive) as instants
 * [00:00 of "from", 00:00 of the day after "to") in the current time zone.
 * An empty day leaves that side of the period open, so { } means all time.
 * setDate(+1) instead of adding 24 hours keeps daylight-saving days (23 or 25 hours) right.
 */
export function dayRange(from, to) {
  for (const day of [from, to]) {
    if (day && !parseDay(day)) throw new Error(`"${day}" is not a date. Use the YYYY-MM-DD format, e.g. 2026-10-29`);
  }
  if (from && to && from > to) throw new Error('The "from" date can\'t be later than the "to" date');
  const range = {};
  if (from) range.from = new Date(`${from}T00:00:00`).toISOString();
  if (to) {
    const end = new Date(`${to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    range.to = end.toISOString();
  }
  return range;
}

/**
 * Report entries grouped by task, for the "by task" view: one row per task with the number
 * of entries, the latest start, the time inside the period and whether one of them is running.
 * The data isn't changed, only shown differently. Most recently worked-on task first.
 */
export function groupByTask(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const group = groups.get(entry.task)
      ?? { task: entry.task, count: 0, lastStart: entry.start, periodMs: 0, running: false };
    group.count += 1;
    group.periodMs += entry.periodMs;
    group.running ||= !entry.end;
    if (Date.parse(entry.start) > Date.parse(group.lastStart)) group.lastStart = entry.start;
    groups.set(entry.task, group);
  }
  return [...groups.values()].sort((a, b) => Date.parse(b.lastStart) - Date.parse(a.lastStart));
}
