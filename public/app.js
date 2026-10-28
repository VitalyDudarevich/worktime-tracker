import { dayRange, formatDuration, groupByTask, liveMs } from './time.js';
import { attachDatePicker } from './datepicker.js';

const $ = selector => document.querySelector(selector);
const filters = $('#filters').elements;

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

// ---------- helpers ----------

// Builds DOM nodes with textContent, so names and tasks are never parsed as HTML.
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(child => child != null));
  return node;
}

// "29 Oct 2026": English and unambiguous, unlike 10/29 vs 29/10.
const formatDate = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const formatTime = iso => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function showMessage(text) {
  const box = $('#message');
  box.textContent = text;
  box.hidden = !text;
}

// Runs an action, then refreshes the screen. On an error the message is shown and the screen is
// still refreshed, so a page that was out of date (another window changed a timer) catches up.
async function act(action) {
  showMessage('');
  try {
    await action();
    await refresh();
  } catch (err) {
    showMessage(err.message);
    refresh().catch(() => {});
  }
}

// A duration that keeps growing on screen while timers run (see liveMs in time.js).
function liveDuration(baseMs, { rate = 0, since = Date.now(), until = Infinity, className = '' } = {}) {
  const node = el('span', { className: `duration ${className}`.trim() });
  Object.assign(node.dataset, { base: baseMs, rate, since, until });
  tick(node);
  return node;
}

function tick(node) {
  const { base, rate, since, until } = node.dataset;
  node.textContent = formatDuration(liveMs(Number(base), Number(rate), Number(since), Number(until), Date.now()));
}

setInterval(() => document.querySelectorAll('.duration').forEach(tick), 1000);

// ---------- loading ----------

// Empty dates mean an open period: no dates at all is the whole history. No employee means everyone.
function filterQuery() {
  const { from, to, employeeId } = Object.fromEntries(new FormData($('#filters')));
  return { ...dayRange(from, to), ...(employeeId && { employeeId }) };
}

// Don't leave the previous numbers on screen under an error: they could be taken for the answer.
function clearList() {
  $('#employees').replaceChildren();
  $('#grand-total').replaceChildren('-');
}

let refreshSeq = 0;

async function refresh() {
  const seq = ++refreshSeq;
  let employees;
  let report;
  try {
    const query = filterQuery();
    [employees, report] = await Promise.all([
      api('/api/employees'),
      api(`/api/report?${new URLSearchParams(query)}`),
    ]);
  } catch (err) {
    if (seq === refreshSeq) clearList();
    throw err;
  }
  // Filters can change faster than the server answers: only the newest answer is drawn.
  if (seq !== refreshSeq) return;
  fillEmployeeFilter(employees);
  const kept = captureCards();
  render(employees, report);
  restoreCards(kept);
}

// Keeps the employee filter in sync, preserving the current choice.
function fillEmployeeFilter(employees) {
  const select = filters.employeeId;
  const current = select.value;
  select.replaceChildren(
    el('option', { value: '', textContent: 'All employees' }),
    ...employees.map(e => el('option', { value: e.id, textContent: e.name })),
  );
  select.value = employees.some(e => e.id === current) ? current : '';
}

// ---------- keeping what the user had across a re-render ----------

// Every action redraws the cards. Remember what was typed into the task fields and which control
// had focus, so an action in one card doesn't wipe a half-typed task in another or lose the keyboard user.
function captureCards() {
  const drafts = new Map([...document.querySelectorAll('#employees input[name=task]')]
    .map(input => [input.dataset.employee, input.value]));
  const focused = document.activeElement?.closest?.('#employees [data-focus]')?.dataset.focus;
  return { drafts, focused };
}

// Where focus goes after the redraw: after Start (or Continue/Switch) the card shows Stop, after Stop the task field.
const NEXT_FOCUS = { start: 'stop', resume: 'stop', stop: 'task', task: 'task', toggle: 'toggle' };

function restoreCards({ drafts, focused }) {
  for (const input of document.querySelectorAll('#employees input[name=task]')) {
    input.value = drafts.get(input.dataset.employee) ?? '';
  }
  if (!focused) return;
  const [id, role] = focused.split(':');
  for (const candidate of [NEXT_FOCUS[role], 'stop', 'task', 'toggle']) {
    const target = document.querySelector(`#employees [data-focus="${id}:${candidate}"]`);
    if (target) return target.focus();
  }
}

