import test from 'node:test';
import assert from 'node:assert/strict';
import { request as nodeRequest } from 'node:http';
import { createServer } from '../src/server.mjs';

const token = 'test-token-that-is-long-enough';

async function fixture(overrides = {}) {
  const calls = { send: 0 };
  const desktop = {
    status: async () => ({ connected: true }),
    listThreads: async ({ limit }) => ({ limit, threads: [] }),
    readThread: async ({ threadId, limit }) => ({ threadId, limit }),
    sendMessage: async (payload) => { calls.send++; return { ok: true, ...payload }; },
    ...overrides,
  };
  const server = createServer({ desktop, token });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { calls, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function request(ctx, path, options = {}) {
  return fetch(`${ctx.base}${path}`, options);
}

function rawRequest(url, headers) {
  return new Promise((resolve, reject) => {
    const req = nodeRequest(url, { headers }, (res) => {
      res.resume();
      res.once('end', () => resolve(res));
    });
    req.once('error', reject);
    req.end();
  });
}

test('requires exact loopback Host, rejects Origins, and authenticates API routes', async () => {
  const ctx = await fixture();
  try {
    assert.equal((await request(ctx, '/health')).status, 200);
    assert.equal((await request(ctx, '/api/status')).status, 401);
    assert.equal((await request(ctx, '/api/status', { headers: { authorization: `Bearer ${token}`, origin: 'https://example.test' } })).status, 403);
    assert.equal((await rawRequest(`${ctx.base}/api/status`, { authorization: `Bearer ${token}`, host: 'localhost:43180' })).statusCode, 421);
    assert.deepEqual(await (await request(ctx, '/api/status', { headers: { authorization: `Bearer ${token}` } })).json(), { connected: true });
  } finally { await ctx.close(); }
});

test('validates limits and enforces the JSON body limit', async () => {
  const ctx = await fixture();
  try {
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'key-a' };
    assert.equal((await request(ctx, '/api/threads?limit=0', { headers: { authorization: `Bearer ${token}` } })).status, 400);
    assert.equal((await request(ctx, '/api/threads/x/messages', { method: 'POST', headers: { ...auth, 'idempotency-key': 'key-null' }, body: 'null' })).status, 400);
    assert.equal((await request(ctx, '/api/threads/x/messages', { method: 'POST', headers: { ...auth, 'idempotency-key': 'key-array' }, body: '[]' })).status, 400);
    assert.equal((await request(ctx, '/api/threads/x/messages', { method: 'POST', headers: { ...auth, 'idempotency-key': 'key-empty-text' }, body: JSON.stringify({ text: '\t' }) })).status, 400);
    assert.equal((await request(ctx, '/api/threads/x/messages', { method: 'POST', headers: { ...auth, 'idempotency-key': 'key-b' }, body: 'x'.repeat(65537) })).status, 413);
  } finally { await ctx.close(); }
});

test('concurrent duplicate mutations execute once and conflicting reuse is rejected', async () => {
  let release;
  let executions = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const ctx = await fixture({ sendMessage: async (payload) => { executions++; await gate; return { ok: true, ...payload }; } });
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'same-key' };
    const first = request(ctx, '/api/threads/a/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'One' }) });
    const second = request(ctx, '/api/threads/a/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'One' }) });
    const conflict = await request(ctx, '/api/threads/a/messages', { method: 'POST', headers, body: JSON.stringify({ text: 'Two' }) });
    assert.equal(conflict.status, 409);
    release();
    assert.deepEqual(await (await first).json(), { ok: true, threadId: 'a', text: 'One' });
    assert.deepEqual(await (await second).json(), { ok: true, threadId: 'a', text: 'One' });
    assert.equal(executions, 1);
  } finally { await ctx.close(); }
});

test('turns desktop errors into a non-sensitive upstream error', async () => {
  const failure = Object.assign(new Error('Desktop transport is disconnected'), { code: 'DISCONNECTED' });
  const ctx = await fixture({ status: async () => { throw failure; } });
  try {
    const response = await request(ctx, '/api/status', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: { message: 'Desktop transport is disconnected', code: 'DISCONNECTED' } });
  } finally { await ctx.close(); }
});

test('preserves explicit desktop operation statuses', async () => {
  const failure = Object.assign(new Error('Task is running'), { status: 409, code: 'TASK_RUNNING' });
  const ctx = await fixture({ sendMessage: async () => { throw failure; } });
  try {
    const response = await request(ctx, '/api/threads/a/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'running-key' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: { message: 'Task is running', code: 'TASK_RUNNING' } });
  } finally { await ctx.close(); }
});

test('a failed mutation is cached so duplicate delivery cannot retry it', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('Desktop transport timed out'), { code: 'TIMEOUT' });
  const ctx = await fixture({ sendMessage: async () => { attempts++; throw failure; } });
  try {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'failed-key' };
    const options = { method: 'POST', headers, body: JSON.stringify({ text: 'hello' }) };
    const first = await request(ctx, '/api/threads/a/messages', options);
    const duplicate = await request(ctx, '/api/threads/a/messages', options);
    assert.equal(first.status, 502);
    assert.equal(duplicate.status, 502);
    assert.equal(attempts, 1);
    assert.deepEqual(await duplicate.json(), { error: { message: 'Desktop transport timed out', code: 'TIMEOUT' } });
  } finally { await ctx.close(); }
});
