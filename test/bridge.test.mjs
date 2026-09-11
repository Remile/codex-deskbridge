import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bridge, BridgeStore } from '../src/bridge.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  const path = join(dir, 'state.sqlite');
  let store = new BridgeStore(path);
  const sent = [], cards = [], userCards = [], replies = [], replyCards = [], replyImages = [], reactions = [], updates = [], replacements = [], logs = [], submissions = [], creations = [];
  const streamCards = [], streamEntities = [], streamUpdates = [], streamResumes = [], streamCloses = [], downloads = [];
  let reads = 0;
  const history = { thread: { title: '示例任务' }, observedStatus: 'idle', lastTerminal: { turnId: 'old', status: 'completed' }, messages: [], activities: [] };
  const transport = {
    send: async value => { sent.push(value); return { message_id: `om_sent_${sent.length}` }; },
    sendCard: async value => { cards.push(value); return { message_id: `om_card_${cards.length}` }; },
    sendCardToUser: async value => { userCards.push(value); return { message_id: `om_auto_${userCards.length}`, chat_id: 'oc_auto' }; },
    downloadResource: async value => { downloads.push(value); return { path: value.type === 'image' ? '/tmp/feishu-image.png' : '/tmp/feishu-file.bin', sizeBytes: 128, type: value.type }; },
    startStreamingCard: async value => { streamCards.push(value); return { cardId: `card_${streamCards.length}`, messageId: `om_stream_${streamCards.length}` }; },
    createStreamingCard: async value => { streamEntities.push(value); return { cardId: `replacement_${streamEntities.length}` }; },
    updateStreamingCard: async value => { streamUpdates.push(value); return {}; },
    resumeStreamingCard: async value => { streamResumes.push(value); return {}; },
    closeStreamingCard: async value => { streamCloses.push(value); return {}; },
    reply: async value => { replies.push(value); return { message_id: `om_reply_${replies.length}` }; },
    replyCard: async value => { replyCards.push(value); return { message_id: `om_reply_card_${replyCards.length}` }; },
    replyImage: async value => { replyImages.push(value); return { message_id: `om_reply_image_${replyImages.length}` }; },
    react: async value => { reactions.push(value); return {}; },
    updateCard: async value => { updates.push(value); return {}; },
    replaceCard: async value => { replacements.push(value); return {}; },
  };
  const desktop = {
    readThread: async () => { reads++; return history; },
    listThreads: async () => ({ threads: [{ id: 'task-secret-id', title: '示例任务', status: 'idle', cwd: '/repo/demo' }] }),
    sendEnabled: true,
    sendMessage: async (payload, options) => { submissions.push({ payload, options }); return { turnId: 'accepted-turn', status: 'inProgress' }; },
    createTask: async (payload, options) => { creations.push({ payload, options }); return { threadId: 'new-task-id', turnId: 'new-turn', status: 'inProgress' }; },
  };
  const options = { store, transport, desktop, allowedUsers: ['ou_owner'], now: () => 1_000_000, log: value => logs.push(value) };
  let bridge = new Bridge(options);
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  return {
    get bridge() { return bridge; }, get store() { return store; }, sent, cards, userCards, replies, replyCards, replyImages, reactions, updates, replacements, logs, submissions, creations, desktop, history, transport,
    streamCards, streamEntities, streamUpdates, streamResumes, streamCloses, downloads,
    get reads() { return reads; },
    reopen() { store.close(); store = new BridgeStore(path); bridge = new Bridge({ ...options, store }); },
  };
}

const message = (content, overrides = {}) => ({
  type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_owner', chat_type: 'p2p', chat_id: 'oc_chat',
  message_type: 'text', message_id: 'om_event', create_time: '1000000', content, ...overrides,
});
const action = overrides => ({
  type: 'card.action.trigger', event_id: 'event_action_1', timestamp: '1000000', operator_id: 'ou_owner', message_id: 'om_card_1',
  chat_id: 'oc_chat', host: 'im_message', token: 'card-update-token', action_tag: 'select_static', action_name: 'task_picker', option: 'placeholder', form_value: '', ...overrides,
});

async function openPicker(f, messageId = 'om_event') {
  await f.bridge.handle(message('/codex', { message_id: messageId }));
  const root = `om_card_${f.cards.length}`;
  const projectCard = f.cards.at(-1).card;
  const projectForm = projectCard.body.elements.find(element => element.tag === 'form');
  const projectRef = projectForm.elements.find(element => element.tag === 'select_static').options[0].value;
  await f.bridge.handle(action({ event_id: `event_project_${messageId}`, message_id: root, action_name: 'project_picker', option: projectRef }));
  const picker = f.updates.at(-1).card;
  const form = picker.body.elements.find(element => element.tag === 'form');
  const options = form.elements.find(element => element.tag === 'select_static').options;
  return { root, ref: options[1].value, createRef: options[0].value, projectRef, card: picker };
}
async function selectTask(f, eventId = 'event_select_1') {
  const picker = await openPicker(f);
  await f.bridge.handle(action({ event_id: eventId, message_id: picker.root, option: picker.ref }));
  return picker;
}

