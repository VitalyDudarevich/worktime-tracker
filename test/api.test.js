import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createServer } from '../src/server.js';

let server;
let port;
let dataFile;

before(async () => {
  dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worktime-api-')), 'db.json');
  server = createServer(new Store(dataFile));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => server.close());

// fetch, the way the page talks to the server.
async function call(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// node:http, for what fetch won't send: a custom Host header or an unnormalized path.
function raw({ method = 'GET', path: target, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: target, headers: { host: `localhost:${port}`, ...headers } },
      res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('full flow over HTTP: employee, timer, report', async () => {
  const created = await call('POST', '/api/employees', { name: 'Vera Smith' });
  assert.equal(created.status, 201);
  const id = created.data.id;

  assert.equal((await call('POST', `/api/employees/${id}/start`, { task: 'Client call' })).status, 201);

  const again = await call('POST', `/api/employees/${id}/start`, { task: 'Another task' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /already running/);

  const list = await call('GET', '/api/employees');
  assert.equal(list.data[0].running.task, 'Client call');
  assert.equal(typeof list.data[0].running.elapsedMs, 'number');

  assert.equal((await call('POST', `/api/employees/${id}/stop`)).status, 200);
  assert.equal((await call('POST', `/api/employees/${id}/stop`)).status, 409);

  // Quick switching: continue a task, then switch to another one.
  assert.equal((await call('POST', `/api/employees/${id}/switch`, { task: 'Client call' })).status, 201);
  assert.equal((await call('POST', `/api/employees/${id}/switch`, { task: 'Client call' })).status, 409);
  assert.equal((await call('POST', `/api/employees/${id}/switch`, { task: 'Follow-up email' })).status, 201);
  assert.equal((await call('GET', '/api/employees')).data[0].running.task, 'Follow-up email');
  // "Continue" from a page that still thinks nothing is running: refused, the running timer stays.
  const stale = await call('POST', `/api/employees/${id}/switch`, { task: 'Client call', runningId: null });
  assert.equal(stale.status, 409);
  assert.equal((await call('GET', '/api/employees')).data[0].running.task, 'Follow-up email');
  assert.equal((await call('POST', `/api/employees/${id}/stop`)).status, 200);

  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() + 3_600_000).toISOString();
  const report = await call('GET', `/api/report?${new URLSearchParams({ from, to })}`);
  assert.equal(report.status, 200);
  assert.deepEqual(
    report.data.employees[0].entries.map(e => e.task),
    ['Client call', 'Client call', 'Follow-up email'],
  );

  const other = (await call('POST', '/api/employees', { name: 'Glen Orr' })).data;
  const byEmployee = async employeeId =>
    call('GET', `/api/report?${new URLSearchParams({ from, to, employeeId })}`);
  assert.deepEqual((await byEmployee(id)).data.employees.map(e => e.name), ['Vera Smith']);
  assert.deepEqual((await byEmployee(other.id)).data.employees[0].entries, []);
  assert.equal((await byEmployee('')).data.employees.length, 2); // empty filter: everyone
  assert.equal((await byEmployee('unknown')).status, 404);

  // No dates: the report covers all time.
  const allTime = await call('GET', '/api/report');
  assert.equal(allTime.status, 200);
  assert.equal(allTime.data.from, null);
  assert.equal(allTime.data.employees.length, 2);

  // The data reached the file on disk.
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.entries.length, 3);
});

test('over HTTP, an entry crossing the period edge counts only for its part inside the period', async () => {
  const HOUR = 3_600_000;
  let nowMs = Date.parse('2026-03-02T23:00:00.000Z');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worktime-edge-')), 'db.json');
  const edgeServer = createServer(new Store(file, { now: () => new Date(nowMs) }));
  await new Promise(resolve => edgeServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${edgeServer.address().port}`;
  const send = async (method, url, body) => (await fetch(base + url, {
    method,
    headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  })).json();
  const total = async (from, to) => (await send('GET', `/api/report?${new URLSearchParams({ from, to })}`)).employees[0];

  try {
    const anna = await send('POST', '/api/employees', { name: 'Anna' });
    await send('POST', `/api/employees/${anna.id}/start`, { task: 'Night release' });
    nowMs += 2 * HOUR; // 23:00 -> 01:00 UTC the next day
    await send('POST', `/api/employees/${anna.id}/stop`);

    const day1 = await total('2026-03-02T00:00:00.000Z', '2026-03-03T00:00:00.000Z');
    assert.equal(day1.totalMs, HOUR);
    assert.equal(day1.entries[0].durationMs, 2 * HOUR);
    assert.equal((await total('2026-03-03T00:00:00.000Z', '2026-03-04T00:00:00.000Z')).totalMs, HOUR);
    assert.equal((await total('2026-03-02T00:00:00.000Z', '2026-03-04T00:00:00.000Z')).totalMs, 2 * HOUR);
    // The same night seen from UTC+3: 02:00-04:00 on 3 March, fully inside that local day.
    assert.equal((await total('2026-03-03T00:00:00+03:00', '2026-03-04T00:00:00+03:00')).totalMs, 2 * HOUR);
  } finally {
    edgeServer.close();
  }
});

test('bad input gets a clear status', async () => {
  assert.equal((await call('POST', '/api/employees', '{ broken')).status, 400);
  assert.equal((await call('POST', '/api/employees', { name: '' })).status, 400);
  assert.equal((await call('POST', '/api/employees/unknown/start', { task: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/employees/unknown/stop')).status, 404);
  assert.equal((await call('GET', '/api/report?from=bad&to=bad')).status, 400);
  assert.equal((await call('GET', '/api/report?from=2026-03-02')).status, 400); // no time zone
  assert.equal((await call('GET', '/api/nothing')).status, 404);
});

test('a request body that is too large gets 413, and the response reaches the client', async () => {
  const res = await raw({
    method: 'POST',
    path: '/api/employees',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x'.repeat(20_000) }),
  });
  assert.equal(res.status, 413);
});

test('a non-ASCII letter survives a body that arrives in two chunks split inside it', async () => {
  const body = Buffer.from(JSON.stringify({ name: 'Zoë' }));
  const cut = body.indexOf(Buffer.from('ë')) + 1; // between the two bytes of "ë"
  const status = await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(Number(response.split(' ')[1])));
    socket.on('error', reject);
    socket.write(
      `POST /api/employees HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
    );
    socket.write(body.subarray(0, cut));
    setTimeout(() => socket.write(body.subarray(cut)), 50);
  });
  assert.equal(status, 201);
  const names = (await call('GET', '/api/employees')).data.map(e => e.name);
  assert.ok(names.includes('Zoë'), `saved names: ${names.join(', ')}`);
});

