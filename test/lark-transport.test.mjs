import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LarkTransport } from '../src/lark-transport.mjs';

function child() {
  const process = new EventEmitter();
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.stdin = new EventEmitter();
  process.killed = false;
  process.kill = (signal) => {
    process.killed = signal;
    queueMicrotask(() => process.emit('close', 0, signal));
  };
  return process;
}

test('send uses bot identity and verified idempotency flag', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const sent = transport.send({ chatId: 'oc_chat', text: 'hello', key: 'message-1' });
  const output = Buffer.from('{"ok":true,"data":{"message_id":"om_你"}}');
  const split = output.indexOf(Buffer.from('你')) + 1;
  process.stdout.emit('data', output.subarray(0, split));
  process.stdout.emit('data', output.subarray(split));
  process.emit('exit', 0);
  process.emit('close', 0);
  assert.deepEqual(await sent, { message_id: 'om_你' });
  assert.deepEqual(calls[0].args, ['--profile', 'demo', 'im', '+messages-send', '--chat-id', 'oc_chat', '--text', 'hello', '--idempotency-key', 'message-1', '--as', 'bot']);
});

test('sends cards and thread replies with exact bot flags', async () => {
  const p1 = child();
  const p2 = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return calls.length === 1 ? p1 : p2; } });
  const card = { schema: '2.0', body: { elements: [] } };
  const cardSend = transport.sendCard({ chatId: 'oc_chat', card, key: 'card-1' });
  p1.stdout.emit('data', Buffer.from('{"ok":true,"data":{"message_id":"om_root"}}'));
  p1.emit('close', 0);
  assert.equal((await cardSend).message_id, 'om_root');
  const reply = transport.reply({ messageId: 'om_root', text: 'done', key: 'reply-1' });
  p2.stdout.emit('data', Buffer.from('{"ok":true,"data":{"message_id":"om_reply"}}'));
  p2.emit('close', 0);
  await reply;
  assert.deepEqual(calls[0].args, ['--profile', 'demo', 'im', '+messages-send', '--chat-id', 'oc_chat', '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', 'card-1', '--as', 'bot']);
  assert.deepEqual(calls[1].args, ['--profile', 'demo', 'im', '+messages-reply', '--message-id', 'om_root', '--text', 'done', '--reply-in-thread', '--idempotency-key', 'reply-1', '--as', 'bot']);
});

test('sends an automatic task card directly to a configured user', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const card = { schema: '2.0', body: { elements: [] } };
  const sent = transport.sendCardToUser({ userId: 'ou_owner', card, key: 'auto-topic' });
  process.stdout.emit('data', Buffer.from('{"ok":true,"data":{"message_id":"om_root","chat_id":"oc_chat"}}'));
  process.emit('close', 0);
  assert.deepEqual(await sent, { message_id: 'om_root', chat_id: 'oc_chat' });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'im', '+messages-send', '--user-id', 'ou_owner',
    '--msg-type', 'interactive', '--content', JSON.stringify(card), '--idempotency-key', 'auto-topic', '--as', 'bot',
  ]);
});

test('downloads a bounded message resource into the configured media directory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lark-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', resourceDir: dir, spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const expected = join(dir, 'om_event-img_v3_demo.png');
  const downloading = transport.downloadResource({ messageId: 'om_event', fileKey: 'img_v3_demo', type: 'image' });
  await writeFile(expected, 'image-bytes');
  process.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, data: { saved_path: expected, size_bytes: 11 } })));
  process.emit('close', 0);
  assert.deepEqual(await downloading, { path: expected, sizeBytes: 11, type: 'image' });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'im', '+messages-resources-download',
    '--message-id', 'om_event', '--file-key', 'img_v3_demo', '--type', 'image',
    '--output', join(dir, 'om_event-img_v3_demo'), '--as', 'bot',
  ]);
});

