import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { AppServerClient, AppServerThreadCreator, CodexAppServerRuntime, normalizeAppServerItem } from '../src/app-server.mjs';

function fakeChild(onWrite) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: true, write(value) { onWrite(value, child); return true; }, end() { this.writable = false; } };
  child.killed = false;
  child.kill = signal => { child.killed = signal; queueMicrotask(() => child.emit('close', 0)); };
  return child;
}

test('creates a durable task with initialize then thread/start over App Server JSONL', async () => {
  const writes = [];
  let spawned;
  const creator = new AppServerThreadCreator({
    binary: '/codex',
    spawn(command, args, options) {
      spawned = { command, args, options };
      return fakeChild((line, child) => {
        const message = JSON.parse(line);
        writes.push(message);
        if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }) + '\n')));
        if (message.method === 'thread/start') queueMicrotask(() => child.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result: { thread: { id: '01a0-new-task' } } }) + '\n')));
      });
    },
  });
  assert.deepEqual(await creator.createThread({ cwd: '/repo' }), { threadId: '01a0-new-task' });
  assert.deepEqual(spawned.args, ['app-server', '--stdio']);
  assert.equal(writes[0].method, 'initialize');
  assert.equal(writes[1].method, 'initialized');
  assert.deepEqual(writes[2], { method: 'thread/start', id: 2, params: { cwd: '/repo', serviceName: 'codex_deskbridge' } });
});

test('creates a durable projectless task without inventing a cwd or project id', async () => {
  const requests = [];
  const client = {
    request: async (method, params) => {
      requests.push({ method, params });
      return { thread: { id: '01a0-projectless' } };
    },
    stop: async () => {},
  };
  const creator = new AppServerThreadCreator({ client });
  assert.deepEqual(await creator.createThread({}), { threadId: '01a0-projectless' });
  assert.deepEqual(requests, [{ method: 'thread/start', params: { serviceName: 'codex_deskbridge' } }]);
});

test('runtime exposes persisted project names and roots alongside tasks', async () => {
  const client = new EventEmitter();
  client.start = async () => {};
  client.stop = async () => {};
  client.request = async method => {
    if (method === 'thread/list') return { data: [
      { id: 'projectless', name: 'Loose task', cwd: '/tmp/generated', projectId: null },
      { id: 'bound', name: 'Legacy bound task', cwd: '/repo/subdir', projectId: null },
    ] };
    if (method === 'project/list') return { data: [{ id: 'project-1', name: 'Real project', roots: [{ path: '/repo' }] }] };
    throw new Error(method);
  };
  const runtime = new CodexAppServerRuntime({ client });
  const result = await runtime.listThreads({ limit: 20 });
  assert.equal(result.threads[0].projectId, null);
  assert.deepEqual({
    projectId: result.threads[1].projectId,
    projectName: result.threads[1].projectName,
    projectRoot: result.threads[1].projectRoot,
  }, { projectId: 'project-1', projectName: 'Real project', projectRoot: '/repo' });
});

test('matches responses by id while forwarding interleaved notifications', async t => {
  const events = [];
  const client = new AppServerClient({ binary: '/codex', spawn() {
    return fakeChild((line, child) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify({ method: 'thread/started', params: { thread: { id: 'task' } } }) + '\n'));
        child.stdout.emit('data', Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: 'test' } }) + '\n'));
      });
    });
  } });
  client.on('notification', event => events.push(event));
  t.after(() => client.stop());
  await client.start();
  assert.equal(events[0].method, 'thread/started');
});

test('normalizes public App Server thread items without exposing reasoning content', () => {
  const turn = { id: 'turn', startedAt: 1 };
  assert.deepEqual(normalizeAppServerItem({ type: 'agentMessage', id: 'a', text: 'Done', phase: 'final_answer' }, turn), {
    id: 'a', type: 'message', role: 'assistant', phase: 'final_answer', text: 'Done', turnId: 'turn', timestamp: '1970-01-01T00:00:01.000Z',
  });
  assert.equal(normalizeAppServerItem({ type: 'reasoning', id: 'r', summary: [], content: ['secret'] }, turn), null);
  assert.equal(normalizeAppServerItem({ type: 'subAgentActivity', id: 'child', kind: 'completed' }, turn).status, 'completed');
});

test('runtime reads and maps official thread responses', async () => {
  const client = new EventEmitter();
  client.start = async () => {};
  client.stop = async () => {};
  client.request = async method => {
    if (method === 'thread/read') return { thread: { id: 'task', name: 'Task', cwd: '/repo', turns: [] } };
    if (method === 'thread/turns/list') return { data: [{
      id: 'turn', status: 'completed', startedAt: 1, completedAt: 2,
      items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Hello' }] }, { type: 'agentMessage', id: 'a', text: 'Done', phase: 'final_answer' }],
    }] };
    throw new Error(method);
  };
  const runtime = new CodexAppServerRuntime({ client });
  const result = await runtime.readThread({ threadId: 'task', limit: 1 });
  assert.equal(result.observedStatus, 'idle');
  assert.equal(result.lastTerminal.status, 'completed');
  assert.deepEqual(result.messages.map(item => item.text), ['Hello', 'Done']);
});

test('runtime steers an active turn with its expected id and preserves multimedia input', async () => {
  const client = new EventEmitter();
  const calls = [];
  client.request = async (method, params) => { calls.push({ method, params }); return { turnId: 'current' }; };
  const runtime = new CodexAppServerRuntime({ client });
  runtime.readThread = async () => ({ observedStatus: 'running', turnId: 'current' });
  const result = await runtime.sendMessage({ threadId: 'task', text: '追加说明', images: ['/tmp/image.png'] }, { requestKey: 'message' });
  assert.equal(result.mode, 'steer');
  assert.equal(result.turnId, 'current');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'turn/steer');
  assert.equal(calls[0].params.expectedTurnId, 'current');
  assert.deepEqual(calls[0].params.input, [{ type: 'text', text: '追加说明', text_elements: [] }, { type: 'localImage', path: '/tmp/image.png' }]);
  client.request = async (method, params) => { calls.push({ method, params }); throw Object.assign(new Error('no active turn'), { code: 'APP_SERVER_REJECTED' }); };
  await assert.rejects(runtime.sendMessage({ threadId: 'task', text: '已结束时追加' }), { code: 'APP_SERVER_REJECTED' });
  assert.ok(calls.every(call => call.method === 'turn/steer'));
});
