import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const MINUTE = 60_000;
let file;
let clock;

// A manual clock: tests move time forward explicitly instead of sleeping.
function makeClock(iso) {
  let ms = Date.parse(iso);
  return {
    now: () => new Date(ms),
    advance: minutes => { ms += minutes * MINUTE; },
  };
}

function openStore() {
  return new Store(file, { now: clock.now });
}

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worktime-')), 'db.json');
  clock = makeClock('2026-03-02T09:00:00.000Z');
});

const DAY = { from: '2026-03-02T00:00:00.000Z', to: '2026-03-03T00:00:00.000Z' };

test('adds an employee and trims the name', () => {
  const store = openStore();
  const anna = store.addEmployee('  Anna Peterson  ');
  assert.equal(anna.name, 'Anna Peterson');
  assert.deepEqual(store.listEmployees().map(e => e.name), ['Anna Peterson']);
});

test('rejects an empty or duplicate name', () => {
  const store = openStore();
  store.addEmployee('Anna');
  assert.throws(() => store.addEmployee('   '), { status: 400 });
  assert.throws(() => store.addEmployee('anna'), { status: 409, message: /"Anna"/ });
  assert.equal(store.listEmployees().length, 1);
});

test('start and stop record an entry with its duration', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Landing page layout');
  clock.advance(5);
  const { running } = store.listEmployees()[0];
  assert.equal(running.task, 'Landing page layout');
  assert.equal(running.elapsedMs, 5 * MINUTE);

  clock.advance(85);
  const entry = store.stopTimer(anna.id);
  assert.equal(entry.end, '2026-03-02T10:30:00.000Z');
  assert.equal(store.listEmployees()[0].running, null);

  const report = store.report(DAY.from, DAY.to);
  assert.equal(report.employees[0].totalMs, 90 * MINUTE);
});

test('start without a task description is rejected', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  assert.throws(() => store.startTimer(anna.id, ''), { status: 400 });
  assert.throws(() => store.startTimer(anna.id, undefined), { status: 400 });
  assert.equal(store.listEmployees()[0].running, null);
});

test('starting again while the timer runs is rejected and adds no second entry', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Task 1');
  clock.advance(10);
  assert.throws(() => store.startTimer(anna.id, 'Task 2'), { status: 409 });

  const [row] = store.report(DAY.from, DAY.to).employees;
  assert.equal(row.entries.length, 1);
  assert.equal(row.entries[0].task, 'Task 1');
});

test('starting again after a stop creates a new entry and the time adds up', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Task 1');
  clock.advance(30);
  store.stopTimer(anna.id);
  clock.advance(15);
  store.startTimer(anna.id, 'Task 2');
  clock.advance(45);
  store.stopTimer(anna.id);

  const [row] = store.report(DAY.from, DAY.to).employees;
  assert.deepEqual(row.entries.map(e => e.task), ['Task 1', 'Task 2']);
  assert.equal(row.totalMs, 75 * MINUTE);
});

test('switching stops the current task and starts the new one at the same moment', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Call');
  clock.advance(15);
  store.switchTask(anna.id, 'Report');
  clock.advance(45);

  const [row] = store.report(DAY.from, DAY.to).employees;
  const [call, report] = row.entries;
  assert.equal(call.end, report.start); // no gap and no overlap
  assert.equal(call.periodMs, 15 * MINUTE);
  assert.equal(report.end, null);
  assert.equal(store.listEmployees()[0].running.task, 'Report');
  assert.equal(row.totalMs, 60 * MINUTE); // nothing counted twice
});

test('switching to the task that is already running is rejected and changes nothing', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Call');
  assert.throws(() => store.switchTask(anna.id, 'Call'), { status: 409 });
  assert.throws(() => store.switchTask(anna.id, '  '), { status: 400 });
  assert.throws(() => store.switchTask('nope', 'Report'), { status: 404 });
  assert.equal(store.report(DAY.from, DAY.to).employees[0].entries.length, 1);
  assert.equal(store.listEmployees()[0].running.task, 'Call');
});