// ---------- rendering: one card per employee ----------

// Employees whose entries are folded. Kept across re-renders, so an action elsewhere doesn't unfold them.
const collapsed = new Set();

function render(employees, report) {
  // Running timers keep counting on screen until the end of the period (if it has one).
  const live = { since: Date.now(), until: report.to ? Date.parse(report.to) : Infinity };
  const runningCount = entries => entries.filter(entry => !entry.end).length;

  $('#grand-total').replaceChildren(liveDuration(report.totalMs, {
    ...live,
    rate: runningCount(report.employees.flatMap(e => e.entries)),
  }));
  $('#empty').hidden = employees.length > 0;

  const byId = new Map(employees.map(e => [e.id, e]));
  const periodSet = Boolean(report.from || report.to);
  const byTask = filters.view.value === 'tasks';
  // An employee added by another window between the two requests shows up on the next refresh.
  $('#employees').replaceChildren(...report.employees.filter(row => byId.has(row.id)).map(row => {
    const employee = byId.get(row.id);
    const list = row.entries.length === 0
      ? el('p', { className: 'muted', textContent: periodSet ? 'No entries for the selected period.' : 'No entries yet.' })
      : byTask ? tasksTable(employee, row.entries, live) : entriesTable(employee, row.entries, live);
    list.id = `list-${row.id}`;
    const count = byTask ? new Set(row.entries.map(e => e.task)).size : row.entries.length;
    return el('section', { className: `card employee${employee.running ? ' running' : ''}` },
      el('div', { className: 'card-head' },
        el('h2', {}, collapseToggle(row, `${row.name} (${count})`, list)),
        el('span', { className: 'total' }, 'Total: ', liveDuration(row.totalMs, { ...live, rate: runningCount(row.entries) })),
      ),
      timer(employee),
      list,
    );
  }));
}