test('rejects unauthorized, group, bot, stale and malformed message inputs before effects', async t => {
  const f = await fixture(t);
  for (const fields of [{ sender_id: 'ou_other' }, { sender_type: 'bot' }, { chat_type: 'group' }, { create_time: '1' }, { create_time: '9999999999' }, { message_type: 'interactive' }, { message_id: '' }, { content: 'read task' }]) await f.bridge.handle(message('/codex read task-secret-id', fields));
  assert.equal(f.reads, 0);
  assert.equal(f.sent.length + f.cards.length + f.replies.length, 0);
});

test('normalizes second, millisecond, microsecond, nanosecond and ISO event times', async t => {
  const f = await fixture(t);
  f.bridge.now = () => 1_789_000_000_000;
  assert.equal(f.bridge.validTime('1789000000000'), true);
  assert.equal(f.bridge.validTime('1789000000'), true);
  assert.equal(f.bridge.validTime('1789000000000000'), true);
  assert.equal(f.bridge.validTime('1789000000000000000'), true);
  assert.equal(f.bridge.validTime(new Date(1_789_000_000_000).toISOString()), true);
  assert.equal(f.bridge.validTime('1788999000'), false);
  assert.equal(f.bridge.validTime('not-a-time'), false);
});

test('/codex leaves the user command alone and shows opaque project then task refs', async t => {
  const f = await fixture(t);
  const { ref, card } = await openPicker(f);
  assert.equal(f.cards.length, 1);
  assert.equal(f.cards[0].card.schema, '2.0');
  assert.doesNotMatch(JSON.stringify(f.cards[0].card), /task-secret-id/);
  assert.match(JSON.stringify(f.cards[0].card), /选择项目/);
  assert.match(JSON.stringify(card), /创建新任务/);
  assert.match(ref, /^[A-Za-z0-9_-]+$/);
  assert.equal(f.store.db.prepare('SELECT thread FROM picker_refs WHERE ref=?').get(ref).thread, 'task-secret-id');
});

test('/codex picker verifies each recent task against its persisted current turn', async t => {
  const f = await fixture(t);
  f.history.observedStatus = 'running';
  const picker = await openPicker(f);
  const options = picker.card.body.elements.find(element => element.tag === 'form')
    .elements.find(element => element.tag === 'select_static').options;
  assert.match(options[1].text.content, /示例任务 · 运行中/);
  assert.doesNotMatch(options[1].text.content, /空闲/);
});

test('picker selection creates one persistent topic root and automatically watches it', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  await f.bridge.handle(action({ event_id: 'event_select_1', message_id: picker.root, option: picker.ref, action_name: '', action_tag: 'unknown' }));
  assert.equal(f.cards.length, 1);
  assert.equal(f.updates.at(-1).card.body.elements.some(element => element.tag === 'form'), false);
  assert.deepEqual({ ...f.store.topic('ou_owner', 'oc_chat', 'task-secret-id') }, { owner: 'ou_owner', chat: 'oc_chat', thread: 'task-secret-id', root_message: 'om_card_1' });
  assert.equal(f.store.watches().length, 1);
  await f.bridge.handle(action({ event_id: 'event_select_2', message_id: picker.root, option: picker.ref }));
  assert.equal(f.cards.length, 1);
  assert.equal(f.replies.length, 0);
});

test('task picker submits multiline text once without a redundant receipt', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  const submit = action({ event_id: 'event_submit_1', message_id: picker.root, action_tag: 'unknown', action_name: '', option: '', form_value: JSON.stringify({ task_picker: picker.ref, prompt: '第一行\n第二行' }) });
  await f.bridge.handle(submit);
  f.reopen();
  await f.bridge.handle(submit);
  assert.deepEqual(f.submissions, [{ payload: { threadId: 'task-secret-id', text: '第一行\n第二行' }, options: { requestKey: 'feishu-card:event_submit_1' } }]);
  assert.equal(f.replies.length, 0);
  assert.match(JSON.stringify(f.updates.at(-1).card), /第一行/);
});

test('a plain text reply inside a known task topic continues that Desktop task', async t => {
  const f = await fixture(t);
  await selectTask(f);
  await f.bridge.handle(message('每一批改成 200 个', { message_id: 'om_thread_reply', root_id: 'om_card_1' }));
  assert.deepEqual(f.submissions, [{
    payload: { threadId: 'task-secret-id', text: '每一批改成 200 个' },
    options: { requestKey: 'feishu-thread:om_thread_reply' },
  }]);
  assert.equal(f.replies.length, 0);
  assert.deepEqual(f.reactions, [{ messageId: 'om_thread_reply', emojiType: 'OnIt' }]);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /每一批改成 200 个/);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /运行中/);
});