test('a switch from an out-of-date page never stops a timer started elsewhere', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');

  // The page saw no running timer, but another window started one meanwhile.
  const other = store.startTimer(anna.id, 'Deploy hotfix');
  assert.throws(() => store.switchTask(anna.id, 'Night release', null), { status: 409, message: /another window/ });
  assert.equal(store.listEmployees()[0].running.id, other.id);

  // The page saw the old timer, but it was stopped and a new one started meanwhile.
  store.stopTimer(anna.id);
  const newer = store.startTimer(anna.id, 'Code review');
  assert.throws(() => store.switchTask(anna.id, 'Night release', other.id), { status: 409 });
  assert.equal(store.listEmployees()[0].running.id, newer.id);

  // With the right expectation the switch goes through.
  store.switchTask(anna.id, 'Night release', newer.id);
  assert.equal(store.listEmployees()[0].running.task, 'Night release');
});

test('continuing a task the next day creates a new entry for the new day', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Report');
  clock.advance(60);
  store.stopTimer(anna.id);

  clock.advance(24 * 60); // the next morning, no timer running
  store.switchTask(anna.id, 'Report');
  clock.advance(30);
  store.stopTimer(anna.id);

  const entries = store.report(DAY.from, '2026-03-04T00:00:00.000Z').employees[0].entries;
  assert.deepEqual(entries.map(e => e.start.slice(0, 10)), ['2026-03-02', '2026-03-03']);
  assert.deepEqual(entries.map(e => e.periodMs), [60 * MINUTE, 30 * MINUTE]);
});

test('stop without a running timer is rejected', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  assert.throws(() => store.stopTimer(anna.id), { status: 409 });
});

test('timers of different employees are independent', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  const boris = store.addEmployee('Boris');
  store.startTimer(anna.id, "Anna's task");
  store.startTimer(boris.id, "Boris's task");
  clock.advance(20);
  store.stopTimer(anna.id);
  clock.advance(40);
  store.stopTimer(boris.id);

  const totals = store.report(DAY.from, DAY.to).employees.map(e => [e.name, e.totalMs]);
  assert.deepEqual(totals, [['Anna', 20 * MINUTE], ['Boris', 60 * MINUTE]]);
});

test('report for one employee', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  const boris = store.addEmployee('Boris');
  const vera = store.addEmployee('Vera');
  store.startTimer(anna.id, "Anna's task");
  store.startTimer(boris.id, "Boris's task");
  clock.advance(20);
  store.stopTimer(anna.id);
  clock.advance(40);
  store.stopTimer(boris.id);

  const onlyBoris = store.report(DAY.from, DAY.to, boris.id);
  assert.deepEqual(onlyBoris.employees.map(e => e.name), ['Boris']);
  assert.deepEqual(onlyBoris.employees[0].entries.map(e => e.task), ["Boris's task"]);
  assert.equal(onlyBoris.totalMs, 60 * MINUTE);

  // An employee with no entries in the period gets an empty report, not an error.
  const onlyVera = store.report(DAY.from, DAY.to, vera.id);
  assert.deepEqual(onlyVera.employees[0].entries, []);
  assert.equal(onlyVera.totalMs, 0);

  assert.equal(store.report(DAY.from, DAY.to).employees.length, 3);
  assert.throws(() => store.report(DAY.from, DAY.to, 'nope'), { status: 404 });
});

test('unknown employee: 404', () => {
  const store = openStore();
  assert.throws(() => store.startTimer('nope', 'Task'), { status: 404 });
  assert.throws(() => store.stopTimer('nope'), { status: 404 });
});

test('empty report when there are no employees', () => {
  const report = openStore().report(DAY.from, DAY.to);
  assert.deepEqual(report.employees, []);
  assert.equal(report.totalMs, 0);
});

