# Work Time Tracker

A small web app for tracking employees' working time (a test assignment).

## Features

The page has a panel at the top (add an employee, filters, grand total) and a card per employee: the timer, the time for the period and the entries. The number in brackets next to the name is the number of entries (or tasks in the "By task" view). Clicking the name folds and unfolds the entries; the timer always stays visible. Folded cards stay folded, and text typed into a task field is kept, when something else on the page changes.

- **Employees.** Add an employee. The name is required; duplicates (case-insensitive) are rejected.
- **Timer.** Start and stop with a task description, right in the card. An employee has at most one running timer: starting again while it runs is rejected. After a stop, a new start creates a new entry. Timers of different employees are independent.
- **Quick switching.** In the list of entries, the newest entry of each task has a button. With no timer running it is "Continue": the task starts again without retyping it, for example the next morning. With another task running it is "Switch": the current task stops and the chosen one starts at the same second. If another window changed the timer in the meantime, the switch is refused with a message and the page catches up, so it never stops a timer someone else started.
- **Entries and time for a period.** Filters: "from" and "to" dates and an employee. A date is typed as YYYY-MM-DD or picked in a small English calendar: the browser's own date picker follows the system language and a page can't switch it, so the app has its own. Empty dates mean all time, a single date leaves the other side of the period open, "Reset" clears everything. The list reloads on any filter change. Each card shows the employee's total for the period, the panel shows the grand total. Entries go from newest to oldest, the running entry is highlighted, and its time and the totals keep growing on screen. With no entries, the card says so.
- **"By task" view.** A switch in the filters shows one row per task: how many entries, when it was last started and how much time it took in the period. The data isn't changed, it is only another view of the same entries, and switching back to "By entry" shows them all. Merging entries in the data would be wrong: it would lose when exactly the person worked, and per-day reports would become incorrect.
- **Persistence.** Data is kept in `data/db.json`. A running timer is written to this file the moment it starts (an entry without an end), not kept only in the server's memory. So it survives a real stop and start of the server and keeps counting through the downtime.

## How "starting the timer again" and "an empty report" are handled

The task asks for tests of these two scenarios. This is how they are read and implemented:

- **Starting the timer again** means pressing Start for an employee once more:
  - while their timer is running, the second start is rejected (409) and no second entry appears: one person, one running timer. To change the task there is "Switch";
  - after a stop, starting again creates a new entry. Earlier entries stay as they were, and the totals add up.

  Restarting the app itself is covered too: a running timer is still running after the server is stopped and started again.
- **An empty report** is a report with nothing to show: no employees yet, no entries in the chosen period, or none for the chosen employee. The page says "No entries..." with a total of 0:00:00, and the API returns an empty list with `totalMs: 0`, not an error.

Other readings were left out on purpose: resetting a task's time to zero, deleting a task or an entry, or clearing the whole report. They change or delete recorded working time, which feeds into totals and pay, so they need clear rules first: who may do it, whether it can be undone, whether history is kept. They can be added in the next iteration once those requirements are agreed.

## Running

Requires Node.js 20 or newer (tested on 22). No external dependencies, no `npm install` needed.

```bash
npm start
```

Open http://localhost:3000.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | server port (`0` picks a free one) |
| `HOST` | `127.0.0.1` | address the server listens on; `0.0.0.0` opens it to the local network |
| `DATA_FILE` | `data/db.json` | data file |

Tests:

```bash
npm test
```

## Structure

```
src/store.js          data and rules: employees, timers, report, saving to the file
src/server.js         HTTP API on the built-in node:http, request checks, static files
src/index.js          entry point
public/               the page: HTML, CSS and JS without frameworks
public/time.js        period math, date parsing, grouping by task, live counters, duration format;
                      shared by the page and the tests
public/datepicker.js  the English calendar for the date filters
test/                 tests on the built-in node:test
```