test('a rich-text post reply without attachments is submitted as text', async t => {
  const f = await fixture(t);
  await selectTask(f);
  const content = JSON.stringify({ title: '', content: [
    [{ tag: 'text', text: '确保符合如下规则：' }],
    [{ tag: 'text', text: '1. 新项目放在 GitHub。' }],
    [{ tag: 'text', text: '2. 从 Gerrit 同步模型改动。' }],
  ] });
  await f.bridge.handle(message(content, {
    message_id: 'om_rich_text', message_type: 'post', root_id: 'om_card_1',
  }));
  assert.deepEqual(f.submissions.at(-1).payload, {
    threadId: 'task-secret-id',
    text: '确保符合如下规则：\n1. 新项目放在 GitHub。\n2. 从 Gerrit 同步模型改动。',
  });
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(f.reactions, [{ messageId: 'om_rich_text', emojiType: 'OnIt' }]);
});

test('a pre-rendered rich-text post reply is submitted as text', async t => {
  const f = await fixture(t);
  await selectTask(f);
  await f.bridge.handle(message('1. 新项目放在 GitHub。\n2. 从 Gerrit 同步模型改动。', {
    message_id: 'om_rendered_post', message_type: 'post', root_id: 'om_card_1',
  }));
  assert.equal(f.submissions.at(-1).payload.text, '1. 新项目放在 GitHub。\n2. 从 Gerrit 同步模型改动。');
  assert.equal(f.downloads.length, 0);
});

test('picker displays prompt input and submits task selection plus text in one form', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  const form = picker.card.body.elements.find(element => element.tag === 'form');
  assert.equal(form.elements.some(element => element.name === 'prompt' && element.tag === 'input'), true);
  assert.equal(form.elements.find(element => element.name === 'prompt').required, false);
  await f.bridge.handle(action({
    event_id: 'event_picker_submit', message_id: picker.root, action_tag: 'unknown', action_name: '', option: '',
    form_value: JSON.stringify({ task_picker: picker.ref, prompt: '从选择卡直接发送' }),
  }));
  assert.equal(f.cards.length, 1);
  assert.deepEqual(f.submissions, [{
    payload: { threadId: 'task-secret-id', text: '从选择卡直接发送' },
    options: { requestKey: 'feishu-card:event_picker_submit' },
  }]);
  assert.equal(f.updates.length, 2);
  assert.equal(f.updates.at(-1).token, 'card-update-token');
  assert.match(JSON.stringify(f.updates.at(-1).card), /运行中/);
  assert.match(JSON.stringify(f.updates.at(-1).card), /从选择卡直接发送/);
  assert.equal(f.replies.length, 0);
  assert.equal(f.store.topic('ou_owner', 'oc_chat', 'task-secret-id').root_message, picker.root);
});

test('picker submission without text opens a task topic without starting a Codex turn', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  await f.bridge.handle(action({
    event_id: 'event_picker_open_topic', message_id: picker.root, action_tag: 'unknown', action_name: '', option: '',
    form_value: JSON.stringify({ task_picker: picker.ref, prompt: '' }),
  }));
  assert.equal(f.submissions.length, 0);
  assert.equal(f.cards.length, 1);
  assert.equal(f.updates.length, 2);
  assert.equal(f.store.topic('ou_owner', 'oc_chat', 'task-secret-id').root_message, 'om_card_1');
  assert.equal(f.store.watches().length, 1);
});

test('new-task selection requires text then creates and owns the source card topic', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  await f.bridge.handle(action({
    event_id: 'event_create_empty', message_id: picker.root, option: '',
    form_value: JSON.stringify({ task_picker: picker.createRef, prompt: '' }),
  }));
  assert.equal(f.creations.length, 0);
  assert.match(JSON.stringify(f.updates.at(-1).card), /请先填写任务描述/);

  const refreshedForm = f.updates.at(-1).card.body.elements.find(element => element.tag === 'form');
  const refreshedCreateRef = refreshedForm.elements.find(element => element.tag === 'select_static').options[0].value;
  await f.bridge.handle(action({
    event_id: 'event_create_task', message_id: picker.root, option: '',
    form_value: JSON.stringify({ task_picker: refreshedCreateRef, prompt: '实现新的搜索接口' }),
  }));
  assert.deepEqual(f.creations, [{
    payload: { cwd: '/repo/demo', text: '实现新的搜索接口' },
    options: { requestKey: 'feishu-card:event_create_task' },
  }]);
  assert.equal(f.store.topic('ou_owner', 'oc_chat', 'new-task-id').root_message, picker.root);
  assert.equal(f.store.watches().some(watch => watch.thread === 'new-task-id'), true);
  assert.equal(f.replies.length, 0);
  assert.match(JSON.stringify(f.updates.at(-1).card), /实现新的搜索接口/);
});