test('empty report when there are no entries in the period', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, "Yesterday's task");
  clock.advance(60);
  store.stopTimer(anna.id);

  const report = store.report('2026-03-05T00:00:00.000Z', '2026-03-06T00:00:00.000Z');
  assert.equal(report.employees.length, 1);
  assert.deepEqual(report.employees[0].entries, []);
  assert.equal(report.employees[0].totalMs, 0);
  assert.equal(report.totalMs, 0);
});

test('an entry crossing the period edge counts only inside the period', () => {
  clock = makeClock('2026-03-02T23:00:00.000Z');
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Night release');
  clock.advance(120); // 23:00 -> 01:00 the next day
  store.stopTimer(anna.id);

  const day1 = store.report(DAY.from, DAY.to).employees[0];
  assert.equal(day1.totalMs, 60 * MINUTE);
  assert.equal(day1.entries[0].durationMs, 120 * MINUTE);

  const day2 = store.report('2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z').employees[0];
  assert.equal(day2.totalMs, 60 * MINUTE);

  const both = store.report(DAY.from, '2026-03-04T00:00:00.000Z').employees[0];
  assert.equal(both.totalMs, 120 * MINUTE);
});

test('a running timer counts in the report up to now', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Running now');
  clock.advance(25);

  const [row] = store.report(DAY.from, DAY.to).employees;
  assert.equal(row.entries[0].end, null);
  assert.equal(row.totalMs, 25 * MINUTE);
});

test('period bounds [from, to): an entry ending exactly at from or starting exactly at to is out', () => {
  clock = makeClock('2026-03-01T22:00:00.000Z');
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Ended at 00:00');
  clock.advance(120); // 22:00 -> 00:00, exactly the period start
  store.stopTimer(anna.id);
  clock.advance(24 * 60); // 00:00 the next day, exactly the period end
  store.startTimer(anna.id, 'Started at the period end');
  clock.advance(30);
  store.stopTimer(anna.id);

  const [row] = store.report(DAY.from, DAY.to).employees;
  assert.deepEqual(row.entries, []);
  assert.equal(row.totalMs, 0);
});

test('a timer started before the period counts from the period start and stops at its end', () => {
  clock = makeClock('2026-03-01T23:00:00.000Z');
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Long task');

  clock.advance(120); // now 01:00, the timer is running
  assert.equal(store.report(DAY.from, DAY.to).employees[0].totalMs, 60 * MINUTE);

  clock.advance(2 * 24 * 60); // the period is in the past, the timer still runs
  assert.equal(store.report(DAY.from, DAY.to).employees[0].totalMs, 24 * 60 * MINUTE);
});

test('time never goes negative when the clock is moved back', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Regular task');
  clock.advance(60);
  store.stopTimer(anna.id);

  store.startTimer(anna.id, 'Clock moved back');
  clock.advance(-10);
  assert.equal(store.listEmployees()[0].running.elapsedMs, 0);
  assert.equal(store.report(DAY.from, DAY.to).employees[0].totalMs, 60 * MINUTE);

  const entry = store.stopTimer(anna.id);
  assert.equal(entry.end, entry.start);
  assert.equal(store.report(DAY.from, DAY.to).employees[0].totalMs, 60 * MINUTE);
});

test('the period is optional: no dates means all time, one date leaves the other side open', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Monday');
  clock.advance(60);
  store.stopTimer(anna.id);
  clock.advance(24 * 60);
  store.startTimer(anna.id, 'Tuesday');
  clock.advance(30);
  store.stopTimer(anna.id);

  const tasks = report => report.employees[0].entries.map(e => e.task);
  const all = store.report();
  assert.deepEqual(tasks(all), ['Monday', 'Tuesday']);
  assert.equal(all.totalMs, 90 * MINUTE);
  assert.equal(all.from, null);
  assert.equal(all.to, null);
  assert.deepEqual(tasks(store.report('', '')), ['Monday', 'Tuesday']);
  assert.deepEqual(tasks(store.report('2026-03-03T00:00:00.000Z')), ['Tuesday']);
  assert.deepEqual(tasks(store.report(undefined, '2026-03-03T00:00:00.000Z')), ['Monday']);
});

