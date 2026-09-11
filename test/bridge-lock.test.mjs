import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireBridgeLock, createCoalescedEnqueuer } from '../src/bridge-service.mjs';

test('recovers a stale pid lock and owns the replacement', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lock'); await mkdir(lock); await writeFile(join(lock, 'pid'), '99999999');
  await acquireBridgeLock(lock, 4242);
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), '4242');
});

test('reports the live lock owner without deleting it', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-lock-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = join(dir, 'lock'); await mkdir(lock); await writeFile(join(lock, 'pid'), String(process.pid));
  await assert.rejects(acquireBridgeLock(lock, 4242), { code: 'BRIDGE_LOCKED', lockPid: process.pid });
  assert.equal(await readFile(join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('coalesces repeated poll requests into one running pass and one follow-up', async () => {
  let pending = Promise.resolve(), runs = 0, releaseFirst;
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
  const enqueue = operation => { pending = pending.then(operation); return pending; };
  const runner = createCoalescedEnqueuer({
    enqueue,
    operation: async () => {
      runs++;
      if (runs === 1) await firstBlocked;
    },
  });
  void runner.request();
  await new Promise(resolve => setImmediate(resolve));
  for (let index = 0; index < 100; index++) void runner.request();
  assert.deepEqual(runner.state(), { queued: false, running: true, rerun: true });
  releaseFirst();
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  await pending;
  assert.equal(runs, 2);
  assert.deepEqual(runner.state(), { queued: false, running: false, rerun: false });
});

test('coalesces requests that arrive before a queued poll starts', async () => {
  let pending = Promise.resolve(), releaseBlocker, runs = 0;
  const blocker = new Promise(resolve => { releaseBlocker = resolve; });
  pending = pending.then(() => blocker);
  const enqueue = operation => { pending = pending.then(operation); return pending; };
  const runner = createCoalescedEnqueuer({ enqueue, operation: async () => { runs++; } });
  for (let index = 0; index < 100; index++) void runner.request();
  assert.deepEqual(runner.state(), { queued: true, running: false, rerun: false });
  releaseBlocker();
  await pending;
  assert.equal(runs, 1);
});