test('empty-input attachment immediately restores the latest progress, behavior and result', async t => {
  const f = await fixture(t);
  f.history.lastTerminal = { turnId: 'recent-turn', status: 'completed' };
  f.history.messages = [
    { id: 'u', turnId: 'recent-turn', role: 'user', phase: 'user', text: '最近请求' },
    { id: 'p', turnId: 'recent-turn', role: 'assistant', phase: 'commentary', text: '已经完成数据核对' },
    { id: 'a', turnId: 'recent-turn', role: 'assistant', phase: 'final_answer', text: '最终共有 42 条记录' },
  ];
  f.history.activities = [{ id: 'c', turnId: 'recent-turn', type: 'command', command: 'npm test', status: 'completed' }];
  const picker = await openPicker(f);
  await f.bridge.handle(action({ event_id: 'event_attach_snapshot', message_id: picker.root, option: picker.ref }));
  assert.equal(f.streamCards.length, 1);
  assert.equal(f.streamCards[0].messageId, picker.root);
  assert.match(JSON.stringify(f.streamCards[0].card), /已经完成数据核对/);
  assert.match(JSON.stringify(f.streamCards[0].card), /npm test/);
  assert.match(JSON.stringify(f.streamCards[0].card), /最终共有 42 条记录/);
  assert.equal(f.streamCloses.length, 1);
});

test('an image reply in a task topic is downloaded and submitted as a Desktop image input', async t => {
  const f = await fixture(t);
  await selectTask(f);
  await f.bridge.handle(message('![Image](img_v3_demo)', {
    message_id: 'om_image', message_type: 'image', root_id: 'om_card_1',
  }));
  assert.deepEqual(f.downloads, [{ messageId: 'om_image', fileKey: 'img_v3_demo', type: 'image' }]);
  assert.deepEqual(f.submissions.at(-1).payload, {
    threadId: 'task-secret-id',
    text: '请查看并处理我发送的图片。',
    images: ['/tmp/feishu-image.png'],
  });
  assert.equal(f.replies.length, 0);
  assert.deepEqual(f.reactions, [{ messageId: 'om_image', emojiType: 'OnIt' }]);
});

test('a file reply in a task topic is downloaded and passed to Codex by local path', async t => {
  const f = await fixture(t);
  await selectTask(f);
  await f.bridge.handle(message('<file key="file_v3_demo" name="notes.pdf"/>', {
    message_id: 'om_file', message_type: 'file', root_id: 'om_card_1',
  }));
  assert.deepEqual(f.downloads, [{ messageId: 'om_file', fileKey: 'file_v3_demo', type: 'file' }]);
  assert.match(f.submissions.at(-1).payload.text, /已下载的飞书附件路径：/);
  assert.match(f.submissions.at(-1).payload.text, /\/tmp\/feishu-file\.bin/);
  assert.equal(Object.hasOwn(f.submissions.at(-1).payload, 'images'), false);
  assert.equal(f.replies.length, 0);
  assert.deepEqual(f.reactions, [{ messageId: 'om_file', emojiType: 'OnIt' }]);
});

test('a reaction failure never turns an accepted topic submission into a failure reply', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.transport.react = async () => { throw new Error('reaction unavailable'); };
  await f.bridge.handle(message('继续处理', { message_id: 'om_reaction_failure', root_id: 'om_card_1' }));
  assert.equal(f.submissions.length, 1);
  assert.equal(f.replies.length, 0);
  assert.equal(f.store.db.prepare('SELECT status FROM deliveries WHERE key=?').get('message:om_reaction_failure').status, 'sent');
  assert.deepEqual(f.logs.at(-1), { operation: 'topic-reaction', code: 'DELIVERY_UNCERTAIN' });
});

test('a failed picker submission does not create an empty task topic', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f);
  f.desktop.sendMessage = async () => { throw Object.assign(new Error(), { code: 'TASK_NOT_LOADED' }); };
  await f.bridge.handle(action({
    event_id: 'event_picker_unloaded', message_id: picker.root, action_tag: 'unknown', action_name: '', option: '',
    form_value: JSON.stringify({ task_picker: picker.ref, prompt: '请执行这条消息' }),
  }));
  assert.equal(f.cards.length, 1);
  assert.equal(f.store.topic('ou_owner', 'oc_chat', 'task-secret-id'), undefined);
  assert.equal(f.updates.length, 2);
  assert.match(JSON.stringify(f.updates.at(-1).card), /无法加载这个任务/);
});

test('forged, expired and cross-user card callbacks produce no effects', async t => {
  const f = await fixture(t);
  const picker = await openPicker(f, 'om_picker');
  const baseline = f.cards.length;
  for (const fields of [
    { operator_id: 'ou_other', option: picker.ref }, { timestamp: '1', option: picker.ref }, { host: 'im_top_notice', option: picker.ref },
    { chat_id: 'oc_other', option: picker.ref }, { message_id: 'om_unknown', option: picker.ref }, { option: 'forged-ref' },
  ]) await f.bridge.handle(action(fields));
  assert.equal(f.cards.length, baseline);
  assert.equal(f.submissions.length, 0);
  await f.bridge.handle(action({ event_id: 'event_forged_submit', message_id: 'om_unknown', action_tag: 'button', action_name: 'send_prompt', form_value: '{"prompt":"bad"}' }));
  assert.equal(f.submissions.length, 0);
});