### API

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/employees` | employees and their running timers (with the elapsed time by the server clock) |
| `POST` | `/api/employees` | add an employee, body `{ "name": "..." }` |
| `POST` | `/api/employees/:id/start` | start the timer, body `{ "task": "..." }` |
| `POST` | `/api/employees/:id/stop` | stop the timer |
| `POST` | `/api/employees/:id/switch` | stop the running timer (if any) and start a task, body `{ "task": "...", "runningId": "..." }`. `runningId` is the running entry the caller saw (`null` for none); if the timer has changed since, the answer is 409 |
| `GET` | `/api/report?from=<ISO>&to=<ISO>&employeeId=<id>` | entries and time for the period `[from, to)`; dates in ISO 8601 with a time zone, e.g. `2026-03-02T00:00:00+03:00`. All parameters are optional: no dates means all time, no `employeeId` means every employee |

POST requests are accepted only with `Content-Type: application/json`. Errors come back as `{ "error": "text" }` with status 400 (bad input), 403 (another site or host), 404 (not found), 405 (method not allowed), 409 (timer already running or not running, timer changed in another window, employee already exists), 413 (body too large), 415 (not JSON) or 500 (internal error).

### Design decisions

- **A JSON file for storage.** Enough for a small company, and the app runs without installing anything. A change is first applied to a copy of the data, written to a temp file, flushed to disk, and only then replaces the old file and the in-memory state. So neither a failed write nor a crash or power cut leaves memory and disk out of sync. The app never overwrites a corrupted file: it refuses to start and says what is wrong. For many concurrent users I would move to SQLite or PostgreSQL.
- **Periods and time zones.** The "from" and "to" dates are picked in the browser's time zone. The page turns them into exact instants (from 00:00 of the first day to 00:00 of the day after the last one) and sends them in UTC. Daylight saving days come out 23 and 25 hours long, as they should. The server only works with instants and doesn't depend on its own time zone.
- **Entries crossing the period edge.** An entry that crosses the edge (say 23:00-01:00) counts only for its part inside the period. The table shows it: "1:00:00 (of 2:00:00)". So two neighbouring days add up to the full time, not double. A running timer started before the period counts from the period start, and in a past period it stops at the period end.
- **Protection without authentication.** There is no login by the task's terms, but other websites open in the browser must not control the tracker. By default the server listens only on `127.0.0.1` and accepts only requests addressed to localhost (protection against DNS rebinding). POST requests with a foreign `Origin` are rejected. `Content-Type: application/json` is required, so a form or a `fetch` from another site can't get through without a CORS approval, which the server never gives.
- **Safe output.** Names and tasks are rendered with `textContent`, so HTML in them is never executed. Static files are served only from `public`.
- **Switching in one request.** Stopping the current task and starting the new one is a single data change. So the old task can never be stopped without the new one starting, and there is no gap or overlap between the entries.
- **One timer per employee.** A person works on one task at a time. With parallel timers, an 8-hour day would show 16 hours, and the total would no longer answer "how long did this person work". To move to another task there is the "Switch" button in the list of entries.

## What could come next

1. **Editing and deleting entries.** The most common need in time tracking: someone forgot to stop the timer and it ran for 14 hours overnight. How I would do it:
   - API: `PATCH /api/entries/:id` (task, start, end) and `DELETE /api/entries/:id`.
   - Checks: the end is after the start and not in the future. An entry doesn't overlap other entries of the same employee, or the time would be counted twice. A running entry can only have its task and start changed.
   - UI: an "Edit" button in the entry row and a form with date and time fields.
   - Tests for every check and for the totals after an edit.
2. **A hint about a forgotten timer.** If a timer runs longer than a working day (say 10 hours), highlight it in the employee's card. This prevents the mistake that item 1 fixes.
3. **Personal accounts and roles.** This is beyond the task, which says authentication and roles aren't needed. Right now anyone who opens the page controls everyone's timers. For a real company the next step would be:
   - login and two roles: an employee starts and stops only their own timer, a manager sees everyone and edits entries;
   - the manager's timers and report update in real time via Server-Sent Events, without reloading the page;
   - a session cookie with `SameSite`, and HTTPS, because the server becomes reachable over the network.
4. **A database and deployment.** The data is already not tied to the user's device: it lives on the server, and any browser that can reach it sees the same thing. It is only tied to the machine the server runs on. For the whole company to use the app, it needs to be deployed to a server (for example in Docker), with PostgreSQL instead of the JSON file. The database brings concurrent writes, backups and the option to run several server instances.
5. **Exporting the report to CSV** for accounting or timesheets.

## AI tools and models

- **Claude Code** (the Claude desktop app) with the **Claude Opus 5.5** model. It wrote the code, the tests and this README, ran the tests, checked the UI in its built-in browser, and fixed the review findings.
- **A separate Claude Code agent** on the same model, run twice: once on the first version and once after the UI was reworked. It reviewed the code without seeing how it was built and reproduced its findings with scripts and in the browser.

## Example prompts

The prompts were written in Russian; they are translated here.

1. The main prompt, with the task text attached:

   > do what the task says, don't overcomplicate it, but it must fully cover the needs

2. The independent review prompt:

   > Review a small web app for tracking working time (Node.js without dependencies: src/store.js - JSON file storage and the timer and report logic, src/server.js - HTTP API, public/app.js - the UI, test/ - tests on node:test). [...] Find real bugs: wrong time and period boundary calculations, time zones, data loss or corruption, wrong error and input handling, security issues (XSS, reading files outside public), and important scenarios not covered by tests. No style or taste remarks. For each finding: file and line, a concrete scenario to reproduce it, why it is a bug, and a suggested fix.

   Each review report went back to the main agent, which fixed the findings and wrote a test for each one. For the key fixes it then put the old code back on a copy of the project and confirmed that the new test fails on it.

3. Prompts that set requirements for the checks:

   > Restarting the app must be checked not only by a test that simulates a restart, but by really stopping and starting the server. The running timer must be saved in persistent storage, not only in the process memory. The report must correctly count entries that cross the edges of the selected period. Tests must check how the app behaves, not just that the right functions exist.

4. Prompts from iterating on the UI:

   > maybe it makes sense to merge the sections: right now an employee appears 3 times on the page. Maybe one section is enough, with filters that show all tasks for all time when they aren't set?

   > maybe merge all identical tasks into one with a single button?

   For the last one the agent advised against merging entries in the data (it loses when the work happened and breaks per-day reports) and suggested the "By task" view instead.

## Bugs found and fixed

Only the significant ones are listed; smaller layout and wording fixes are left out.

### Found while checking the UI in the browser

1. **Totals froze on a running timer.** In the employee list the timer ticked, but in the report the same entry and the totals stayed at 0:00:00 until the next action. Cause: the report was drawn once from the server data. Fix: the time of running entries, the employee total and the grand total now grow on screen every second, and stop at the end of the selected period so a report for past days doesn't "run away".

### Found by the first independent review

2. **A failed write left the change in memory.** The in-memory data changed before the file was written. If the write failed (on Windows an antivirus can hold the file), the client got a 500, and a retry hit "The timer is not running". After a restart the timer was running again, and the report counted extra hours. Fix: the change is applied to a copy and accepted only after a successful write, so the action can simply be retried.
3. **Non-ASCII letters were corrupted when the request body arrived in chunks.** Each chunk was turned into a string separately. If a chunk boundary fell inside a letter, a name with a broken letter (U+FFFD replacement characters) was saved for good. The reviewer reproduced it with a Cyrillic name. Fix: the chunks are joined as bytes and decoded once. A test sends the body through a socket in two chunks split inside "ë".
4. **Any website could write to the tracker through the user's browser.** This is CSRF plus DNS rebinding. The server parsed the body as JSON with any `Content-Type` and ignored `Origin` and `Host`, so a foreign page could add employees and start timers. Fix: `application/json` is required, `Origin` and `Host` are checked, and by default the server listens only on `127.0.0.1`.
5. **When the server clock was moved back, time went negative.** An entry ending before its start had a negative duration and reduced the total. Fix: an entry can't end before it starts, and time in a period is never negative.
6. **A failed static file read crashed the whole server.** An error while streaming a file from `public` was unhandled and stopped the process for everyone. Fix: the file is read inside the common error handler, which answers 500 and keeps the server running.

### Found by the second independent review

7. **"Continue" on an out-of-date page silently stopped a timer started elsewhere.** The page still showed an employee as idle; meanwhile another window started their timer. "Continue" stopped that timer without a word and started a different task. Fix: the page sends which running entry it saw (`runningId`); if the timer has changed, the server refuses with 409, and the page shows a message and catches up.
8. **Every redraw wiped what was typed in other cards.** Starting or stopping a timer in one card, or changing a filter, redrew all cards, so a half-typed task in another card was lost and a keyboard user lost their place. Fix: the page keeps typed text and focus across redraws; after Start the focus goes to Stop, after Stop to the task field.

## Verification

The automated tests (`npm test`, 46 of them) check how the app behaves through its storage, its HTTP API and a real server process:

- **a real restart:** the test starts `node src/index.js` as a separate process, starts a timer over HTTP and kills the process. It then checks that the data file holds the running entry, starts the server again, and confirms the timer is still running and can be stopped;
- **starting the timer again:** while it runs a start is rejected and no second entry is created, and after a stop a new start creates a new entry and the time adds up;
- **an empty report:** with no employees, with no entries in the period, and for an employee with no entries;
- **entries crossing the period edge:** an entry across midnight, in the storage and over HTTP (also seen from UTC+3); entries ending exactly at the period start and starting exactly at its end; a running timer started before the period; a past period with a running timer;
- adding an employee, an empty name and duplicates; start and stop, a missing task description, a stop without a running timer, an unknown employee;
- switching tasks: no gap or overlap, switching to the task already running is rejected, a switch from an out-of-date page is refused, continuing the next day is a separate entry;
- a report for one employee; an optional period (no dates means all time, one date leaves the other side open); an invalid or ambiguous period;
- the clock being moved back; a failed write to disk and retrying the action; a corrupted file, a file of the wrong shape, a file with a BOM, an entry without `end`;
- page logic: period math in a time zone with daylight saving (23- and 25-hour days), typed dates, grouping by task, live counters stopping at the period end;
- HTTP: error codes, a body that is too large, a body split inside a letter, requests from other sites, attempts to read outside `public`.

Checked by hand as well:

- **A real restart of the running app.** With a timer running, the server was stopped (requests got "connection refused") and the data file showed the entry with no end. After the server was started again, the timer was still running with its original start time and could be stopped.
- **The UI in the browser** at desktop width and at phone width (375 px), with the mouse and the keyboard.

All data in the app and the tests is fictional.
