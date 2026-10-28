import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Error with an HTTP status, so the server can answer 400/404/409 without guessing.
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME_MAX = 100;
const TASK_MAX = 200;
// Only full timestamps with an explicit zone: a bare "2026-03-02" would silently mean UTC midnight.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const isRunning = entry => entry.end == null;

/**
 * Employees and time entries kept in a JSON file.
 * An entry is { id, employeeId, task, start, end }, where end === null means the timer is running.
 */
export class Store {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.data = load(file);
  }

  listEmployees() {
    const nowMs = this.now().getTime();
    return this.data.employees.map(employee => {
      const running = runningEntry(this.data, employee.id);
      return {
        ...employee,
        // Elapsed time by the server clock, so the page doesn't depend on the browser's clock.
        running: running ? { ...running, elapsedMs: Math.max(0, nowMs - Date.parse(running.start)) } : null,
      };
    });
  }

  addEmployee(name) {
    const clean = requiredText(name, 'Employee name', NAME_MAX);
    return this.#change(data => {
      const existing = data.employees.find(e => e.name.toLowerCase() === clean.toLowerCase());
      if (existing) throw new AppError(409, `Employee "${existing.name}" already exists`);
      const employee = { id: randomUUID(), name: clean, createdAt: this.now().toISOString() };
      data.employees.push(employee);
      return employee;
    });
  }

  startTimer(employeeId, task) {
    return this.#change(data => {
      findEmployee(data, employeeId);
      const cleanTask = requiredText(task, 'Task description', TASK_MAX);
      if (runningEntry(data, employeeId)) {
        throw new AppError(409, 'The timer is already running. Stop it before starting a new task');
      }
      return startEntry(data, employeeId, cleanTask, this.now());
    });
  }

  stopTimer(employeeId) {
    return this.#change(data => {
      findEmployee(data, employeeId);
      const entry = runningEntry(data, employeeId);
      if (!entry) throw new AppError(409, 'The timer is not running');
      return finishEntry(entry, this.now());
    });
  }

  /**
   * Starts `task` now, first stopping the employee's running timer if there is one.
   * Both happen in one change, so a switch never stops the old task without starting the new one.
   * `expectedRunningId` is the running entry the caller saw (null for none). If another window has
   * started or stopped a timer since, the switch is refused instead of silently stopping that timer.
   */
  switchTask(employeeId, task, expectedRunningId) {
    return this.#change(data => {
      findEmployee(data, employeeId);
      const cleanTask = requiredText(task, 'Task description', TASK_MAX);
      const running = runningEntry(data, employeeId);
      if (expectedRunningId !== undefined && (running?.id ?? null) !== expectedRunningId) {
        throw new AppError(409, 'The timer was changed in another window. The page is up to date now, try again');
      }
      if (running?.task === cleanTask) throw new AppError(409, 'This task is already running');
      const now = this.now();
      if (running) finishEntry(running, now);
      return startEntry(data, employeeId, cleanTask, now);
    });
  }

  /**
   * Entries that overlap [from, to) and the time spent inside that period,
   * for every employee or only for `employeeId` when it is given.
   * Either date may be omitted: the period is then open on that side, and with neither
   * the report covers all time.
   * An entry crossing the period edge counts only its part inside the period;
   * a running entry counts up to now.
   */
  report(from, to, employeeId) {
    const fromMs = from ? parseInstant(from, 'Period start') : -Infinity;
    const toMs = to ? parseInstant(to, 'Period end') : Infinity;
    if (fromMs >= toMs) throw new AppError(400, 'The period start must be before its end');
    const selected = employeeId ? [findEmployee(this.data, employeeId)] : this.data.employees;
    const nowMs = this.now().getTime();

    const employees = selected.map(employee => {
      const entries = this.data.entries
        .filter(entry => entry.employeeId === employee.id)
        .map(entry => {
          const startMs = Date.parse(entry.start);
          // An end before the start (clock moved back) counts as zero, never as negative time.
          const endMs = Math.max(startMs, isRunning(entry) ? nowMs : Date.parse(entry.end));
          const inPeriod = startMs < toMs && (endMs > fromMs || startMs >= fromMs);
          if (!inPeriod) return null;
          return {
            ...entry,
            durationMs: endMs - startMs,
            periodMs: Math.max(0, Math.min(endMs, toMs) - Math.max(startMs, fromMs)),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.start.localeCompare(b.start));
      return { id: employee.id, name: employee.name, entries, totalMs: sum(entries) };
    });

    return {
      from: from ? new Date(fromMs).toISOString() : null,
      to: to ? new Date(toMs).toISOString() : null,
      employees,
      totalMs: employees.reduce((acc, e) => acc + e.totalMs, 0),
    };
  }

  // Applies a change to a copy and keeps it only once it is on disk,
  // so a failed write leaves memory and the file in the same state and the action can be retried.
  #change(mutate) {
    const next = structuredClone(this.data);
    const result = mutate(next);
    save(this.file, next);
    this.data = next;
    return result;
  }
}

function findEmployee(data, id) {
  const employee = data.employees.find(e => e.id === id);
  if (!employee) throw new AppError(404, 'Employee not found');
  return employee;
}

function runningEntry(data, employeeId) {
  return data.entries.find(e => e.employeeId === employeeId && isRunning(e));
}

function startEntry(data, employeeId, task, now) {
  const entry = { id: randomUUID(), employeeId, task, start: now.toISOString(), end: null };
  data.entries.push(entry);
  return entry;
}

// If the clock was moved back while the timer ran, end at the start rather than before it.
function finishEntry(entry, now) {
  const start = new Date(entry.start);
  entry.end = (now < start ? start : now).toISOString();
  return entry;
}

// Writes a temp file, flushes it to disk and renames it over the old one,
// so neither a crash nor a power cut leaves a half-written data file.
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function load(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { employees: [], entries: [] };
    throw err;
  }
  // Refuse to start rather than overwrite the user's data with an empty file.
  let data;
  try {
    // Notepad and PowerShell 5 can save UTF-8 with a BOM, which JSON.parse rejects.
    data = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Data file ${file} is not valid JSON. Fix it or restore it from a backup.`);
  }
  const employees = data?.employees ?? [];
  const entries = data?.entries ?? [];
  if (!Array.isArray(employees) || !Array.isArray(entries)) {
    throw new Error(`Data file ${file} has the wrong format: employees and entries must be arrays.`);
  }
  return { employees, entries };
}

function requiredText(value, label, max) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if (!clean) throw new AppError(400, `${label} is required`);
  if (clean.length > max) throw new AppError(400, `${label} must be at most ${max} characters`);
  return clean;
}

function parseInstant(value, label) {
  const ms = typeof value === 'string' && ISO_INSTANT.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw new AppError(400, `${label} must be an ISO 8601 date and time with a time zone`);
  }
  return ms;
}

function sum(entries) {
  return entries.reduce((acc, e) => acc + e.periodMs, 0);
}