test('completion is sent once as a card reply inside the task topic across restart', async t => {
  const f = await fixture(t);
  await selectTask(f);
  await f.bridge.poll();
  f.history.lastTerminal = { turnId: 'new', status: 'completed' };
  f.history.messages = [{ role: 'assistant', phase: 'final_answer', turnId: 'new', text: '最终结果' }];
  await f.bridge.poll();
  f.reopen();
  await f.bridge.poll();
  assert.equal(f.replyCards.length, 1);
  assert.equal(f.replyCards[0].messageId, 'om_card_1');
  assert.equal(f.replyCards[0].inThread, true);
  assert.match(JSON.stringify(f.replyCards[0].card), /最终结果/);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /已完成/);
  assert.equal(f.sent.length, 0);
});

test('automatic discovery baselines existing tasks and creates one topic for each later task', async t => {
  const f = await fixture(t);
  let threads = [{ id: 'existing-task', title: '已有任务', status: 'idle' }];
  f.desktop.listThreads = async () => ({ threads });
  await f.bridge.syncThreads();
  assert.equal(f.userCards.length, 0);
  assert.equal(f.store.discovered('ou_owner', 'existing-task'), true);

  threads = [...threads, { id: 'new-task', title: '', status: 'running' }];
  f.history.thread = { id: 'new-task', title: '' };
  f.history.observedStatus = 'running';
  f.history.lastTerminal = null;
  f.history.messages = [];
  await f.bridge.syncThreads();
  assert.equal(f.userCards.length, 0);
  assert.equal(f.store.discovered('ou_owner', 'new-task'), false);

  f.history.messages = [{ turnId: 'new-turn', role: 'user', phase: 'user', text: '自动发现我的原始输入' }];
  await f.bridge.syncThreads();
  await f.bridge.syncThreads();
  assert.equal(f.userCards.length, 1);
  assert.equal(f.userCards[0].userId, 'ou_owner');
  assert.match(JSON.stringify(f.userCards[0].card), /自动发现我的原始输入/);
  assert.deepEqual({ ...f.store.topic('ou_owner', 'oc_auto', 'new-task') }, {
    owner: 'ou_owner', chat: 'oc_auto', thread: 'new-task', root_message: 'om_auto_1',
  });
  assert.equal(f.store.watches().some(watch => watch.thread === 'new-task' && watch.terminal === null), true);

  f.history.thread.title = '真实任务标题';
  f.history.turnId = 'new-turn';
  await f.bridge.poll();
  assert.match(JSON.stringify(f.replacements.at(-1).card), /真实任务标题/);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /自动发现我的原始输入/);
});

test('poll replaces the latest stage and turns the same streaming card into the final result', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.observedStatus = 'running';
  f.history.turnId = 'active-turn';
  f.history.messages = [
    { id: 'comment-1', timestamp: 't1', turnId: 'active-turn', role: 'assistant', phase: 'commentary', text: '正在修改并发数' },
  ];
  await f.bridge.poll();
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn').sequence, 0);
  f.history.messages.push({ id: 'comment-2', timestamp: 't2', turnId: 'active-turn', role: 'assistant', phase: 'commentary', text: '已更新巡检任务' });
  f.history.activities.push({ id: 'command-1', turnId: 'active-turn', type: 'command', command: 'npm test', status: 'running' });
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(f.streamCards.length, 1);
  assert.equal(f.streamCards[0].messageId, 'om_card_1');
  assert.match(JSON.stringify(f.streamCards[0].card), /正在修改并发数/);
  assert.equal(f.streamUpdates.length, 1);
  assert.doesNotMatch(f.streamUpdates[0].content, /正在修改并发数/);
  assert.match(f.streamUpdates[0].content, /已更新巡检任务/);
  assert.match(f.streamUpdates[0].content, /最近行为/);
  assert.match(f.streamUpdates[0].content, /npm test/);
  assert.equal(f.replies.filter(reply => reply.text.startsWith('阶段进展')).length, 0);

  f.bridge.now = () => 1_000_000 + 8 * 60 * 1000;
  await f.bridge.poll();
  assert.deepEqual(f.streamResumes, [{ cardId: 'card_1', sequence: 2 }]);

  f.history.observedStatus = 'idle';
  f.history.lastTerminal = { turnId: 'active-turn', status: 'completed' };
  f.history.messages.push({ id: 'final-1', timestamp: 't3', turnId: 'active-turn', role: 'assistant', phase: 'final_answer', text: '最终已完成巡检更新' });
  await f.bridge.poll();
  assert.equal(f.streamCloses.length, 0);
  assert.equal(f.replyCards.length, 0);
  assert.equal(f.streamUpdates.length, 1);
  const finalReplacement = f.replacements.find(value => value.messageId === 'om_stream_1');
  assert.match(JSON.stringify(finalReplacement.card), /最终已完成巡检更新/);
  assert.match(JSON.stringify(finalReplacement.card), /已完成/);
});

