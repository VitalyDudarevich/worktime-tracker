import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Starts the real app (`node src/index.js`) as a separate process on a free port.
function startApp(dataFile) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, PORT: '0', DATA_FILE: dataFile } });
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/http:\/\/localhost:(\d+)/);
      if (match) resolve({ child, base: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => reject(new Error(`the app exited with code ${code}: ${output}`)));
  });
}

// Kills the process outright, like closing the console or a crash: no chance to save anything on the way out.
function killApp(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    child.kill();
  });
}

const post = (base, url, body = {}) => fetch(base + url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a running timer survives a real stop and start of the server process', async () => {
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worktime-restart-')), 'db.json');

  // First run: add an employee and start a timer.
  let app = await startApp(dataFile);
  let employee;
  try {
    employee = await (await post(app.base, '/api/employees', { name: 'Anna' })).json();
    assert.equal((await post(app.base, `/api/employees/${employee.id}/start`, { task: 'Before the restart' })).status, 201);
  } finally {
    await killApp(app.child);
  }

  // The process is gone, so the running timer can only be in the data file.
  const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.deepEqual(onDisk.entries.map(e => [e.task, e.end]), [['Before the restart', null]]);

  // Second run: the employee and the running timer are back, and the timer can be stopped.
  app = await startApp(dataFile);
  try {
    const [restored] = await (await fetch(`${app.base}/api/employees`)).json();
    assert.equal(restored.name, 'Anna');
    assert.equal(restored.running.task, 'Before the restart');

    assert.equal((await post(app.base, `/api/employees/${employee.id}/stop`)).status, 200);
    const report = await (await fetch(`${app.base}/api/report`)).json();
    const [entry] = report.employees[0].entries;
    assert.equal(entry.task, 'Before the restart');
    assert.notEqual(entry.end, null);
    assert.ok(Date.parse(entry.end) >= Date.parse(entry.start));
  } finally {
    await killApp(app.child);
  }
});
