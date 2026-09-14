import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { completionCard, pickerCard, projectPickerCard, streamingFinalText, streamingProgressCard, streamingProgressText, taskTopicCard } from './cards.mjs';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const openId = value => typeof value === 'string' && /^ou_[\w-]+$/.test(value);
const chatId = value => typeof value === 'string' && /^oc_[\w-]+$/.test(value);
const messageId = value => typeof value === 'string' && /^om_[\w-]+$/.test(value);
const help = '发送 /codex 打开“项目 → 任务”选择卡片，也可以在任务列表中创建新任务。备用命令：\n/codex list\n/codex read 任务ID\n/codex watch 任务ID\n/codex unwatch 任务ID\n/codex watches\n/codex status\n/codex send 任务ID 消息';
const keyOf = value => createHash('sha256').update(value).digest('hex').slice(0, 40);
const safeCode = error => /^[A-Z_]+$/.test(error?.code || '') ? error.code : 'LOCAL_ERROR';
// An IPC error response is an explicit refusal from the Desktop owner. Only
// timeouts and disconnects are ambiguous; keep their fence to prevent replay.
const definiteSendErrors = new Set(['TASK_RUNNING', 'TASK_NOT_LOADED', 'THREAD_NOT_FOUND', 'INVALID_HISTORY_PATH', 'HISTORY_TOO_LARGE', 'INDEX_UNAVAILABLE', 'INVALID_INPUT', 'SEND_DISABLED', 'SEND_IN_PROGRESS', 'TURN_NOT_RUNNING', 'DESKTOP_REJECTED', 'APP_SERVER_REJECTED']);
const supportedMessageTypes = new Set(['text', 'post', 'image', 'file', 'audio', 'media', 'video']);
const SUBMISSION_RECOVERY_MS = 60 * 1000;
const STREAM_REFRESH_MS = 8 * 60 * 1000;
const STREAM_RECOVERY_COOLDOWN_MS = 60 * 1000;
const deliveryDetails = error => ({
  cause: safeCode(error),
  ...(Number.isSafeInteger(error?.remoteCode) ? { remoteCode: error.remoteCode } : {}),
});

function shouldStayQuiet(text) {
  return typeof text === 'string' && (/<decision>\s*DONT_NOTIFY\s*<\/decision>/i.test(text)
    || /"decision"\s*:\s*"DONT_NOTIFY"/i.test(text));
}

function statusText(value) {
  if (value === 'running' || value === 'inProgress') return '运行中';
  if (value === 'interrupted') return '已中断';
  if (value === 'completed') return '已完成';
  if (value === 'idle') return '空闲';
  return '未知';
}

function resultMessageId(result) {
  const value = result?.message_id ?? result?.messageId ?? result?.data?.message_id;
  if (!messageId(value)) throw Object.assign(new Error('Feishu response omitted message id'), { code: 'DELIVERY_INVALID_RESPONSE' });
  return value;
}

function taskTitle(value, submitted = '') {
  const title = typeof value === 'string' ? value.trim() : '';
  if (title && title !== 'Codex 任务') return title;
  const firstLine = typeof submitted === 'string' ? submitted.split(/\r?\n/, 1)[0].trim() : '';
  return firstLine.slice(0, 80) || 'Codex 任务';
}

function outputImagePaths(text) {
  if (typeof text !== 'string') return [];
  const paths = [];
  for (const match of text.matchAll(/!\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    let value = match[1].trim();
    if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
    if (value.startsWith('file://')) {
      try { value = decodeURIComponent(new URL(value).pathname); } catch { continue; }
    }
    if (!isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) continue;
    if (!/\.(?:png|jpe?g|gif|webp)$/i.test(value)) continue;
    if (!paths.includes(value)) paths.push(value);
    if (paths.length === 4) break;
  }
  return paths;
}

const PROJECTLESS = 'projectless';

function threadProjectKey(thread, forcedProjectless = new Set()) {
  if (forcedProjectless.has(thread?.id) && thread?.projectIdSource !== 'explicit') return PROJECTLESS;
  const projectId = typeof thread?.projectId === 'string' ? thread.projectId.trim() : '';
  return projectId ? `project:${projectId}` : PROJECTLESS;
}

function groupedProjects(threads, forcedProjectless = new Set()) {
  const groups = new Map([[PROJECTLESS, {
    key: PROJECTLESS, title: '无项目', count: 0, projectId: null, cwd: null,
  }]]);
  for (const thread of threads) {
    const key = threadProjectKey(thread, forcedProjectless);
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (!existing.cwd && typeof thread.projectRoot === 'string') existing.cwd = thread.projectRoot;
      continue;
    }
    const projectId = thread.projectId.trim();
    const title = typeof thread.projectName === 'string' && thread.projectName.trim()
      ? thread.projectName.trim() : `Codex 项目 ${projectId.slice(0, 8)}`;
    groups.set(key, {
      key, title, count: 1, projectId,
      cwd: typeof thread.projectRoot === 'string' && thread.projectRoot ? thread.projectRoot : null,
    });
  }
  return [...groups.values()];
}

function messageResources(messageType, content) {
  if (messageType === 'text') return [];
  const resources = [];
  const add = (key, type) => {
    if (typeof key !== 'string' || !/^(?:img|file)_[A-Za-z0-9_-]{1,240}$/.test(key)) return;
    if (!resources.some(resource => resource.key === key)) resources.push({ key, type });
  };
  for (const match of content.matchAll(/!\[[^\]]*\]\((img_[A-Za-z0-9_-]{1,240})\)/g)) add(match[1], 'image');
  for (const match of content.matchAll(/<(?:file|audio|video|media)\b[^>]*\bkey="(file_[A-Za-z0-9_-]{1,240})"[^>]*\/?\s*>/g)) add(match[1], 'file');
  try {
    const parsed = JSON.parse(content);
    const visit = value => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      add(value.image_key, 'image');
      add(value.file_key, 'file');
      Object.values(value).forEach(visit);
    };
    visit(parsed);
  } catch { /* processed events normally contain human-readable markers */ }
  return resources.slice(0, 4);
}

function richTextCaption(value) {
  if (!value || typeof value !== 'object') return '';
  if (!Array.isArray(value) && (typeof value.title === 'string' || Array.isArray(value.content))) {
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    const inline = node => {
      if (typeof node === 'string') return node;
      if (Array.isArray(node)) return node.map(inline).join('');
      if (!node || typeof node !== 'object') return '';
      if (typeof node.text === 'string') return node.text;
      if (node.tag === 'at' && typeof node.user_name === 'string') return `@${node.user_name}`;
      return '';
    };
    const body = Array.isArray(value.content)
      ? value.content.map(paragraph => inline(paragraph).trim()).filter(Boolean).join('\n')
      : '';
    return [title, body].filter(Boolean).join('\n');
  }
  for (const child of Object.values(value)) {
    const caption = richTextCaption(child);
    if (caption) return caption;
  }
  return '';
}

function messageCaption(messageType, content) {
  if (messageType === 'text') return content.trim();
  if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(content)) {
    try { return richTextCaption(JSON.parse(content)); } catch { return ''; }
  }
  return content
    .replace(/!\[[^\]]*\]\(img_[A-Za-z0-9_-]{1,240}\)/g, '')
    .replace(/<(?:file|audio|video|media)\b[^>]*\bkey="file_[A-Za-z0-9_-]{1,240}"[^>]*\/?\s*>/g, '')
    .trim();
}

