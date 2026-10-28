import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './store.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const MAX_BODY_BYTES = 10_000;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * localOnly: accept only requests addressed to localhost. Together with the Origin and
 * Content-Type checks this keeps other websites open in the user's browser from writing
 * to the tracker (CSRF) or reading it through DNS rebinding.
 */
export function createServer(store, { localOnly = true } = {}) {
  return http.createServer(async (req, res) => {
    try {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        throw new AppError(400, 'Invalid URL');
      }
      checkCaller(req, localOnly);
      if (url.pathname.startsWith('/api/')) {
        await handleApi(store, req, res, url);
      } else if (req.method === 'GET') {
        await serveStatic(res, url.pathname);
      } else {
        sendJson(res, 405, { error: 'Method not allowed' });
      }
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
}

function checkCaller(req, localOnly) {
  const host = req.headers.host ?? '';
  if (localOnly && !LOCAL_HOSTS.has(host.replace(/:\d+$/, ''))) {
    throw new AppError(403, 'Only requests to localhost are allowed');
  }
  if (req.method !== 'POST') return;
  const origin = req.headers.origin;
  if (origin && originHost(origin) !== host) {
    throw new AppError(403, 'Requests from other sites are not allowed');
  }
  // A cross-site form or no-cors fetch can't send application/json without a CORS preflight,
  // and the server never approves one.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new AppError(415, 'Expected Content-Type: application/json');
  }
}

function originHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

async function handleApi(store, req, res, url) {
  // /api/employees/<id>/start -> ['employees', '<id>', 'start']
  const parts = url.pathname.split('/').filter(Boolean).slice(1);
  const [resource, id, action] = parts;
  const route = `${req.method} ${[resource, id && ':id', action].filter(Boolean).join('/')}`;

  switch (parts.length <= 3 ? route : '') {
    case 'GET employees':
      return sendJson(res, 200, store.listEmployees());
    case 'POST employees':
      return sendJson(res, 201, store.addEmployee((await readJson(req)).name));
    case 'POST employees/:id/start':
      return sendJson(res, 201, store.startTimer(id, (await readJson(req)).task));
    case 'POST employees/:id/stop':
      return sendJson(res, 200, store.stopTimer(id));
    case 'POST employees/:id/switch': {
      const body = await readJson(req);
      return sendJson(res, 201, store.switchTask(id, body.task, body.runningId));
    }
    case 'GET report': {
      const { searchParams: q } = url;
      return sendJson(res, 200, store.report(q.get('from'), q.get('to'), q.get('employeeId') || undefined));
    }
    default:
      return sendJson(res, 404, { error: 'Not found' });
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  // Decode once at the end: a multi-byte letter may be split between two chunks.
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AppError(400, 'Invalid JSON');
  }
  return data && typeof data === 'object' ? data : {};
}

async function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 404, { error: 'Not found' });
  let body;
  try {
    // isFile() also rules out directories and Windows device names like CON.
    if (!(await fs.stat(file)).isFile()) return sendJson(res, 404, { error: 'Not found' });
    body = await fs.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return sendJson(res, 404, { error: 'Not found' });
    throw err;
  }
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
