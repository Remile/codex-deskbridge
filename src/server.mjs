import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CodexAppServerRuntime } from './app-server.mjs';

const MAX_BODY = 64 * 1024;
const MAX_LIMIT = 100;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const MAX_IDEMPOTENCY_ENTRIES = 1000;

function error(res, status, message, code) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ error: { message, ...(code ? { code } : {}) } }));
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function stringValue(value, name, max) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}

function upstreamError(cause) {
  const source = cause?.cause || cause;
  return {
    status: Number.isInteger(source?.status) && source.status >= 400 && source.status <= 599 ? source.status : 502,
    message: typeof source?.message === 'string' && source.message.length ? source.message.slice(0, 300) : 'Desktop service error',
    ...(typeof source?.code === 'string' ? { code: source.code.slice(0, 80) } : {}),
  };
}

async function callDesktop(operation) {
  try { return await operation(); }
  catch (cause) { throw { isDesktopTransport: true, cause }; }
}

function limitValue(value, fallback) {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error('Invalid limit');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > MAX_LIMIT) throw new Error('Invalid limit');
  return limit;
}

async function readJson(req) {
  const contentLength = req.headers['content-length'];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY)) throw Object.assign(new Error('Request body too large'), { status: 413 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw new Error('Request body must be JSON');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Request body must be valid JSON'); }
}

export function createServer({ desktop, token }) {
  if (!desktop || typeof token !== 'string' || token.length < 16) throw new TypeError('desktop and token are required');
  const idempotency = new Map();
  const cleanup = () => {
    const now = Date.now();
    for (const [key, entry] of idempotency) if (entry.expiresAt <= now) idempotency.delete(key);
  };
  const http = createHttpServer(async (req, res) => {
    try {
      const address = http.address();
      const expectedHost = `127.0.0.1:${address.port}`;
      if (req.headers.host !== expectedHost) return error(res, 421, 'Host must be the bound loopback address');
      if (req.headers.origin) return error(res, 403, 'Browser origins are not allowed');
      const url = new URL(req.url, `http://${expectedHost}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { alive: true });
      if (!url.pathname.startsWith('/api/')) return error(res, 404, 'Not found');
      if (req.headers.authorization !== `Bearer ${token}`) return error(res, 401, 'Unauthorized');

      if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, await callDesktop(() => desktop.status()));
      if (req.method === 'GET' && url.pathname === '/api/threads') {
        const limit = limitValue(url.searchParams.get('limit'), 20);
        return json(res, 200, await callDesktop(() => desktop.listThreads({ limit })));
      }
      const match = /^\/api\/threads\/([^/]+)(?:\/messages)?$/.exec(url.pathname);
      if (!match) return error(res, 404, 'Not found');
      const threadId = stringValue(decodeURIComponent(match[1]), 'threadId', 512);
      if (req.method === 'GET' && !url.pathname.endsWith('/messages')) {
        const limit = limitValue(url.searchParams.get('limit'), 10);
        return json(res, 200, await callDesktop(() => desktop.readThread({ threadId, limit })));
      }
      const isSend = req.method === 'POST' && url.pathname.endsWith('/messages');
      if (!isSend) return error(res, 405, 'Method not allowed');
      const key = stringValue(req.headers['idempotency-key'], 'Idempotency-Key', 200);
      const body = await readJson(req);
      if (body === null || Array.isArray(body) || typeof body !== 'object') throw new Error('Invalid request body');
      const payload = { threadId, text: stringValue(body.text, 'text', 16000) };
      if (Object.keys(body).length !== 1) throw new Error('Invalid request body');
      const fingerprint = createHash('sha256').update(`${req.method}:${url.pathname}:${JSON.stringify(payload)}`).digest('hex');
      cleanup();
      const existing = idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return error(res, 409, 'Idempotency-Key conflicts with a different request');
        const outcome = await existing.promise;
        return outcome.ok ? json(res, outcome.status, outcome.value) : error(res, outcome.status, outcome.message, outcome.code);
      }
      if (idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) return error(res, 503, 'Idempotency store is temporarily full');
      const entry = { fingerprint, expiresAt: Infinity };
      idempotency.set(key, entry);
      entry.promise = Promise.resolve()
        .then(() => desktop.sendMessage(payload, { requestKey: key }))
        .then((value) => ({ ok: true, status: 200, value }))
        .catch((cause) => ({ ok: false, ...upstreamError(cause) }))
        .then((outcome) => {
          entry.expiresAt = Date.now() + IDEMPOTENCY_TTL_MS;
          return outcome;
        });
      const outcome = await entry.promise;
      return outcome.ok ? json(res, outcome.status, outcome.value) : error(res, outcome.status, outcome.message, outcome.code);
    } catch (cause) {
      if (cause?.isDesktopTransport || cause?.code) {
        const upstream = upstreamError(cause);
        return error(res, upstream.status, upstream.message, upstream.code);
      }
      return error(res, cause.status || 400, cause.message);
    }
  });
  return http;
}

async function loadToken() {
  const local = join(dirname(fileURLToPath(import.meta.url)), '..', '.local');
  const path = join(local, 'token');
  try { const value = (await readFile(path, 'utf8')).trim(); if (value.length >= 16) return { value, path }; } catch {}
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  const value = randomBytes(32).toString('base64url');
  await writeFile(path, `${value}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { value, path };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { value: token, path } = await loadToken();
  const port = Number(process.env.PORT || 43180);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port number');
  const runtime = new CodexAppServerRuntime();
  const server = createServer({ desktop: runtime, token });
  const shutdown = () => server.close(() => void runtime.stop());
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Token file: ${path}\n`));
}