test('an invalid period is rejected', () => {
  const store = openStore();
  assert.throws(() => store.report('abc', DAY.to), { status: 400 });
  assert.throws(() => store.report(DAY.from, 'abc'), { status: 400 });
  assert.throws(() => store.report(DAY.to, DAY.from), { status: 400 });
  assert.throws(() => store.report(DAY.from, DAY.from), { status: 400 });
  // Without a time zone the date is ambiguous, and "1" would silently become the year 2001.
  assert.throws(() => store.report('2026-03-02', '2026-03-03'), { status: 400 });
  assert.throws(() => store.report('1', '2'), { status: 400 });
  assert.doesNotThrow(() => store.report('2026-03-02T00:00:00+03:00', '2026-03-03T00:00:00+03:00'));
});

test('data survives a restart, including a running timer', () => {
  const first = openStore();
  const anna = first.addEmployee('Anna');
  first.startTimer(anna.id, 'Task before the restart');
  clock.advance(30);
  first.stopTimer(anna.id);
  first.startTimer(anna.id, 'Timer survived the restart');
  clock.advance(10);

  // "Restart": a new Store instance reads the same file from disk.
  const second = openStore();
  assert.equal(second.listEmployees()[0].running.task, 'Timer survived the restart');
  clock.advance(20);
  second.stopTimer(anna.id);

  const [row] = second.report(DAY.from, DAY.to).employees;
  assert.equal(row.entries.length, 2);
  assert.equal(row.totalMs, 60 * MINUTE);
});

test('a failed write changes nothing and the action can be retried', () => {
  const store = openStore();
  const anna = store.addEmployee('Anna');
  store.startTimer(anna.id, 'Task');
  clock.advance(30);

  fs.mkdirSync(`${file}.tmp`); // a directory where the temp file goes: every write fails
  assert.throws(() => store.stopTimer(anna.id));
  assert.throws(() => store.addEmployee('Boris'));
  assert.notEqual(store.listEmployees()[0].running, null);
  assert.equal(store.listEmployees().length, 1);

  fs.rmdirSync(`${file}.tmp`);
  store.stopTimer(anna.id);
  store.addEmployee('Boris');
  const reopened = openStore();
  assert.equal(reopened.listEmployees().length, 2);
  assert.equal(reopened.listEmployees()[0].running, null);
});

test('a corrupted data file is not overwritten', () => {
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => openStore(), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
});

test('a data file of the wrong shape fails with a clear error at startup', () => {
  fs.writeFileSync(file, JSON.stringify({ employees: {} }));
  assert.throws(() => openStore(), /wrong format/);
});

test('a data file with a BOM (Notepad, PowerShell 5) is read', () => {
  const data = { employees: [{ id: 'e1', name: 'Anna', createdAt: '2026-03-02T08:00:00.000Z' }], entries: [] };
  fs.writeFileSync(file, '﻿' + JSON.stringify(data));
  assert.equal(openStore().listEmployees()[0].name, 'Anna');
});

test('an entry without an end field counts as running everywhere', () => {
  fs.writeFileSync(file, JSON.stringify({
    employees: [{ id: 'e1', name: 'Anna', createdAt: '2026-03-02T08:00:00.000Z' }],
    entries: [{ id: 'x1', employeeId: 'e1', task: 'No end', start: '2026-03-02T08:30:00.000Z' }],
  }));
  const store = openStore();
  assert.equal(store.listEmployees()[0].running.task, 'No end');
  assert.throws(() => store.startTimer('e1', 'Second'), { status: 409 });
  store.stopTimer('e1');
  assert.equal(store.report(DAY.from, DAY.to).employees[0].totalMs, 30 * MINUTE);
});
