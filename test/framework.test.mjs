import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentBridgeFramework, validateAdapterEvent } from '../src/framework.mjs';

test('validates the portable adapter event contract', () => {
  assert.equal(validateAdapterEvent({ type: 'task.list' }).type, 'task.list');
  assert.throws(() => validateAdapterEvent({ type: 'task.send', text: 'x' }), { code: 'INVALID_ADAPTER_EVENT' });
});

test('routes normalized IM commands to the runtime and publishes results', async t => {
  const published = [];
  let handle;
  const adapter = { start: async fn => { handle = fn; }, stop: async () => {}, publish: async event => published.push(event) };
  const runtime = new EventEmitter();
  runtime.start = async () => {};
  runtime.stop = async () => {};
  runtime.sendMessage = async (input, options) => ({ ...input, requestKey: options.requestKey });
  const framework = new AgentBridgeFramework({ runtime, adapter });
  t.after(() => framework.stop());
  await framework.start();
  await handle({ type: 'task.send', requestId: 'request-1', taskId: 'task-1', text: 'hello' });
  assert.equal(published[0].ok, true);
  assert.equal(published[0].data.threadId, 'task-1');
  assert.equal(published[0].data.requestKey, 'request-1');
  runtime.emit('event', { method: 'turn/completed' });
  assert.deepEqual(published[1], { type: 'runtime.event', event: { method: 'turn/completed' } });
});