test('a repeated CardKit failure retries once then degrades the same message to a static card', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.observedStatus = 'running';
  f.history.turnId = 'recover-turn';
  f.history.messages = [{ id: 'comment-1', turnId: 'recover-turn', role: 'assistant', phase: 'commentary', text: '第一阶段' }];
  await f.bridge.poll();
  const workingUpdate = f.transport.updateStreamingCard;
  f.transport.updateStreamingCard = async () => { throw new Error('expired card'); };
  f.history.messages.push({ id: 'comment-2', turnId: 'recover-turn', role: 'assistant', phase: 'commentary', text: '第二阶段' });
  await f.bridge.poll();
  assert.equal(f.streamCards.length, 1);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'recover-turn').failures, 1);
  await f.bridge.poll();
  assert.equal(f.streamCards.length, 1);
  assert.equal(f.streamEntities.length, 0);
  assert.equal(f.replacements.at(-1).messageId, 'om_stream_1');
  assert.match(JSON.stringify(f.replacements.at(-1).card), /第二阶段/);
  assert.equal('streaming_mode' in f.replacements.at(-1).card.config, false);
  assert.equal(f.replies.filter(reply => reply.text.startsWith('阶段进展')).length, 0);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'recover-turn').status, 'static');
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'recover-turn').generation, 0);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'recover-turn').failures, 0);
  f.transport.updateStreamingCard = workingUpdate;

  f.history.observedStatus = 'idle';
  f.history.lastTerminal = { turnId: 'recover-turn', status: 'completed' };
  f.history.messages.push({ id: 'final', turnId: 'recover-turn', role: 'assistant', phase: 'final_answer', text: '**最终完成**' });
  await f.bridge.poll();
  assert.equal(f.replyCards.length, 0);
  assert.match(JSON.stringify(f.replacements.filter(value => value.messageId === 'om_stream_1').at(-1).card), /最终完成/);
});

test('a max-generation CardKit stream falls back to one static reply and stale open turns close locally', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.observedStatus = 'running';
  f.history.turnId = 'active-turn';
  f.history.lastTerminal = null;
  f.history.messages = [{ turnId: 'active-turn', role: 'assistant', phase: 'commentary', text: '新的阶段' }];
  f.store.saveProgressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn', 'card_active', 'om_stream_active', 'old', 2);
  f.store.saveProgressStream('ou_owner', 'oc_chat', 'task-secret-id', 'stale-turn', 'card_stale', 'om_stream_stale', 'old');
  let attempts = 0;
  f.transport.updateStreamingCard = async () => { attempts++; throw new Error('expired card'); };
  const workingReplace = f.transport.replaceCard;
  f.transport.replaceCard = async () => { throw new Error('message patch unavailable'); };
  await f.bridge.poll();
  await f.bridge.poll();
  assert.equal(attempts, 2);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn').status, 'static');
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn').message_id, 'om_reply_card_1');
  assert.equal(f.replyCards.length, 1);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'stale-turn').status, 'closed');
  f.transport.replaceCard = workingReplace;
});

test('an exhausted CardKit reference that cannot be patched falls back once to an updateable static reply', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.observedStatus = 'running';
  f.history.turnId = 'active-turn';
  f.history.messages = [{ turnId: 'active-turn', role: 'assistant', phase: 'commentary', text: '恢复前阶段' }];
  f.store.saveProgressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn', 'card_broken', 'om_stream_broken', 'old', 2, 0);
  f.store.advanceProgressStream(
    f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn'),
    13, 'old', 'exhausted', 0,
  );
  const workingReplace = f.transport.replaceCard;
  f.transport.replaceCard = async () => { throw Object.assign(new Error('cannot patch CardKit reference'), { remoteCode: 200621 }); };

  await f.bridge.poll();
  assert.equal(f.replyCards.length, 1);
  assert.equal(f.replyCards[0].messageId, 'om_card_1');
  assert.equal(f.replyCards[0].inThread, true);
  assert.match(JSON.stringify(f.replyCards[0].card), /恢复前阶段/);
  assert.equal('streaming_mode' in f.replyCards[0].card.config, false);
  let stream = f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn');
  assert.equal(stream.status, 'static');
  assert.equal(stream.message_id, 'om_reply_card_1');

  f.transport.replaceCard = workingReplace;
  f.history.messages.push({ turnId: 'active-turn', role: 'assistant', phase: 'commentary', text: '恢复后最新阶段' });
  await f.bridge.poll();
  assert.equal(f.replyCards.length, 1);
  assert.equal(f.replacements.at(-1).messageId, 'om_reply_card_1');
  assert.match(JSON.stringify(f.replacements.at(-1).card), /恢复后最新阶段/);
  stream = f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'active-turn');
  assert.equal(stream.status, 'static');
});