test('creates, updates, refreshes and closes a CardKit streaming reply', async () => {
  const children = [child(), child(), child(), child(), child(), child()];
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return children[calls.length - 1]; } });
  const card = { schema: '2.0', config: { streaming_mode: true }, body: { elements: [{ tag: 'markdown', element_id: 'content', content: '' }] } };
  const starting = transport.startStreamingCard({ messageId: 'om_root', card, key: 'stream-start' });
  children[0].stdout.emit('data', Buffer.from('{"ok":true,"data":{"code":0,"data":{"card_id":"card_123"}}}'));
  children[0].emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  children[1].stdout.emit('data', Buffer.from('{"ok":true,"data":{"message_id":"om_stream"}}'));
  children[1].emit('close', 0);
  assert.deepEqual(await starting, { cardId: 'card_123', messageId: 'om_stream' });

  const updating = transport.updateStreamingCard({ cardId: 'card_123', content: '阶段一', sequence: 1 });
  children[2].stdout.emit('data', Buffer.from('{"ok":true,"data":{"code":0}}'));
  children[2].emit('close', 0);
  await updating;
  const resuming = transport.resumeStreamingCard({ cardId: 'card_123', sequence: 2 });
  children[3].stdout.emit('data', Buffer.from('{"ok":true,"data":{"code":0}}'));
  children[3].emit('close', 0);
  await resuming;
  const stateUpdate = transport.updateStreamingCard({ cardId: 'card_123', elementId: 'state', content: '已完成', sequence: 3 });
  children[4].stdout.emit('data', Buffer.from('{"ok":true,"data":{"code":0}}'));
  children[4].emit('close', 0);
  await stateUpdate;
  const closing = transport.closeStreamingCard({ cardId: 'card_123', summary: '阶段结束', sequence: 4 });
  children[5].stdout.emit('data', Buffer.from('{"ok":true,"data":{"code":0}}'));
  children[5].emit('close', 0);
  await closing;

  assert.deepEqual(calls[0].args.slice(0, 6), ['--profile', 'demo', 'api', 'POST', '/open-apis/cardkit/v1/cards', '--as']);
  assert.deepEqual(calls[1].args.slice(0, 7), ['--profile', 'demo', 'im', '+messages-reply', '--message-id', 'om_root', '--msg-type']);
  assert.equal(calls[2].args[4], '/open-apis/cardkit/v1/cards/card_123/elements/content/content');
  assert.match(JSON.parse(calls[2].args.at(-1)).uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(calls[3].args[4], '/open-apis/cardkit/v1/cards/card_123/settings');
  assert.match(calls[3].args.at(-1), /streaming_mode/);
  assert.match(JSON.parse(calls[3].args.at(-1)).uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(calls[4].args[4], '/open-apis/cardkit/v1/cards/card_123/elements/state/content');
  assert.equal(calls[5].args[4], '/open-apis/cardkit/v1/cards/card_123/settings');
  assert.match(JSON.parse(calls[5].args.at(-1)).uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('reports a structured CardKit API rejection without exposing its message', async () => {
  const process = child();
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process });
  const updating = transport.updateStreamingCard({ cardId: 'card_123', content: '阶段一', sequence: 1 });
  process.stdout.emit('data', Buffer.from('{"ok":false,"error":{"code":230020,"message":"sensitive remote detail"}}'));
  process.emit('close', 1);
  await assert.rejects(updating, error => {
    assert.equal(error.code, 'LARK_API_REJECTED');
    assert.equal(error.remoteCode, 230020);
    assert.doesNotMatch(error.message, /sensitive remote detail/);
    return true;
  });
});

test('classifies a failed CardKit command without retaining stderr details', async () => {
  const process = child();
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process });
  const updating = transport.updateStreamingCard({ cardId: 'card_123', content: '阶段一', sequence: 9 });
  process.stderr.emit('data', Buffer.from('request rejected: ErrCode=230020 sequence is too small; secret-token\n'));
  process.emit('close', 1);
  await assert.rejects(updating, error => {
    assert.equal(error.code, 'LARK_SEQUENCE_REJECTED');
    assert.equal(error.remoteCode, 230020);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

test('updates a callback card with the delayed-update token', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const card = { schema: '2.0', body: { elements: [] } };
  const updated = transport.updateCard({ token: 'callback-token', card });
  process.stdout.emit('data', Buffer.from('{"ok":true,"data":{"updated":true}}'));
  process.emit('close', 0);
  assert.deepEqual(await updated, { updated: true });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot',
    '--data', JSON.stringify({ token: 'callback-token', card }),
  ]);
});

test('replaces a sent card by message id', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const card = { schema: '2.0', body: { elements: [] } };
  const replaced = transport.replaceCard({ messageId: 'om_root', card });
  process.stdout.emit('data', Buffer.from('{"ok":true,"data":{"updated":true}}'));
  process.emit('close', 0);
  assert.deepEqual(await replaced, { updated: true });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'im', 'messages', 'patch', '--message-id', 'om_root',
    '--data', JSON.stringify({ content: JSON.stringify(card) }), '--as', 'bot',
  ]);
});