// The employee's name folds and unfolds the entries; the timer above them always stays visible.
function collapseToggle(row, label, list) {
  const toggle = el('button', { type: 'button', className: 'toggle' },
    el('span', { className: 'chevron', textContent: '▶' }), label);
  toggle.firstChild.setAttribute('aria-hidden', 'true');
  toggle.setAttribute('aria-controls', list.id);
  toggle.dataset.focus = `${row.id}:toggle`;
  const show = open => {
    list.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  show(!collapsed.has(row.id));
  toggle.onclick = () => {
    const open = list.hidden;
    if (open) collapsed.delete(row.id);
    else collapsed.add(row.id);
    show(open);
  };
  return toggle;
}

// The running task with a Stop button, or a field to start a new one.
function timer(employee) {
  if (employee.running) {
    const stop = el('button', {
      type: 'button',
      className: 'stop',
      textContent: 'Stop',
      onclick: () => act(() => post(`/api/employees/${employee.id}/stop`)),
    });
    stop.dataset.focus = `${employee.id}:stop`;
    return el('div', { className: 'timer running' },
      el('span', { className: 'task', textContent: employee.running.task }),
      // The current run only; the "by task" view sums all runs of the task.
      el('span', { className: 'now' }, 'current task ', liveDuration(employee.running.elapsedMs, { rate: 1, className: 'elapsed' })),
      stop,
    );
  }

  const task = el('input', { name: 'task', placeholder: 'Task name', maxLength: 200, required: true });
  task.setAttribute('aria-label', `Task for ${employee.name}`);
  Object.assign(task.dataset, { employee: employee.id, focus: `${employee.id}:task` });
  const start = el('button', { type: 'submit', className: 'start', textContent: 'Start' });
  start.dataset.focus = `${employee.id}:start`;
  return el('form', {
    className: 'row timer',
    onsubmit: event => {
      event.preventDefault();
      act(() => post(`/api/employees/${employee.id}/start`, { task: task.value }));
    },
  }, task, start);
}

// Newest first, so a running timer and today's work are at the top; the running row is highlighted.
// The newest row of each task gets a button to continue that task, or to switch to it
// when another one is running.
function entriesTable(employee, entries, live) {
  const header = ['Date', 'Task', 'Start', 'End', 'Time', '']
    .map(text => el('th', { className: text === 'Time' ? 'num' : '', textContent: text }));
  const newestFirst = [...entries].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  const seenTasks = new Set([employee.running?.task]);
  return el('table', { className: 'entries' },
    el('thead', {}, el('tr', {}, ...header)),
    el('tbody', {}, ...newestFirst.map(entry => {
      const newestOfTask = !seenTasks.has(entry.task);
      seenTasks.add(entry.task);
      return el('tr', { className: entry.end ? '' : 'running' },
        el('td', { textContent: formatDate(entry.start) }),
        el('td', { textContent: entry.task }),
        el('td', { textContent: formatTime(entry.start) }),
        el('td', { textContent: entry.end ? endLabel(entry) : 'running' }),
        el('td', { className: 'num' }, entry.end
          ? durationLabel(entry)
          : liveDuration(entry.periodMs, { ...live, rate: 1 })),
        el('td', { className: 'action' }, newestOfTask ? taskButton(employee, entry.task) : null),
      );
    })),
  );
}

// "By task" view: one row per task with its time for the period, the running task highlighted.
function tasksTable(employee, entries, live) {
  const header = ['Task', 'Entries', 'Last start', 'Total', '']
    .map(text => el('th', { className: ['Entries', 'Total'].includes(text) ? 'num' : '', textContent: text }));
  return el('table', { className: 'tasks' },
    el('thead', {}, el('tr', {}, ...header)),
    el('tbody', {}, ...groupByTask(entries).map(group => el('tr', { className: group.running ? 'running' : '' },
      el('td', { textContent: group.task }),
      el('td', { className: 'num', textContent: group.count }),
      el('td', { textContent: formatDate(group.lastStart) }),
      el('td', { className: 'num' }, liveDuration(group.periodMs, { ...live, rate: group.running ? 1 : 0 })),
      el('td', { className: 'action' }, group.task === employee.running?.task ? null : taskButton(employee, group.task)),
    ))),
  );
}

// One request on the server: stops the running task (if any) and starts this one. It also says which
// timer this page saw running, so a page that is out of date can't silently stop a timer started elsewhere.
function taskButton(employee, task) {
  const busy = Boolean(employee.running);
  // On a phone only the icon is shown (see style.css); the aria-label always carries the full text.
  const button = el('button', {
    type: 'button',
    className: 'continue',
    onclick: () => act(() => post(`/api/employees/${employee.id}/switch`, { task, runningId: employee.running?.id ?? null })),
  },
  el('span', { textContent: busy ? '⇄' : '▶' }),
  el('span', { className: 'label', textContent: busy ? ' Switch' : ' Continue' }));
  const verb = busy ? 'Switch to task' : 'Continue task';
  button.setAttribute('aria-label', `${verb} "${task}" for ${employee.name}`);
  button.dataset.focus = `${employee.id}:resume`;
  return button;
}

function endLabel(entry) {
  const sameDay = formatDate(entry.start) === formatDate(entry.end);
  return sameDay ? formatTime(entry.end) : `${formatDate(entry.end)} ${formatTime(entry.end)}`;
}

// An entry crossing the period edge shows the part inside the period and, below it, its full length.
function durationLabel(entry) {
  const inPeriod = formatDuration(entry.periodMs);
  if (entry.periodMs >= entry.durationMs) return inPeriod;
  return el('span', {}, inPeriod, el('span', { className: 'of', textContent: `(of ${formatDuration(entry.durationMs)})` }));
}

// ---------- start ----------

$('#add-employee').addEventListener('submit', event => {
  event.preventDefault();
  const input = event.target.elements.name;
  act(async () => {
    await post('/api/employees', { name: input.value });
    input.value = '';
  });
});

attachDatePicker(filters.from);
attachDatePicker(filters.to);

// The list follows the filters: any change (a picked or typed date, the employee, the view) reloads it.
$('#filters').addEventListener('change', () => act(() => {}));
// "Reset" clears the fields; the change event doesn't fire for that, so reload after the reset.
$('#filters').addEventListener('reset', () => setTimeout(() => $('#filters').dispatchEvent(new Event('change'))));
$('#filters').addEventListener('submit', event => event.preventDefault());

act(() => {});