test('poll reconciles a completed turn whose streaming card was left open', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.store.saveProgressStream('ou_owner', 'oc_chat', 'task-secret-id', 'fast-turn', 'card_fast', 'om_stream_fast', 'old');
  f.store.advance(f.store.watches()[0], 'fast-turn');
  f.history.observedStatus = 'idle';
  f.history.lastTerminal = { turnId: 'fast-turn', status: 'completed' };
  f.history.messages = [{ turnId: 'fast-turn', role: 'assistant', phase: 'final_answer', text: '快速任务已完成' }];
  await f.bridge.poll();
  assert.match(JSON.stringify(f.replacements.find(value => value.messageId === 'om_stream_fast').card), /快速任务已完成/);
  assert.equal(f.store.progressStream('ou_owner', 'oc_chat', 'task-secret-id', 'fast-turn').status, 'closed');
});

test('poll replies with local images referenced by the final answer once', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.thread.cwd = '/repo/demo';
  f.history.observedStatus = 'idle';
  f.history.lastTerminal = { turnId: 'image-turn', status: 'completed' };
  f.history.messages = [{
    turnId: 'image-turn', role: 'assistant', phase: 'final_answer',
    text: '图片如下\n\n![结果图](/private/tmp/result.png)',
  }];
  await f.bridge.poll();
  await f.bridge.poll();
  assert.deepEqual(f.replyImages, [{
    messageId: 'om_card_1', path: '/private/tmp/result.png',
    allowedRoots: ['/repo/demo', '/private/tmp', '/tmp'],
    key: f.replyImages[0].key, inThread: true,
  }]);
  assert.match(f.replyImages[0].key, /^[a-f0-9]{40}$/);
});

test('poll updates the root status when a completion delivery was already claimed', async t => {
  const f = await fixture(t);
  await selectTask(f);
  const key = 'completion:ou_owner:oc_chat:task-secret-id:notifier-turn';
  assert.equal(f.store.claim(key), true);
  f.store.finish(key, 'sent');
  f.history.lastTerminal = { turnId: 'notifier-turn', status: 'completed' };
  f.history.messages = [
    { turnId: 'notifier-turn', role: 'user', phase: 'user', text: '更新配置' },
    { turnId: 'notifier-turn', role: 'assistant', phase: 'final_answer', text: '已完成' },
  ];
  await f.bridge.poll();
  assert.equal(f.replyCards.length, 0);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /更新配置/);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /已完成/);
});

test('poll suppresses DONT_NOTIFY completion output inside the bridge', async t => {
  const f = await fixture(t);
  await selectTask(f);
  f.history.lastTerminal = { turnId: 'quiet-turn', status: 'completed' };
  f.history.messages = [
    { turnId: 'quiet-turn', role: 'user', phase: 'user', text: 'heartbeat' },
    { turnId: 'quiet-turn', role: 'assistant', phase: 'final_answer', text: '<decision>DONT_NOTIFY</decision>' },
  ];
  await f.bridge.poll();
  assert.equal(f.replyCards.length, 0);
  assert.match(JSON.stringify(f.replacements.at(-1).card), /保持静默/);
  const delivery = f.store.db.prepare("SELECT status FROM deliveries WHERE key LIKE 'completion:%:quiet-turn'").get();
  assert.equal(delivery.status, 'suppressed');
});

test('an upgraded legacy watch gets a topic before its completion is delivered', async t => {
  const f = await fixture(t);
  f.store.watch('ou_owner', 'oc_chat', 'task-secret-id', 'old');
  f.history.lastTerminal = { turnId: 'new', status: 'completed' };
  f.history.messages = [{ role: 'assistant', phase: 'final_answer', turnId: 'new', text: '迁移后的结果' }];
  await f.bridge.poll();
  assert.equal(f.cards.length, 1);
  assert.equal(f.replyCards.length, 1);
  assert.equal(f.replyCards[0].messageId, 'om_card_1');
  assert.equal(f.sent.length, 0);
});

test('legacy read and send commands create and use the same task topic', async t => {
  const f = await fixture(t);
  f.history.messages = [{ role: 'user', text: '最新用户输入' }, { role: 'assistant', text: '处理中' }];
  await f.bridge.handle(message('/codex read task-secret-id'));
  await f.bridge.handle(message('/codex send task-secret-id 第一行\n第二行', { message_id: 'om_send' }));
  assert.equal(f.cards.length, 1);
  assert.equal(f.replies.length, 2);
  assert.ok(f.replies.every(reply => reply.messageId === 'om_card_1' && reply.inThread));
  assert.match(f.replies[0].text, /最新用户输入/);
  assert.equal(f.submissions.length, 1);
});

test('message id and card event id deduplicate external effects across restart', async t => {
  const f = await fixture(t);
  await f.bridge.handle(message('/codex list'));
  f.reopen();
  await f.bridge.handle(message('/codex list'));
  assert.equal(f.sent.length, 1);
  const picker = await openPicker(f, 'om_picker');
  const selection = action({ event_id: 'event_once', message_id: picker.root, option: picker.ref });
  await f.bridge.handle(selection);
  f.reopen();
  await f.bridge.handle(selection);
  assert.equal(f.cards.length, 1);
});