test('requests from other sites are rejected', async () => {
  const post = headers => raw({ method: 'POST', path: '/api/employees', headers, body: '{"name":"Intruder"}' });

  // A form or a no-cors fetch from another site can't send application/json without a preflight.
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ 'content-type': 'application/json', origin: 'http://evil.example' })).status, 403);
  // DNS rebinding: a page on a foreign domain that points to 127.0.0.1.
  assert.equal((await raw({ path: '/api/employees', headers: { host: `evil.example:${port}` } })).status, 403);

  const names = (await call('GET', '/api/employees')).data.map(e => e.name);
  assert.ok(!names.includes('Intruder'));

  // A request from the app's own page goes through.
  const own = await post({ 'content-type': 'application/json', origin: `http://localhost:${port}` });
  assert.equal(own.status, 201);
});

test('a garbage URL gets 400, and nothing outside public can be read', async () => {
  assert.equal((await raw({ path: '//[' })).status, 400);
  for (const target of ['/../package.json', '/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/..\\package.json', '/CON', '/src/store.js']) {
    assert.equal((await raw({ path: target })).status, 404, target);
  }
});

test('serves the app page and its modules', async () => {
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Work Time Tracker/);

  const script = await fetch(`http://127.0.0.1:${port}/time.js`);
  assert.match(script.headers.get('content-type'), /javascript/);
});