test('adds the OnIt reaction to an accepted user message', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const reacted = transport.react({ messageId: 'om_user_message' });
  process.stdout.emit('data', Buffer.from('{"ok":true,"data":{"reaction_id":"reaction_1"}}'));
  process.emit('close', 0);
  assert.deepEqual(await reacted, { reaction_id: 'reaction_1' });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'im', 'reactions', 'create', '--message-id', 'om_user_message',
    '--data', JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }), '--as', 'bot',
  ]);
});

test('replies with a bounded local image from an explicitly allowed root', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'lark-output-image-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, 'result.png');
  await writeFile(image, 'image-bytes');
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', spawn(command, args, options) { calls.push({ command, args, options }); return process; } });
  const replying = transport.replyImage({ messageId: 'om_root', path: image, allowedRoots: [dir], key: 'image-1' });
  while (!calls.length) await new Promise(resolve => setImmediate(resolve));
  process.stdout.emit('data', Buffer.from('{"ok":true,"data":{"message_id":"om_image"}}'));
  process.emit('close', 0);
  assert.deepEqual(await replying, { message_id: 'om_image' });
  assert.deepEqual(calls[0].args, [
    '--profile', 'demo', 'im', '+messages-reply', '--message-id', 'om_root', '--image', './result.png',
    '--reply-in-thread', '--idempotency-key', 'image-1', '--as', 'bot',
  ]);
  assert.equal(calls[0].options.cwd, await realpath(dir));
});

test('start waits for the stderr ready marker and serializes NDJSON delivery', async () => {
  const process = child();
  const events = [];
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process });
  const started = transport.start(async (event) => { events.push(event); });
  process.stdout.emit('data', '{"message_id":"om_1"}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  process.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n');
  await started;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ message_id: 'om_1' }]);
  await transport.stop();
  assert.equal(process.killed, 'SIGTERM');
});

test('preserves multibyte UTF-8 split across event chunks', async () => {
  const process = child();
  const events = [];
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process });
  const started = transport.start((event) => events.push(event));
  process.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n');
  await started;
  const line = Buffer.from('{"content":"你好"}\n');
  const split = line.indexOf(Buffer.from('好')) + 1;
  process.stdout.emit('data', line.subarray(0, split));
  process.stdout.emit('data', line.subarray(split));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ content: '你好' }]);
  await transport.stop();
});

test('uses a dedicated ready marker for card callbacks', async () => {
  const process = child();
  const calls = [];
  const transport = new LarkTransport({ profile: 'demo', eventKey: 'card.action.trigger', spawn(command, args) { calls.push({ command, args }); return process; } });
  const started = transport.start(() => {});
  process.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n');
  await new Promise(resolve => setImmediate(resolve));
  process.stderr.emit('data', '[event] ready event_key=card.action.trigger\n');
  await started;
  assert.equal(calls[0].args[4], 'card.action.trigger');
  await transport.stop();
});

test('reports runtime stderr diagnostics without exposing their contents', async () => {
  const process = child();
  const diagnostics = [];
  const transport = new LarkTransport({
    profile: 'demo',
    spawn: () => process,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const started = transport.start(() => {});
  process.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n');
  await started;
  process.stderr.emit('data', '[event] WARN dropped event containing secret-message\n');
  assert.deepEqual(diagnostics, [{ code: 'LARK_EVENT_DIAGNOSTIC' }]);
  assert.equal(JSON.stringify(diagnostics).includes('secret-message'), false);
  await transport.stop();
});

test('stop settles a pending start and waits for consumer close', async () => {
  const process = child();
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process });
  const starting = transport.start(() => {});
  await transport.stop();
  await assert.rejects(starting, /stopped before readiness/);
  assert.equal(process.killed, 'SIGTERM');
});

test('reports an unexpected consumer exit after readiness', async () => {
  const process = child();
  const errors = [];
  const transport = new LarkTransport({ profile: 'demo', spawn: () => process, onError: (error) => errors.push(error) });
  const started = transport.start(() => {});
  process.stderr.emit('data', '[event] ready event_key=im.message.receive_v1\n');
  await started;
  process.emit('exit', 3);
  assert.match(errors.at(-1).message, /exited unexpectedly/);
});