test('uncertain text reply and ambiguous Desktop submission are never blindly retried', async t => {
  const f = await fixture(t);
  let sends = 0;
  f.transport.send = async () => { sends++; throw Error('network uncertain'); };
  await f.bridge.handle(message('/codex list'));
  f.reopen();
  await f.bridge.handle(message('/codex list'));
  assert.equal(sends, 1);
  f.desktop.sendMessage = async () => { throw Object.assign(Error('uncertain'), { code: 'UNKNOWN_SEND_OUTCOME' }); };
  await f.bridge.handle(message('/codex send task-secret-id 内容', { message_id: 'om_send_1' }));
  f.reopen();
  await f.bridge.handle(message('/codex send task-secret-id 再发', { message_id: 'om_send_2' }));
  assert.equal(f.store.submission('task-secret-id').turn, null);
  assert.match(f.replies.at(-1).text, /SEND_IN_PROGRESS/);
});

test('an old pre-accept submission fence recovers only after the task is idle', async t => {
  const f = await fixture(t);
  f.store.reserve('task-secret-id', 0);
  await f.bridge.handle(message('/codex send task-secret-id 新请求', { message_id: 'om_stale_fence' }));
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].payload.text, '新请求');
  assert.equal(f.store.submission('task-secret-id').turn, 'accepted-turn');

  f.store.release('task-secret-id');
  f.store.reserve('task-secret-id', 0);
  f.history.observedStatus = 'running';
  await f.bridge.handle(message('/codex send task-secret-id 运行时请求', { message_id: 'om_running_fence' }));
  assert.equal(f.submissions.length, 1);
  assert.match(f.replies.at(-1).text, /SEND_IN_PROGRESS/);
});

test('a fresh pre-accept submission fence keeps its recovery grace period', async t => {
  const f = await fixture(t);
  f.store.reserve('task-secret-id', 999_999);
  await f.bridge.handle(message('/codex send task-secret-id 不应立即重试', { message_id: 'om_fresh_fence' }));
  assert.equal(f.submissions.length, 0);
  assert.match(f.replies.at(-1).text, /SEND_IN_PROGRESS/);
});

test('a failed Feishu acknowledgement never turns an accepted card submission into a failure message', async t => {
  const f = await fixture(t);
  await selectTask(f);
  let attempts = 0;
  f.transport.reply = async () => { attempts++; throw Error('timeout'); };
  await f.bridge.handle(action({
    event_id: 'event_ack_timeout', message_id: 'om_card_1', action_tag: 'button', action_name: 'send_prompt',
    option: '', form_value: JSON.stringify({ prompt: '只提交一次' }),
  }));
  assert.equal(f.submissions.length, 1);
  assert.equal(attempts, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries WHERE key='card:event_ack_timeout'").get().status, 'uncertain');
  assert.deepEqual(f.logs.at(-1), { operation: 'card-ack', code: 'DELIVERY_UNCERTAIN' });
});

test('a failed Feishu acknowledgement never turns an accepted text-command submission into a failure message', async t => {
  const f = await fixture(t);
  f.transport.reply = async () => { throw Error('timeout'); };
  await f.bridge.handle(message('/codex send task-secret-id 内容', { message_id: 'om_ack_timeout' }));
  assert.equal(f.submissions.length, 1);
  assert.equal(f.store.db.prepare("SELECT status FROM deliveries WHERE key='message:om_ack_timeout'").get().status, 'uncertain');
  assert.deepEqual(f.logs.at(-1), { operation: 'ack', code: 'DELIVERY_UNCERTAIN' });
});

test('a definitely refused Desktop send releases the per-task submission fence', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.desktop.sendMessage = async () => { calls++; if (calls === 1) throw Object.assign(Error(), { code: 'TASK_RUNNING' }); return { turnId: 'accepted', status: 'inProgress' }; };
  await f.bridge.handle(message('/codex send task-secret-id one', { message_id: 'om_one' }));
  await f.bridge.handle(message('/codex send task-secret-id two', { message_id: 'om_two' }));
  assert.equal(calls, 2);
});

test('an explicit Desktop IPC rejection releases the per-task submission fence', async t => {
  const f = await fixture(t);
  let calls = 0;
  f.desktop.sendMessage = async () => {
    calls++;
    if (calls === 1) throw Object.assign(Error('invalid request'), { code: 'DESKTOP_REJECTED' });
    return { turnId: 'accepted-after-rejection', status: 'inProgress' };
  };
  await f.bridge.handle(message('/codex send task-secret-id one', { message_id: 'om_rejected_one' }));
  assert.equal(f.store.submission('task-secret-id'), undefined);
  await f.bridge.handle(message('/codex send task-secret-id two', { message_id: 'om_rejected_two' }));
  assert.equal(calls, 2);
  assert.equal(f.store.submission('task-secret-id').turn, 'accepted-after-rejection');
});