export class BridgeStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS deliveries (key TEXT PRIMARY KEY, status TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS submissions (thread TEXT PRIMARY KEY, turn TEXT, created INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS watches (owner TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, terminal TEXT, PRIMARY KEY(owner,chat,thread));
      CREATE TABLE IF NOT EXISTS topics (owner TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, root_message TEXT NOT NULL UNIQUE, PRIMARY KEY(owner,chat,thread));
      CREATE TABLE IF NOT EXISTS picker_refs (card_message TEXT NOT NULL, ref TEXT NOT NULL, owner TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(card_message,ref));
      CREATE TABLE IF NOT EXISTS project_refs (card_message TEXT NOT NULL, ref TEXT NOT NULL, owner TEXT NOT NULL, chat TEXT NOT NULL, project TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(card_message,ref));
      CREATE TABLE IF NOT EXISTS bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS discovered_threads (owner TEXT NOT NULL, thread TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY(owner,thread));
      CREATE TABLE IF NOT EXISTS projectless_tasks (thread TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS progress_streams (owner TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL, card_id TEXT NOT NULL, message_id TEXT, sequence INTEGER NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, refreshed INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner,chat,thread,turn));`);
    const streamColumns = this.db.prepare('PRAGMA table_info(progress_streams)').all();
    if (!streamColumns.some(column => column.name === 'refreshed')) {
      this.db.exec('ALTER TABLE progress_streams ADD COLUMN refreshed INTEGER NOT NULL DEFAULT 0');
    }
    if (!streamColumns.some(column => column.name === 'generation')) {
      this.db.exec('ALTER TABLE progress_streams ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }
    if (!streamColumns.some(column => column.name === 'failures')) {
      this.db.exec('ALTER TABLE progress_streams ADD COLUMN failures INTEGER NOT NULL DEFAULT 0');
    }
    const pickerColumns = this.db.prepare('PRAGMA table_info(picker_refs)').all();
    if (!pickerColumns.some(column => column.name === 'kind')) this.db.exec("ALTER TABLE picker_refs ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'");
    if (!pickerColumns.some(column => column.name === 'project')) this.db.exec('ALTER TABLE picker_refs ADD COLUMN project TEXT');
    const submissionColumns = this.db.prepare('PRAGMA table_info(submissions)').all();
    if (!submissionColumns.some(column => column.name === 'created')) this.db.exec('ALTER TABLE submissions ADD COLUMN created INTEGER NOT NULL DEFAULT 0');
  }
  claim(key) { return this.db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?)').run(key, 'claimed', Date.now()).changes > 0; }
  finish(key, status) { this.db.prepare('UPDATE deliveries SET status=? WHERE key=?').run(status, key); }
  watches() { return this.db.prepare('SELECT * FROM watches').all(); }
  watch(owner, chat, thread, terminal) { this.db.prepare('INSERT OR IGNORE INTO watches VALUES (?,?,?,?)').run(owner, chat, thread, terminal); }
  unwatch(owner, chat, thread) { this.db.prepare('DELETE FROM watches WHERE owner=? AND chat=? AND thread=?').run(owner, chat, thread); }
  advance(watch, terminal) { this.db.prepare('UPDATE watches SET terminal=? WHERE owner=? AND chat=? AND thread=?').run(terminal, watch.owner, watch.chat, watch.thread); }
  submission(thread) { return this.db.prepare('SELECT * FROM submissions WHERE thread=?').get(thread); }
  reserve(thread, created = Date.now()) { return this.db.prepare('INSERT OR IGNORE INTO submissions (thread,turn,created) VALUES (?,NULL,?)').run(thread, created).changes > 0; }
  accepted(thread, turn) { this.db.prepare('UPDATE submissions SET turn=? WHERE thread=?').run(turn, thread); }
  release(thread) { this.db.prepare('DELETE FROM submissions WHERE thread=?').run(thread); }
  topic(owner, chat, thread) { return this.db.prepare('SELECT * FROM topics WHERE owner=? AND chat=? AND thread=?').get(owner, chat, thread); }
  topicForOwner(owner, thread) { return this.db.prepare('SELECT * FROM topics WHERE owner=? AND thread=? ORDER BY rowid DESC LIMIT 1').get(owner, thread); }
  topicByRoot(owner, chat, root) { return this.db.prepare('SELECT * FROM topics WHERE owner=? AND chat=? AND root_message=?').get(owner, chat, root); }
  saveTopic(owner, chat, thread, root) { this.db.prepare('INSERT OR REPLACE INTO topics VALUES (?,?,?,?)').run(owner, chat, thread, root); }
  savePicker(card, ref, owner, chat, thread, expires, kind = 'thread', project = null) {
    this.db.prepare(`INSERT OR REPLACE INTO picker_refs
      (card_message,ref,owner,chat,thread,expires,kind,project) VALUES (?,?,?,?,?,?,?,?)`)
      .run(card, ref, owner, chat, thread, expires, kind, project);
  }
  picker(card, ref, owner, chat, now) { return this.db.prepare('SELECT * FROM picker_refs WHERE card_message=? AND ref=? AND owner=? AND chat=? AND expires>=?').get(card, ref, owner, chat, now); }
  saveProject(card, ref, owner, chat, project, expires) { this.db.prepare('INSERT OR REPLACE INTO project_refs VALUES (?,?,?,?,?,?)').run(card, ref, owner, chat, project, expires); }
  project(card, ref, owner, chat, now) { return this.db.prepare('SELECT * FROM project_refs WHERE card_message=? AND ref=? AND owner=? AND chat=? AND expires>=?').get(card, ref, owner, chat, now); }
  purgePickers(now) {
    this.db.prepare('DELETE FROM picker_refs WHERE expires<?').run(now);
    this.db.prepare('DELETE FROM project_refs WHERE expires<?').run(now);
  }
  discoveryInitialized(owner) { return this.db.prepare('SELECT 1 FROM bridge_meta WHERE key=?').get(`discovery:${owner}`) !== undefined; }
  initializeDiscovery(owner) { this.db.prepare('INSERT OR REPLACE INTO bridge_meta VALUES (?,?)').run(`discovery:${owner}`, String(Date.now())); }
  discovered(owner, thread) { return this.db.prepare('SELECT 1 FROM discovered_threads WHERE owner=? AND thread=?').get(owner, thread) !== undefined; }
  markDiscovered(owner, thread) { this.db.prepare('INSERT OR IGNORE INTO discovered_threads VALUES (?,?,?)').run(owner, thread, Date.now()); }
  markProjectless(thread) { this.db.prepare('INSERT OR IGNORE INTO projectless_tasks VALUES (?)').run(thread); }
  projectlessThreads() { return new Set(this.db.prepare('SELECT thread FROM projectless_tasks').all().map(row => row.thread)); }
  progressStream(owner, chat, thread, turn) { return this.db.prepare('SELECT * FROM progress_streams WHERE owner=? AND chat=? AND thread=? AND turn=?').get(owner, chat, thread, turn); }
  progressStreams(owner, chat, thread) { return this.db.prepare('SELECT * FROM progress_streams WHERE owner=? AND chat=? AND thread=?').all(owner, chat, thread); }
  saveProgressStream(owner, chat, thread, turn, cardId, messageId, contentHash = '', generation = 0, refreshed = Date.now()) {
    this.db.prepare(`INSERT OR REPLACE INTO progress_streams
      (owner,chat,thread,turn,card_id,message_id,sequence,content_hash,status,refreshed,generation,failures) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)`)
      // Creating a CardKit entity does not consume an operation sequence.
      // The first element/settings operation must therefore use sequence 1.
      .run(owner, chat, thread, turn, cardId, messageId || null, 0, contentHash, 'open', refreshed, generation);
  }
  advanceProgressStream(stream, sequence, contentHash, status = 'open', refreshed = Date.now()) {
    this.db.prepare(`UPDATE progress_streams SET sequence=?, content_hash=?, status=?, refreshed=?, failures=0
      WHERE owner=? AND chat=? AND thread=? AND turn=?`)
      .run(sequence, contentHash, status, refreshed, stream.owner, stream.chat, stream.thread, stream.turn);
  }
  failProgressStream(stream) {
    this.db.prepare(`UPDATE progress_streams SET failures=failures+1
      WHERE owner=? AND chat=? AND thread=? AND turn=?`).run(stream.owner, stream.chat, stream.thread, stream.turn);
    return this.progressStream(stream.owner, stream.chat, stream.thread, stream.turn).failures;
  }
  clearProgressStreams(owner, chat, thread) { this.db.prepare('DELETE FROM progress_streams WHERE owner=? AND chat=? AND thread=?').run(owner, chat, thread); }
  close() { this.db.close(); }
}

export class Bridge {
  constructor({ desktop, transport, store, allowedUsers, now = Date.now, log = () => {} }) {
    if (!Array.isArray(allowedUsers) || !allowedUsers.length || allowedUsers.some(x => !openId(x))) throw new Error('allowedUsers must contain explicit Feishu open_ids');
    this.desktop = desktop; this.transport = transport; this.store = store;
    this.users = new Set(allowedUsers); this.now = now; this.log = log;
    this.pendingSubmissions = new Set();
  }

  async handle(event) {
    if (event?.type === 'im.message.receive_v1') return this.handleMessage(event);
    if (event?.type === 'card.action.trigger') return this.handleCard(event);
  }

  validTime(value) {
    const candidates = [];
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) candidates.push(numeric, numeric * 1000, numeric / 1000, numeric / 1_000_000);
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) candidates.push(parsed);
    }
    return candidates.some(candidate => this.now() - candidate <= 300000 && candidate - this.now() <= 30000);
  }

  async handleMessage(event) {
    if (event.sender_type !== 'user' || !this.users.has(event.sender_id) || event.chat_type !== 'p2p'
      || !supportedMessageTypes.has(event.message_type) || !chatId(event.chat_id) || !messageId(event.message_id)
      || typeof event.content !== 'string' || !event.content.trim() || event.content.length > 16000 || !this.validTime(event.create_time)) return;
    const isCommand = event.message_type === 'text' && /^\/codex(?:\s|$)/.test(event.content);
    const topic = messageId(event.root_id) ? this.store.topicByRoot(event.sender_id, event.chat_id, event.root_id) : null;
    if (!isCommand && !topic) return;
    const deliveryKey = 'message:' + event.message_id;
    if (!this.store.claim(deliveryKey)) return;
    let response;
    try {
      if (isCommand) response = await this.command(event);
      else {
        const input = await this.messageInput(event);
        let history;
        try { history = await this.desktop.readThread({ threadId: topic.thread, limit: 1 }); } catch { /* submit reports the authoritative error */ }
        await this.submit(topic.thread, input.text, `feishu-thread:${event.message_id}`, input.images);
        try {
          await this.transport.replaceCard({ messageId: topic.root_message, card: taskTopicCard({
            title: taskTitle(history?.thread?.title, input.summary), status: '运行中', submitted: input.summary,
            note: 'Codex 已收到。阶段进展和最终结果会回复到本话题。',
          }) });
        } catch { this.log({ operation: 'topic-update', code: 'DELIVERY_UNCERTAIN' }); }
        try {
          await this.transport.react({ messageId: event.message_id, emojiType: 'OnIt' });
        } catch { this.log({ operation: 'topic-reaction', code: 'DELIVERY_UNCERTAIN' }); }
        response = null;
      }
    } catch (error) {
      const code = safeCode(error);
      const text = code === 'MEDIA_DOWNLOAD_FAILED'
        ? '附件下载失败（MEDIA_DOWNLOAD_FAILED）。请确认飞书应用已开通 `im:message:readonly`，然后重新发送这条附件消息。'
        : code === 'UNSUPPORTED_MEDIA'
          ? '这条消息里没有可处理的图片或文件（UNSUPPORTED_MEDIA）。'
          : `操作未完成（${code}）。请在本机检查日志和任务状态；不要盲目重发。`;
      this.log({ operation: 'command', code });
      try {
        const errorTopic = topic || (id(error?.thread) ? this.store.topic(event.sender_id, event.chat_id, error.thread) : null);
        if (errorTopic) await this.transport.reply({ messageId: errorTopic.root_message, text, key: keyOf(deliveryKey + ':error'), inThread: true });
        else await this.transport.send({ chatId: event.chat_id, text, key: keyOf(deliveryKey + ':error') });
        this.store.finish(deliveryKey, 'sent');
      } catch { this.store.finish(deliveryKey, 'uncertain'); this.log({ operation: 'reply', code: 'DELIVERY_UNCERTAIN' }); }
      return;
    }
    try {
      if (response) await this.deliverResponse(event, response, deliveryKey);
      this.store.finish(deliveryKey, 'sent');
    } catch {
      this.store.finish(deliveryKey, 'uncertain');
      this.log({ operation: 'ack', code: 'DELIVERY_UNCERTAIN' });
    }
  }

  async messageInput(event) {
    if (event.message_type === 'text') return { text: event.content.trim(), images: [], summary: event.content.trim() };
    const resources = messageResources(event.message_type, event.content);
    const caption = messageCaption(event.message_type, event.content);
    if (!resources.length) {
      if (event.message_type === 'post' && caption) return { text: caption, images: [], summary: caption };
      throw Object.assign(new Error('No supported resource in message'), { code: 'UNSUPPORTED_MEDIA' });
    }
    let downloaded;
    try {
      downloaded = await Promise.all(resources.map(resource => this.transport.downloadResource({
        messageId: event.message_id,
        fileKey: resource.key,
        type: resource.type,
      })));
    } catch {
      throw Object.assign(new Error('Unable to download Feishu message resource'), { code: 'MEDIA_DOWNLOAD_FAILED' });
    }
    const images = [], files = [];
    downloaded.forEach((resource, index) => {
      if (resources[index].type === 'image') images.push(resource.path);
      else files.push(resource.path);
    });
    const attachmentSummary = [images.length ? `图片 ${images.length} 张` : '', files.length ? `文件 ${files.length} 个` : ''].filter(Boolean).join('，');
    const summary = [caption, attachmentSummary ? `附件：${attachmentSummary}` : ''].filter(Boolean).join('\n');
    const filePrompt = files.length ? `\n\n已下载的飞书附件路径：\n${files.map(path => `- ${path}`).join('\n')}` : '';
    const text = `${caption || (images.length ? '请查看并处理我发送的图片。' : '请读取并处理我发送的文件。')}${filePrompt}`;
    return { text, images, summary: summary || '附件' };
  }

  async deliverResponse(event, response, deliveryKey) {
    if (response.kind === 'picker') return;
    if (response.root) return this.transport.reply({ messageId: response.root, text: response.text.slice(0, 4000), key: keyOf(deliveryKey), inThread: true });
    return this.transport.send({ chatId: event.chat_id, text: response.text.slice(0, 4000), key: keyOf(deliveryKey) });
  }

  async command(event) {
    const tokens = event.content.trim().split(/\s+/);
    const [, verb, thread, ...rest] = tokens;
    if (!verb) { await this.sendPicker(event); return { kind: 'picker' }; }
    if (verb === 'help') return { text: help };
    if (verb === 'status') return { text: `本地飞书桥接已连接。卡片选择、任务主题和完成通知已启用；桌面消息发送${this.desktop.sendEnabled ? '已启用' : '未启用'}。` };
    if (verb === 'list' && tokens.length === 2) {
      const { threads } = await this.desktop.listThreads({ limit: 20 });
      return { text: threads.map(t => `${t.title}\n${t.id}`).join('\n\n') || '暂无任务' };
    }
    if (verb === 'watches' && tokens.length === 2) return { text: this.store.watches().filter(w => w.owner === event.sender_id && w.chat === event.chat_id).map(w => w.thread).join('\n') || '暂无订阅' };
    if (!id(thread)) return { text: help };
    if (verb === 'send') {
      const match = /^\/codex\s+send\s+\S+\s([\s\S]*)$/.exec(event.content);
      const text = match?.[1];
      if (!text?.trim()) return { text: '用法：/codex send 任务ID 消息内容' };
      const topic = await this.ensureTopic(event.sender_id, event.chat_id, thread);
      const result = await this.submit(thread, text, `feishu:${event.message_id}`);
      return { root: topic.root_message, text: `已提交给 Codex\n\n你：${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}\n\n轮次：${result.turnId}\n状态：${result.status}` };
    }
    if (rest.length) return { text: help };
    if (verb === 'unwatch') {
      const topic = this.store.topic(event.sender_id, event.chat_id, thread);
      this.store.unwatch(event.sender_id, event.chat_id, thread);
      return { root: topic?.root_message, text: '已取消该任务的完成通知。' };
    }
    if (!['read', 'watch'].includes(verb)) return { text: help };
    const history = await this.desktop.readThread({ threadId: thread, limit: 2 });
    const topic = await this.ensureTopic(event.sender_id, event.chat_id, thread, history);
    if (verb === 'watch') {
      if (this.store.watches().length >= 50 && !this.store.watches().some(w => w.owner === event.sender_id && w.chat === event.chat_id && w.thread === thread)) return { root: topic.root_message, text: '最多订阅 50 个任务，请先取消部分订阅。' };
      this.store.watch(event.sender_id, event.chat_id, thread, history.lastTerminal?.turnId || null);
      return { root: topic.root_message, text: '已订阅该任务。后续完成或中断会发送到本主题；已有结果不补发。' };
    }
    const messages = history.messages.slice(-8).reverse().map(m => `${m.role === 'user' ? '你' : 'Codex'}：${m.text.slice(0, 400)}${m.text.length > 400 ? '…[消息截断]' : ''}`).join('\n\n');
    return { root: topic.root_message, text: `状态：${history.observedStatus}（已落盘快照，最新消息在前）\n\n${messages || '暂无消息'}${history.window?.truncated ? '\n[历史已截断]' : ''}` };
  }

  async sendPicker(event) {
    const { threads } = await this.desktop.listThreads({ limit: 200 });
    const projectless = this.store.projectlessThreads();
    const expires = this.now() + 30 * 60 * 1000;
    const projects = groupedProjects(threads, projectless).slice(0, 12).map(project => ({ ...project, ref: randomBytes(12).toString('base64url') }));
    this.store.purgePickers(this.now());
    const result = await this.transport.sendCard({ chatId: event.chat_id, card: projectPickerCard({ projects }), key: keyOf(`picker:${event.message_id}`) });
    const root = resultMessageId(result);
    for (const project of projects) this.store.saveProject(root, project.ref, event.sender_id, event.chat_id, project.key, expires);
  }

  async showTaskPicker(event, projectKey, deliveryKey, error = '') {
    const { threads } = await this.desktop.listThreads({ limit: 200 });
    const projectless = this.store.projectlessThreads();
    const project = groupedProjects(threads, projectless).find(candidate => candidate.key === projectKey);
    if (!project) throw Object.assign(new Error('Codex project is no longer available'), { code: 'PROJECT_NOT_FOUND' });
    const recent = threads.filter(task => id(task.id) && threadProjectKey(task, projectless) === projectKey).slice(0, 11);
    const snapshots = await Promise.allSettled(recent.map(task => this.desktop.readThread({ threadId: task.id, limit: 1 })));
    const tasks = [{
      ref: randomBytes(12).toString('base64url'), title: '＋ 创建新任务', status: '请填写下方任务描述', thread: '', kind: 'new', project: projectKey,
    }, ...recent.map((task, index) => {
      const snapshot = snapshots[index].status === 'fulfilled' ? snapshots[index].value : null;
      const submitted = snapshot?.messages?.filter(message => message.role === 'user').at(-1)?.text || '';
      return {
        ref: randomBytes(12).toString('base64url'),
        title: taskTitle(snapshot?.thread?.title || task.title, submitted),
        status: statusText(snapshot?.observedStatus ?? task.status ?? task.observedStatus),
        updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : '',
        thread: task.id,
        kind: 'thread',
        project: projectKey,
      };
    })];
    const visible = await this.showSourceCardResult(event, deliveryKey, {
      card: pickerCard({ tasks, projectTitle: project.title, error }),
      fallback: error || `已选择项目 ${project.title}，请重新发送 /codex 继续选择任务。`,
    });
    if (!visible) return false;
    const expires = this.now() + 30 * 60 * 1000;
    for (const task of tasks) this.store.savePicker(
      event.message_id, task.ref, event.operator_id, event.chat_id, task.thread, expires, task.kind, projectKey,
    );
    return true;
  }

  async ensureTopic(owner, chat, thread, existingHistory) {
    const existing = this.store.topic(owner, chat, thread);
    if (existing) return existing;
    const history = existingHistory ?? await this.desktop.readThread({ threadId: thread, limit: 1 });
    const submitted = history.messages.filter(message => message.role === 'user').at(-1)?.text || '';
    const result = await this.transport.sendCard({ chatId: chat, card: taskTopicCard({ title: taskTitle(history.thread.title, submitted), status: statusText(history.observedStatus), submitted }), key: keyOf(`topic:${owner}:${chat}:${thread}`) });
    const root = resultMessageId(result);
    this.store.saveTopic(owner, chat, thread, root);
    this.store.watch(owner, chat, thread, history.lastTerminal?.turnId || null);
    return this.store.topic(owner, chat, thread);
  }

  async showRecentSnapshot(topic, history) {
    const turnId = history.observedStatus === 'running' ? history.turnId : history.lastTerminal?.turnId || history.turnId;
    if (!id(turnId)) return false;
    const messages = history.messages.filter(message => message.turnId === turnId && message.role === 'assistant');
    const progress = messages.filter(message => message.phase === 'commentary' && typeof message.text === 'string' && message.text.trim());
    const activities = (history.activities || []).filter(activity => activity.turnId === turnId);
    let content = streamingProgressText(progress, activities);
    const final = history.observedStatus === 'running' ? '' : streamingFinalText(
      messages.filter(message => message.phase === 'final_answer').at(-1),
    );
    if (final) content = `${content ? `${content}\n\n---\n\n` : ''}**最近结果**\n\n${final}`.slice(0, 12_000);
    if (!content) return false;
    const startKey = `stream:attach:${topic.owner}:${topic.chat}:${topic.thread}:${turnId}:${keyOf(topic.root_message)}`;
    if (!this.store.claim(startKey)) return false;
    try {
      const completed = history.observedStatus !== 'running';
      const started = await this.transport.startStreamingCard({
        messageId: topic.root_message,
        card: streamingProgressCard({ title: taskTitle(history.thread.title), content, completed }),
        key: keyOf(startKey),
      });
      this.store.saveProgressStream(topic.owner, topic.chat, topic.thread, turnId, started.cardId, started.messageId, keyOf(content), 0, this.now());
      if (completed) {
        const stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
        await this.transport.closeStreamingCard({ cardId: stream.card_id, summary: `${taskTitle(history.thread.title)} · 最近进展`, sequence: 1 });
        this.store.advanceProgressStream(stream, 1, stream.content_hash, 'closed', this.now());
      }
      this.store.finish(startKey, 'sent');
      return true;
    } catch {
      this.store.finish(startKey, 'uncertain');
      this.log({ operation: 'progress-attach', code: 'DELIVERY_UNCERTAIN' });
      return false;
    }
  }

  async syncThreads() {
    const { threads } = await this.desktop.listThreads({ limit: 100 });
    const tasks = threads.filter(task => id(task.id));
    for (const owner of this.users) {
      if (!this.store.discoveryInitialized(owner)) {
        for (const task of tasks) this.store.markDiscovered(owner, task.id);
        this.store.initializeDiscovery(owner);
        this.log({ operation: 'discovery', code: 'BASELINE_CREATED', count: tasks.length });
        continue;
      }
      for (const task of tasks) {
        if (this.store.discovered(owner, task.id)) continue;
        const existing = this.store.topicForOwner(owner, task.id);
        if (existing) {
          this.store.markDiscovered(owner, task.id);
          continue;
        }
        let history;
        try { history = await this.desktop.readThread({ threadId: task.id, limit: 2 }); }
        catch {
          this.log({ operation: 'discovery', code: 'READ_FAILED' });
          continue;
        }
        const submitted = history.messages.filter(message => message.role === 'user').at(-1)?.text || '';
        // A brand-new Desktop task appears in the index before its first message is
        // necessarily durable. Leave it undiscovered so the next poll can enrich it.
        if (!submitted.trim()) continue;
        const deliveryKey = `topic:auto:${owner}:${task.id}`;
        if (!this.store.claim(deliveryKey)) {
          this.store.markDiscovered(owner, task.id);
          continue;
        }
        try {
          const title = taskTitle(history.thread.title || task.title, submitted);
          const result = await this.transport.sendCardToUser({
            userId: owner,
            card: taskTopicCard({
              title,
              status: statusText(history.observedStatus),
              submitted,
              note: '本地 bridge 已自动跟踪这个任务。阶段进展和最终结果会回复到本话题。',
            }),
            key: keyOf(deliveryKey),
          });
          const root = resultMessageId(result);
          const chat = result?.chat_id ?? result?.chatId ?? result?.data?.chat_id;
          if (!chatId(chat)) throw Object.assign(new Error('Feishu response omitted chat id'), { code: 'DELIVERY_INVALID_RESPONSE' });
          this.store.saveTopic(owner, chat, task.id, root);
          this.store.watch(owner, chat, task.id, null);
          this.store.finish(deliveryKey, 'sent');
        } catch (error) {
          this.store.finish(deliveryKey, 'uncertain');
          this.log({ operation: 'discovery', code: safeCode(error) === 'LOCAL_ERROR' ? 'DELIVERY_UNCERTAIN' : safeCode(error) });
        }
        this.store.markDiscovered(owner, task.id);
      }
    }
  }

  async updateTopicSnapshot(topic, history, note, observedStatus = history.observedStatus) {
    const submitted = history.messages.filter(message => message.role === 'user').at(-1)?.text || '';
    const title = taskTitle(history.thread.title, submitted);
    const status = statusText(observedStatus);
    const snapshotKey = `topic:snapshot:${topic.owner}:${topic.chat}:${topic.thread}:${keyOf(`${title}\n${status}\n${submitted}\n${note || ''}`)}`;
    if (!this.store.claim(snapshotKey)) return;
    try {
      await this.transport.replaceCard({ messageId: topic.root_message, card: taskTopicCard({ title, status, submitted, note }) });
      this.store.finish(snapshotKey, 'sent');
    } catch {
      this.store.finish(snapshotKey, 'uncertain');
      this.log({ operation: 'topic-update', code: 'DELIVERY_UNCERTAIN' });
    }
  }

  async recoverProgressStream(topic, history, turnId, content, stream, { completed = false } = {}) {
    const generation = Number(stream?.generation || 0) + 1;
    if (generation > 2 || !content) {
      if (stream?.status === 'open') this.store.advanceProgressStream(stream, stream.sequence, stream.content_hash, 'exhausted', this.now());
      this.log({ operation: 'progress-stream-recover', code: 'RECOVERY_EXHAUSTED' });
      return false;
    }
    const recoveryKey = `stream:recover:${topic.owner}:${topic.chat}:${topic.thread}:${turnId}:${generation}:${stream.card_id}:${stream.sequence}`;
    if (!this.store.claim(recoveryKey)) return false;
    try {
      const card = streamingProgressCard({
        title: taskTitle(
          history.thread.title,
          history.messages.filter(message => message.role === 'user').at(-1)?.text || '',
        ),
        content,
        completed,
      });
      let started;
      if (messageId(stream?.message_id) && typeof this.transport.createStreamingCard === 'function') {
        try {
          const replacement = await this.transport.createStreamingCard({ card });
          await this.transport.replaceCard({
            messageId: stream.message_id,
            card: { type: 'card', data: { card_id: replacement.cardId } },
          });
          started = { cardId: replacement.cardId, messageId: stream.message_id };
        } catch (error) {
          this.log({ operation: 'progress-stream-rebind', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error) });
        }
      }
      started ||= await this.transport.startStreamingCard({
        messageId: topic.root_message, card, key: keyOf(recoveryKey),
      });
      this.store.saveProgressStream(
        topic.owner, topic.chat, topic.thread, turnId, started.cardId, started.messageId,
        keyOf(content), generation, this.now(),
      );
      this.store.finish(recoveryKey, 'sent');
      return true;
    } catch {
      this.store.finish(recoveryKey, 'uncertain');
      this.log({ operation: 'progress-stream-recover', code: 'DELIVERY_UNCERTAIN' });
      return false;
    }
  }

  async reviveProgressStream(topic, history, turnId, content, stream) {
    if (!content || !messageId(stream?.message_id)) return false;
    const card = streamingProgressCard({
      title: taskTitle(
        history.thread.title,
        history.messages.filter(message => message.role === 'user').at(-1)?.text || '',
      ),
      content,
      streaming: false,
    });
    try {
      await this.transport.replaceCard({
        messageId: stream.message_id,
        card,
      });
      this.store.advanceProgressStream(stream, stream.sequence, keyOf(content), 'static', this.now());
      return true;
    } catch (error) {
      this.log({ operation: 'progress-stream-revive', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error) });
    }

    // Feishu does not allow some exhausted CardKit reference messages to be
    // rebound or converted in place. Create exactly one ordinary card reply,
    // then keep PATCHing that replacement for the rest of the turn.
    const fallbackKey = keyOf(`stream:static:${topic.owner}:${topic.chat}:${topic.thread}:${turnId}`);
    try {
      const sent = await this.transport.replyCard({
        messageId: topic.root_message,
        card,
        key: fallbackKey,
        inThread: true,
      });
      const replacementMessage = resultMessageId(sent);
      this.store.saveProgressStream(
        topic.owner, topic.chat, topic.thread, turnId, stream.card_id, replacementMessage,
        keyOf(content), stream.generation, this.now(),
      );
      const replacement = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
      this.store.advanceProgressStream(replacement, replacement.sequence, replacement.content_hash, 'static', this.now());
      return true;
    } catch (error) {
      this.store.advanceProgressStream(stream, stream.sequence, stream.content_hash, 'exhausted', this.now());
      this.log({ operation: 'progress-stream-revive-fallback', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error) });
      return false;
    }
  }

  async streamProgress(topic, history, turnId, messages, activities = []) {
    const content = streamingProgressText(messages, activities);
    let stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
    if (!content && !stream) return true;
    if (!stream) {
      const startKey = `stream:start:${topic.owner}:${topic.chat}:${topic.thread}:${turnId}`;
      if (!this.store.claim(startKey)) return false;
      try {
        const started = await this.transport.startStreamingCard({
          messageId: topic.root_message,
          card: streamingProgressCard({
            title: taskTitle(
              history.thread.title,
              history.messages.filter(message => message.role === 'user').at(-1)?.text || '',
            ),
            content,
          }),
          key: keyOf(startKey),
        });
        this.store.saveProgressStream(
          topic.owner, topic.chat, topic.thread, turnId, started.cardId, started.messageId,
          keyOf(content), 0, this.now(),
        );
        this.store.finish(startKey, 'sent');
        stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
      } catch {
        this.store.finish(startKey, 'uncertain');
        this.log({ operation: 'progress-stream-start', code: 'DELIVERY_UNCERTAIN' });
        return false;
      }
    }
    if (stream.status === 'static') {
      if (!content) return true;
      const contentHash = keyOf(content);
      if (stream.content_hash === contentHash) return true;
      try {
        await this.transport.replaceCard({
          messageId: stream.message_id,
          card: streamingProgressCard({
            title: taskTitle(
              history.thread.title,
              history.messages.filter(message => message.role === 'user').at(-1)?.text || '',
            ),
            content,
            streaming: false,
          }),
        });
        this.store.advanceProgressStream(stream, stream.sequence, contentHash, 'static', this.now());
        return true;
      } catch (error) {
        this.log({ operation: 'progress-static-update', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error) });
        return false;
      }
    }
    if (stream.status === 'exhausted') {
      if (this.now() - Number(stream.refreshed || 0) < STREAM_RECOVERY_COOLDOWN_MS) return false;
      return this.reviveProgressStream(topic, history, turnId, content, stream);
    }
    if (stream.status !== 'open') return true;
    if (this.now() - Number(stream.refreshed || 0) >= STREAM_REFRESH_MS) {
      const refreshSequence = stream.sequence + 1;
      try {
        await this.transport.resumeStreamingCard({ cardId: stream.card_id, sequence: refreshSequence });
        this.store.advanceProgressStream(stream, refreshSequence, stream.content_hash, 'open', this.now());
        stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
      } catch (error) {
        const failures = this.store.failProgressStream(stream);
        this.log({ operation: 'progress-stream-refresh', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error), failures });
        if (failures < 2) return false;
        return this.recoverProgressStream(topic, history, turnId, content, stream);
      }
    }
    if (!content) return true;
    const contentHash = keyOf(content);
    if (stream.content_hash === contentHash) return true;
    const sequence = stream.sequence + 1;
    try {
      await this.transport.updateStreamingCard({ cardId: stream.card_id, content, sequence });
      this.store.advanceProgressStream(stream, sequence, contentHash, 'open', stream.refreshed);
      return true;
    } catch (error) {
      const failures = this.store.failProgressStream(stream);
      this.log({ operation: 'progress-stream-update', code: 'DELIVERY_UNCERTAIN', ...deliveryDetails(error), failures });
      if (failures < 2) return false;
      if (messageId(stream.message_id)) return this.reviveProgressStream(topic, history, turnId, content, stream);
      return this.recoverProgressStream(topic, history, turnId, content, stream);
    }
  }

  async finalizeProgressStream(topic, history, turnId, final, terminalStatus = 'completed') {
    const stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
    if (!stream) return false;
    const finalText = streamingFinalText(final) || '任务已结束，但本地历史中没有可展示的最终回答。';
    const interrupted = terminalStatus === 'interrupted';
    const label = statusText(terminalStatus);
    const content = `${interrupted ? '**本轮已中断**' : '**✅ 最终结果**'}\n\n${finalText}`;
    if (messageId(stream.message_id)) {
      try {
        await this.transport.replaceCard({
          messageId: stream.message_id,
          card: completionCard({
            title: taskTitle(history.thread.title),
            status: label,
            summary: finalText,
          }),
        });
        this.store.advanceProgressStream(stream, stream.sequence, keyOf(content), 'closed', this.now());
        return true;
      } catch {
        // Older clients may reject replacing a CardKit reference. Continue with
        // the element/settings path so the final result still remains visible.
        this.log({ operation: 'progress-stream-replace', code: 'DELIVERY_UNCERTAIN' });
      }
    }
    if (stream.status !== 'open') return false;
    let sequence = stream.sequence;
    try {
      sequence += 1;
      await this.transport.updateStreamingCard({ cardId: stream.card_id, content, sequence });
      this.store.advanceProgressStream(stream, sequence, keyOf(content), 'open', stream.refreshed);
    } catch {
      this.log({ operation: 'progress-stream-finalize', code: 'DELIVERY_UNCERTAIN' });
      if (interrupted) return false;
      const recovered = await this.recoverProgressStream(topic, history, turnId, content, stream, { completed: true });
      if (!recovered) return false;
      const replacement = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
      const closeSequence = replacement.sequence + 1;
      try {
        await this.transport.closeStreamingCard({ cardId: replacement.card_id, summary: `${taskTitle(history.thread.title)} · 已完成`, sequence: closeSequence });
        this.store.advanceProgressStream(replacement, closeSequence, replacement.content_hash, 'closed', this.now());
      } catch {
        this.store.advanceProgressStream(replacement, replacement.sequence, replacement.content_hash, 'closed', this.now());
        this.log({ operation: 'progress-stream-close', code: 'DELIVERY_UNCERTAIN' });
      }
      return true;
    }
    const stateSequence = sequence + 1;
    try {
      await this.transport.updateStreamingCard({
        cardId: stream.card_id,
        elementId: 'state',
        content: interrupted ? '**Codex 已中断**\n下方保留中断前的最近进展。' : '**Codex 已完成**\n下方内容为最终结果。',
        sequence: stateSequence,
      });
      sequence = stateSequence;
      this.store.advanceProgressStream(stream, sequence, keyOf(content), 'open', stream.refreshed);
    } catch {
      // The final content is already visible, so a state-label failure must not
      // create a duplicate completion card.
      this.log({ operation: 'progress-stream-state', code: 'DELIVERY_UNCERTAIN' });
    }
    const closeSequence = sequence + 1;
    try {
      await this.transport.closeStreamingCard({ cardId: stream.card_id, summary: `${taskTitle(history.thread.title)} · ${label}`, sequence: closeSequence });
      this.store.advanceProgressStream(stream, closeSequence, keyOf(content), 'closed', this.now());
    } catch {
      this.store.advanceProgressStream(stream, sequence, keyOf(content), 'closed', this.now());
      this.log({ operation: 'progress-stream-close', code: 'DELIVERY_UNCERTAIN' });
    }
    return true;
  }

  async deliverOutputImages(topic, history, turnId, text) {
    const roots = [history?.thread?.cwd, '/private/tmp', '/tmp'].filter(value => typeof value === 'string' && isAbsolute(value));
    for (const [index, path] of outputImagePaths(text).entries()) {
      const deliveryKey = `output-image:${topic.owner}:${topic.chat}:${topic.thread}:${turnId}:${index}:${keyOf(path)}`;
      if (!this.store.claim(deliveryKey)) continue;
      try {
        await this.transport.replyImage({
          messageId: topic.root_message,
          path,
          allowedRoots: roots,
          key: keyOf(deliveryKey),
          inThread: true,
        });
        this.store.finish(deliveryKey, 'sent');
      } catch {
        this.store.finish(deliveryKey, 'uncertain');
        this.log({ operation: 'output-image', code: 'DELIVERY_UNCERTAIN' });
      }
    }
  }

  async closeProgressStream(topic, history, turnId) {
    const stream = this.store.progressStream(topic.owner, topic.chat, topic.thread, turnId);
    if (!stream || stream.status !== 'open') return false;
    const sequence = stream.sequence + 1;
    try {
      await this.transport.closeStreamingCard({ cardId: stream.card_id, summary: `${taskTitle(history.thread.title)} · 已结束`, sequence });
      this.store.advanceProgressStream(stream, sequence, stream.content_hash, 'closed', this.now());
      return true;
    } catch {
      this.log({ operation: 'progress-stream-close', code: 'DELIVERY_UNCERTAIN' });
      return false;
    }
  }

  async submit(thread, text, requestKey, images = []) {
    if (this.pendingSubmissions.has(thread)) throw Object.assign(new Error(), { code: 'SEND_IN_PROGRESS', thread });
    this.pendingSubmissions.add(thread);
    try { return await this.submitReserved(thread, text, requestKey, images); }
    finally { this.pendingSubmissions.delete(thread); }
  }

  async submitReserved(thread, text, requestKey, images = []) {
    const previous = this.store.submission(thread);
    if (previous?.turn) {
      // Acceptance completes the send reservation. The task may still be
      // running, but subsequent user messages can steer that active turn.
      this.store.release(thread);
    } else if (previous) {
      const history = await this.desktop.readThread({ threadId: thread, limit: 1, terminalTurnId: previous.turn });
      const staleReservation = !previous.turn && history.observedStatus !== 'running'
        && (previous.created <= 0 || this.now() - previous.created >= SUBMISSION_RECOVERY_MS);
      if (staleReservation) this.store.release(thread);
      else throw Object.assign(new Error(), { code: 'SEND_IN_PROGRESS', thread });
    }
    if (!this.store.reserve(thread, this.now())) throw Object.assign(new Error(), { code: 'SEND_IN_PROGRESS', thread });
    try {
      const result = await this.desktop.sendMessage({ threadId: thread, text, ...(images.length ? { images } : {}) }, { requestKey });
      this.store.accepted(thread, result.turnId);
      return result;
    } catch (error) {
      if (definiteSendErrors.has(error.code)) this.store.release(thread);
      error.thread = thread;
      throw error;
    }
  }

  async showSourceCardResult(event, deliveryKey, { card, fallback }) {
    if (typeof event.token === 'string' && event.token) {
      try {
        await this.transport.updateCard({ token: event.token, card });
        return true;
      } catch { this.log({ operation: 'card-update', code: 'DELIVERY_UNCERTAIN' }); }
    }
    try {
      await this.transport.replaceCard({ messageId: event.message_id, card });
      return true;
    } catch { this.log({ operation: 'card-replace', code: 'DELIVERY_UNCERTAIN' }); }
    try {
      await this.transport.send({ chatId: event.chat_id, text: fallback, key: keyOf(deliveryKey + ':visible') });
      return true;
    } catch { this.log({ operation: 'card-visible-ack', code: 'DELIVERY_UNCERTAIN' }); return false; }
  }

  async submitFromCard(topic, text, event, deliveryKey, { updateSource = false } = {}) {
    let taskTopic = topic;
    let history;
    try { history = await this.desktop.readThread({ threadId: taskTopic.thread, limit: 2 }); } catch { /* submit returns the authoritative error */ }
    const title = history?.thread?.title || 'Codex 任务';
    let result;
    try {
      result = await this.submit(taskTopic.thread, text, `feishu-card:${event.event_id}`);
    } catch (error) {
      const code = safeCode(error);
      let delivered = updateSource ? await this.showSourceCardResult(event, deliveryKey, {
        card: taskTopicCard({
          title, status: '提交失败', submitted: text,
          note: code === 'TASK_NOT_LOADED' ? 'Codex App Server 无法加载这个任务，请确认 Codex 已登录。' : `Codex 未接受这条消息（${code}）。请先查看任务状态。`,
        }),
        fallback: code === 'TASK_NOT_LOADED' ? 'Codex App Server 无法加载这个任务，请确认 Codex 已登录。' : `Codex 未接受这条消息（${code}）。`,
      }) : false;
      if (taskTopic.root_message) {
        try {
          await this.transport.reply({ messageId: taskTopic.root_message, text: `提交未完成（${code}）。请先查看桌面任务状态；本次不会自动重试。`, key: keyOf(deliveryKey + ':error'), inThread: true });
          delivered = true;
        } catch { /* a visible picker receipt may still have succeeded */ }
      }
      this.store.finish(deliveryKey, delivered ? 'sent' : 'uncertain');
      this.log({ operation: 'card-submit', code });
      return;
    }
    let delivered = false;
    if (updateSource) {
      delivered = await this.showSourceCardResult(event, deliveryKey, {
        card: taskTopicCard({ title, status: '运行中', submitted: text, note: 'Codex 已收到。阶段进展和最终结果会回复到本话题。' }),
        fallback: `Codex 已收到“${text.slice(0, 80)}${text.length > 80 ? '…' : ''}”；后续结果会进入任务话题。`,
      });
      this.store.saveTopic(taskTopic.owner, taskTopic.chat, taskTopic.thread, event.message_id);
      this.store.watch(taskTopic.owner, taskTopic.chat, taskTopic.thread, history?.lastTerminal?.turnId || null);
      taskTopic = this.store.topic(taskTopic.owner, taskTopic.chat, taskTopic.thread);
    } else if (!taskTopic.root_message) {
      try { taskTopic = await this.ensureTopic(taskTopic.owner, taskTopic.chat, taskTopic.thread); }
      catch { this.log({ operation: 'card-topic', code: 'DELIVERY_UNCERTAIN' }); }
    }
    if (!updateSource) {
      try {
        if (!taskTopic.root_message) throw new Error('Task topic unavailable');
        await this.transport.reply({ messageId: taskTopic.root_message, text: `已提交给 Codex\n\n你：${text.slice(0, 800)}${text.length > 800 ? '…' : ''}\n\n轮次：${result.turnId}\n状态：${result.status}`, key: keyOf(deliveryKey), inThread: true });
        delivered = true;
      } catch {
        this.log({ operation: 'card-ack', code: 'DELIVERY_UNCERTAIN' });
      }
    }
    this.store.finish(deliveryKey, delivered ? 'sent' : 'uncertain');
  }

  async createFromCard(projectKey, text, event, deliveryKey) {
    let result;
    try {
      const { threads } = await this.desktop.listThreads({ limit: 200 });
      const project = groupedProjects(threads, this.store.projectlessThreads()).find(candidate => candidate.key === projectKey);
      if (!project) throw Object.assign(new Error('Codex project is no longer available'), { code: 'PROJECT_NOT_FOUND' });
      result = await this.desktop.createTask({
        text,
        ...(project.projectId ? { projectId: project.projectId } : {}),
        ...(project.cwd ? { cwd: project.cwd } : {}),
      }, { requestKey: `feishu-card:${event.event_id}` });
    } catch (error) {
      const code = safeCode(error);
      const delivered = await this.showSourceCardResult(event, deliveryKey, {
        card: taskTopicCard({
          title: taskTitle('', text), status: '创建失败', submitted: text,
          note: `Codex 未能创建并启动任务（${code}）。请检查 Codex 登录状态或所选项目。`,
        }),
        fallback: `Codex 未能创建并启动任务（${code}）。`,
      });
      this.store.finish(deliveryKey, delivered ? 'sent' : 'uncertain');
      this.log({ operation: 'card-create', code });
      return;
    }
    this.store.reserve(result.threadId);
    if (projectKey === PROJECTLESS) this.store.markProjectless(result.threadId);
    this.store.accepted(result.threadId, result.turnId);
    const delivered = await this.showSourceCardResult(event, deliveryKey, {
      card: taskTopicCard({
        title: taskTitle('', text), status: '运行中', submitted: text,
        note: '新任务已由 Codex App Server 创建并启动。阶段进展和最终结果会回复到本话题。',
      }),
      fallback: `新任务已创建：${taskTitle('', text)}`,
    });
    this.store.saveTopic(event.operator_id, event.chat_id, result.threadId, event.message_id);
    this.store.watch(event.operator_id, event.chat_id, result.threadId, null);
    this.store.markDiscovered(event.operator_id, result.threadId);
    this.store.finish(deliveryKey, delivered ? 'sent' : 'uncertain');
  }

  async handleCard(event) {
    if (!this.users.has(event.operator_id)) return this.log({ operation: 'card-reject', code: 'CARD_OPERATOR' });
    if (event.host !== 'im_message') return this.log({ operation: 'card-reject', code: 'CARD_HOST' });
    if (!chatId(event.chat_id)) return this.log({ operation: 'card-reject', code: 'CARD_CHAT' });
    if (!messageId(event.message_id)) return this.log({ operation: 'card-reject', code: 'CARD_MESSAGE' });
    if (typeof event.event_id !== 'string' || !id(event.event_id)) return this.log({ operation: 'card-reject', code: 'CARD_EVENT' });
    if (!this.validTime(event.timestamp)) return this.log({ operation: 'card-reject', code: 'CARD_TIME' });
    const deliveryKey = 'card:' + event.event_id;
    let form = null;
    if (typeof event.form_value === 'string' && event.form_value) {
      try { form = JSON.parse(event.form_value); } catch { return this.log({ operation: 'card-reject', code: 'CARD_FORM' }); }
    }
    const projectRef = typeof form?.project_picker === 'string' ? form.project_picker
      : event.action_name === 'project_picker' ? event.option : '';
    const project = id(projectRef) ? this.store.project(event.message_id, projectRef, event.operator_id, event.chat_id, this.now()) : null;
    if (project) {
      if (!this.store.claim(deliveryKey)) return;
      try {
        const visible = await this.showTaskPicker(event, project.project, deliveryKey);
        this.store.finish(deliveryKey, visible ? 'sent' : 'uncertain');
      } catch (error) {
        this.store.finish(deliveryKey, 'uncertain');
        this.log({ operation: 'card-project', code: safeCode(error) });
      }
      return;
    }
    const pickerRef = typeof form?.task_picker === 'string' ? form.task_picker : event.option;
    const selected = id(pickerRef) ? this.store.picker(event.message_id, pickerRef, event.operator_id, event.chat_id, this.now()) : null;
    if (selected) {
      if (!this.store.claim(deliveryKey)) return;
      const text = form && Object.hasOwn(form, 'prompt') ? form.prompt : '';
      if (typeof text !== 'string' || text.length > 1000) {
        this.store.finish(deliveryKey, 'rejected');
        return this.log({ operation: 'card-reject', code: 'CARD_PROMPT' });
      }
      if (selected.kind === 'new') {
        if (!text.trim()) {
          try {
            const visible = await this.showTaskPicker(event, selected.project, deliveryKey, '创建新任务前，请先填写任务描述。');
            this.store.finish(deliveryKey, visible ? 'sent' : 'uncertain');
          } catch (error) {
            this.store.finish(deliveryKey, 'uncertain');
            this.log({ operation: 'card-create', code: safeCode(error) });
          }
          return;
        }
        await this.createFromCard(selected.project, text, event, deliveryKey);
        return;
      }
      if (text.trim()) {
        if (typeof text !== 'string' || text.length > 1000) {
          this.store.finish(deliveryKey, 'rejected');
          return this.log({ operation: 'card-reject', code: 'CARD_PROMPT' });
        }
        await this.submitFromCard({ owner: event.operator_id, chat: event.chat_id, thread: selected.thread }, text, event, deliveryKey, { updateSource: true });
        return;
      }
      try {
        const history = await this.desktop.readThread({ threadId: selected.thread, limit: 2 });
        const submitted = history.messages.filter(message => message.role === 'user').at(-1)?.text || '';
        const visible = await this.showSourceCardResult(event, deliveryKey, {
          card: taskTopicCard({
            title: taskTitle(history.thread.title, submitted), status: statusText(history.observedStatus), submitted,
            note: history.observedStatus === 'running'
              ? '已接入正在运行的任务。下方会恢复并持续刷新最近进展。'
              : '已接入任务。下方展示最近一轮的阶段进展、行为和结果。',
          }),
          fallback: `已接入 ${taskTitle(history.thread.title, submitted)}。`,
        });
        this.store.saveTopic(event.operator_id, event.chat_id, selected.thread, event.message_id);
        this.store.watch(event.operator_id, event.chat_id, selected.thread, history.lastTerminal?.turnId || null);
        this.store.clearProgressStreams(event.operator_id, event.chat_id, selected.thread);
        const topic = this.store.topic(event.operator_id, event.chat_id, selected.thread);
        await this.showRecentSnapshot(topic, history);
        this.store.finish(deliveryKey, visible ? 'sent' : 'uncertain');
      } catch (error) { this.store.finish(deliveryKey, 'uncertain'); this.log({ operation: 'card-picker', code: safeCode(error) }); }
      return;
    }
    const topic = this.store.topicByRoot(event.operator_id, event.chat_id, event.message_id);
    if (!topic) return this.log({ operation: 'card-reject', code: id(pickerRef) ? 'CARD_PICKER_REF' : 'CARD_ACTION' });
    const text = form?.prompt;
    if (typeof text !== 'string' || !text.trim() || text.length > 1000) return this.log({ operation: 'card-reject', code: 'CARD_PROMPT' });
    if (!this.store.claim(deliveryKey)) return;
    await this.submitFromCard(topic, text, event, deliveryKey);
  }

  async poll() {
    for (const watch of this.store.watches()) {
      if (!this.users.has(watch.owner)) continue;
      try {
        const history = await this.desktop.readThread({ threadId: watch.thread, limit: 2 });
        const topic = await this.ensureTopic(watch.owner, watch.chat, watch.thread, history);
        const terminal = history.lastTerminal;
        const relevantTurns = new Set([
          history.observedStatus === 'running' ? history.turnId : null,
          terminal?.turnId,
        ].filter(Boolean));
        for (const stale of this.store.progressStreams(topic.owner, topic.chat, topic.thread)) {
          if (stale.status === 'open' && !relevantTurns.has(stale.turn)) {
            this.store.advanceProgressStream(stale, stale.sequence, stale.content_hash, 'closed', this.now());
          }
        }
        const newTerminal = terminal?.turnId && terminal.turnId !== watch.terminal ? terminal : null;
        const terminalStream = terminal?.turnId
          ? this.store.progressStream(topic.owner, topic.chat, topic.thread, terminal.turnId)
          : null;
        const reconcileTerminal = Boolean(terminal?.turnId && ['open', 'exhausted'].includes(terminalStream?.status));
        const progressTurn = history.observedStatus === 'running' ? history.turnId : terminal?.turnId;
        if (history.observedStatus === 'running') {
          await this.updateTopicSnapshot(topic, history, '任务运行中。阶段进展会在本话题中的同一张流式卡持续更新。');
        } else if (!newTerminal) {
          // Also repair cards created by earlier bridge versions. Those cards may
          // still have the generic title or omit the original prompt even after
          // the task has become idle.
          await this.updateTopicSnapshot(topic, history, '任务已结束。直接回复本话题可以继续这个任务。', terminal?.status || history.observedStatus);
        }
        if (progressTurn) {
          const progress = history.messages.filter(message => message.turnId === progressTurn && message.role === 'assistant'
            && message.phase === 'commentary' && typeof message.text === 'string' && message.text.trim());
          const activities = (history.activities || []).filter(activity => activity.turnId === progressTurn);
          await this.streamProgress(topic, history, progressTurn, progress, activities);
        }
        if (!newTerminal && !reconcileTerminal) continue;
        const completedTurn = newTerminal || terminal;
        const key = `completion:${watch.owner}:${watch.chat}:${watch.thread}:${completedTurn.turnId}`;
        const ownsCompletion = this.store.claim(key);
        const turnMessages = history.messages.filter(message => message.turnId === completedTurn.turnId);
        const submitted = turnMessages.filter(message => message.role === 'user').at(-1)?.text || '';
        const interrupted = completedTurn.status === 'interrupted';
        const final = interrupted
          ? `本轮任务已中断；下方保留中断前的最近进展。\n\n${streamingProgressText(
            turnMessages.filter(message => message.role === 'assistant' && message.phase === 'commentary'),
            (history.activities || []).filter(activity => activity.turnId === completedTurn.turnId),
          )}`
          : turnMessages.filter(message => message.role === 'assistant' && message.phase === 'final_answer').at(-1)?.text
          || turnMessages.filter(message => message.role === 'assistant' && message.phase === 'commentary').at(-1)?.text
          || '任务已结束，但本地历史中没有可展示的最终回答。';
        const stayQuiet = shouldStayQuiet(final);
        const streamFinalized = stayQuiet
          ? await this.closeProgressStream(topic, history, completedTurn.turnId)
          : await this.finalizeProgressStream(topic, history, completedTurn.turnId, final, completedTurn.status);
        if (ownsCompletion && !stayQuiet) {
          try {
            if (!streamFinalized) await this.transport.replyCard({ messageId: topic.root_message, key: keyOf(key), inThread: true, card: completionCard({ title: history.thread.title, status: statusText(completedTurn.status), summary: final }) });
            this.store.finish(key, 'sent');
          } catch { this.store.finish(key, 'uncertain'); this.log({ operation: 'notification', code: 'DELIVERY_UNCERTAIN' }); }
        } else if (ownsCompletion) this.store.finish(key, 'suppressed');
        if (!stayQuiet) await this.deliverOutputImages(topic, history, completedTurn.turnId, final);
        this.store.advance(watch, completedTurn.turnId);
        await this.updateTopicSnapshot(topic, history,
          interrupted ? '本轮任务已中断；话题中保留最近进展。' : stayQuiet ? '任务已结束；该轮请求保持静默。' : '任务已结束，最终结果已回复到这个话题。',
          completedTurn.status);
      } catch (error) { this.log({ operation: 'poll', code: 'READ_FAILED', thread: watch.thread, cause: safeCode(error) }); }
    }
  }
}
