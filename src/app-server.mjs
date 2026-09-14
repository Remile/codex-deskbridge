import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { enrichThreadProjects } from './project-membership.mjs';
import { subagentStatus } from './activity.mjs';

const DEFAULT_BINARY = process.env.CODEX_BIN || 'codex';
const DEFAULT_TIMEOUT_MS = 20_000;

function failure(message, code = 'APP_SERVER_ERROR', status = 502) {
  return Object.assign(new Error(message), { code, status });
}

function uuidFor(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A dependency-free JSONL client for the public Codex App Server protocol. */
export class AppServerClient extends EventEmitter {
  constructor({ binary = DEFAULT_BINARY, args = ['app-server', '--stdio'], spawn = nodeSpawn,
    timeoutMs = DEFAULT_TIMEOUT_MS, clientInfo, onServerRequest } = {}) {
    super();
    this.binary = binary;
    this.args = args;
    this.spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.clientInfo = clientInfo || { name: 'codex_deskbridge', title: 'Codex DeskBridge', version: '0.1.0' };
    this.onServerRequest = onServerRequest;
    this.pending = new Map();
    this.requestId = 0;
    this.child = null;
    this.starting = null;
  }

  async start() {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try { await this.starting; } finally { this.starting = null; }
  }

  async #start() {
    const child = this.spawn(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => this.#receive(line));
    child.stderr.on('data', () => {});
    child.once('error', error => this.#closed(failure(`Unable to start Codex App Server: ${error.message}`, 'APP_SERVER_UNAVAILABLE', 503)));
    child.once('close', code => this.#closed(failure(`Codex App Server exited (${code ?? 'signal'})`, 'APP_SERVER_UNAVAILABLE', 503)));
    await this.request('initialize', { clientInfo: this.clientInfo });
    this.notify('initialized', {});
    this.emit('ready');
  }

  #receive(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit('diagnostic', { code: 'APP_SERVER_INVALID_JSON' }); return; }
    if (message.id !== undefined && typeof message.method !== 'string') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(failure(message.error.message || 'Codex App Server rejected the request', 'APP_SERVER_REJECTED'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      void this.#handleServerRequest(message);
      return;
    }
    if (typeof message.method === 'string') {
      const event = { method: message.method, params: message.params, emittedAtMs: message.emittedAtMs };
      this.emit('notification', event);
      this.emit(message.method, message.params);
    }
  }

  async #handleServerRequest(message) {
    try {
      const result = this.onServerRequest
        ? await this.onServerRequest({ method: message.method, params: message.params })
        : defaultServerRequestResult(message.method, message.params);
      this.#write({ id: message.id, result });
      this.emit('serverRequest', { method: message.method, params: message.params, handled: true });
    } catch (error) {
      this.#write({ id: message.id, error: { code: -32000, message: error?.message || 'Server request was not handled' } });
      this.emit('serverRequest', { method: message.method, params: message.params, handled: false });
    }
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw failure('Codex App Server is not running', 'APP_SERVER_UNAVAILABLE', 503);
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  async request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.child && method !== 'initialize') await this.start();
    const id = ++this.requestId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(failure(`Codex App Server request timed out: ${method}`, 'APP_SERVER_TIMEOUT', 504));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.#write({ id, method, params });
    return result;
  }

  notify(method, params = {}) { this.#write({ method, params }); }

  #closed(error) {
    if (!this.child) return;
    this.child = null;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.emit('closed', { code: error.code });
  }

  async stop() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(failure('Codex App Server stopped', 'APP_SERVER_STOPPED', 503));
    }
    this.pending.clear();
    try { child.stdin.end(); } catch {}
    if (!child.killed) child.kill('SIGTERM');
  }
}

function defaultServerRequestResult(method, params) {
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') return { decision: 'decline' };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
    return { decision: { denied: { rejection: 'No approval handler is configured for this IM adapter.' } } };
  }
  if (method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const question of params?.questions || []) if (typeof question?.id === 'string') answers[question.id] = { answers: [] };
    return { answers };
  }
  throw failure(`Unsupported Codex server request: ${method}`, 'APP_SERVER_REQUEST_UNSUPPORTED');
}

function inputFor({ text, images = [], files = [] }) {
  const input = [];
  if (typeof text === 'string' && text.trim()) input.push({ type: 'text', text, text_elements: [] });
  for (const path of images) input.push({ type: 'localImage', path });
  if (files.length) input.push({ type: 'text', text: `Local attachments available to inspect:\n${files.map(path => `- ${path}`).join('\n')}`, text_elements: [] });
  return input;
}

function validateInput({ text, images = [], files = [] }) {
  if (typeof text !== 'string' || text.length > 16_000 || !Array.isArray(images) || !Array.isArray(files)) throw failure('Message input is invalid.', 'INVALID_INPUT', 400);
  if (!text.trim() && images.length === 0 && files.length === 0) throw failure('Message input is empty.', 'INVALID_INPUT', 400);
  for (const path of [...images, ...files]) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw failure('Attachment path is invalid.', 'INVALID_INPUT', 400);
  }
}

function timestampFor(turn) {
  const seconds = turn.completedAt ?? turn.startedAt;
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined;
}

export function normalizeAppServerItem(item, turn) {
  const base = { id: item.id, timestamp: timestampFor(turn), turnId: turn.id };
  switch (item.type) {
    case 'userMessage': {
      const text = (item.content || []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
      return { ...base, type: 'message', role: 'user', phase: 'user', text };
    }
    case 'agentMessage': return { ...base, type: 'message', role: 'assistant', phase: item.phase || 'final_answer', text: item.text || '' };
    case 'commandExecution': return { ...base, type: 'command', command: typeof item.command === 'string' ? item.command : '', status: item.status, ...(Number.isFinite(item.exitCode) ? { exitCode: item.exitCode } : {}) };
    case 'fileChange': return { ...base, type: 'file_change', status: item.status, files: (item.changes || []).map(change => ({ path: change.path, ...(change.kind ? { kind: typeof change.kind === 'string' ? change.kind : change.kind.type } : {}) })) };
    case 'mcpToolCall': return { ...base, type: 'tool', server: item.server, tool: item.tool, status: item.status };
    case 'subAgentActivity': return { ...base, type: 'subagent', kind: item.kind, status: subagentStatus(item.kind), agentThreadId: item.agentThreadId, agentPath: item.agentPath };
    case 'collabAgentToolCall': return { ...base, type: 'subagent_tool', tool: item.tool, status: item.status, threadIds: item.receiverThreadIds || [] };
    case 'reasoning': {
      const text = Array.isArray(item.summary) ? item.summary.filter(value => typeof value === 'string').join('\n') : '';
      return text ? { ...base, type: 'reasoning_summary', text: text.slice(0, 300) } : null;
    }
    default: return null;
  }
}

/** Runtime adapter used by the framework and by the bundled Feishu adapter. */
export class CodexAppServerRuntime extends EventEmitter {
  constructor({ client = new AppServerClient(), approvalPolicy } = {}) {
    super();
    this.client = client;
    this.approvalPolicy = approvalPolicy;
    this.sendEnabled = true;
    this.pendingTasks = new Set();
    client.on('notification', event => { this.emit('event', event); this.emit('change', event); });
  }

  async start() { await this.client.start(); }
  async stop() { await this.client.stop(); }
  async status() {
    await this.start();
    return { connected: true, transport: 'codex-app-server', scope: 'local-codex-tasks', capabilities: ['list', 'read', 'send', 'create'], experimental: false };
  }

  async listThreads({ limit = 20 } = {}) {
    const [result, projectResult] = await Promise.all([
      this.client.request('thread/list', { limit, sortKey: 'updated_at', sortDirection: 'desc' }),
      this.client.request('project/list', { limit: 100 }).catch(() => ({ data: [] })),
    ]);
    const threads = (result?.data || []).map(thread => ({
      id: thread.id, title: thread.name || thread.preview || 'Codex task', cwd: thread.cwd,
      updated_at: thread.updatedAt, archived: false, model: thread.model, projectId: thread.projectId ?? null, status: thread.status,
    }));
    return { source: 'codex-app-server', scope: 'local-codex-tasks', threads: enrichThreadProjects(threads, projectResult?.data || []) };
  }

  async readThread({ threadId, limit = 10, terminalTurnId } = {}) {
    const result = await this.client.request('thread/read', { threadId, includeTurns: false });
    const thread = result?.thread;
    if (!thread?.id) throw failure('Codex task not found.', 'THREAD_NOT_FOUND', 404);
    const pageLimit = Math.max(limit, terminalTurnId ? 50 : limit);
    const page = await this.client.request('thread/turns/list', { threadId, limit: pageLimit, sortDirection: 'desc', itemsView: 'full' });
    const allTurns = Array.isArray(page?.data) ? [...page.data].reverse() : [];
    const turns = allTurns.slice(-limit);
    const timeline = turns.flatMap(turn => (turn.items || []).map(item => normalizeAppServerItem(item, turn)).filter(Boolean));
    const terminalTurns = allTurns.filter(turn => ['completed', 'interrupted', 'failed'].includes(turn.status));
    const terminal = turn => turn ? { turnId: turn.id, status: turn.status, timestamp: timestampFor(turn) } : null;
    const current = allTurns.at(-1);
    return {
      source: 'codex-app-server', thread: { id: thread.id, title: thread.name || thread.preview || 'Codex task', cwd: thread.cwd, projectId: thread.projectId ?? null },
      observedStatus: current?.status === 'inProgress' ? 'running' : 'idle', statusNote: 'Snapshot returned by the official Codex App Server.',
      snapshotAt: new Date().toISOString(), turnId: current?.id || null, lastTerminal: terminal(terminalTurns.at(-1)),
      requestedTerminal: terminal(terminalTurnId ? terminalTurns.find(turn => turn.id === terminalTurnId) : null),
      window: { unit: 'turns', limit, returnedTurns: turns.length, maxItems: null, truncated: Boolean(page?.nextCursor) || allTurns.length > turns.length },
      messages: timeline.filter(item => item.type === 'message'), activities: timeline.filter(item => item.type !== 'message'), timeline,
    };
  }

  async sendMessage({ threadId, text, images = [], files = [] }, { requestKey } = {}) {
    validateInput({ text, images, files });
    if (this.pendingTasks.has(threadId)) throw failure('Another send is in progress for this task.', 'SEND_IN_PROGRESS', 409);
    this.pendingTasks.add(threadId);
    try {
      const snapshot = await this.readThread({ threadId, limit: 1 });
      const clientUserMessageId = uuidFor(`codex-deskbridge:${threadId}:${requestKey || Date.now()}`);
      if (snapshot.observedStatus === 'running') {
        if (!snapshot.turnId) throw failure('Active turn id is unavailable.', 'TURN_NOT_RUNNING', 409);
        const result = await this.client.request('turn/steer', {
          threadId, clientUserMessageId, input: inputFor({ text, images, files }), expectedTurnId: snapshot.turnId,
        });
        if (result?.turnId !== snapshot.turnId) throw failure('Codex returned an unrecognized steering result.', 'UNKNOWN_SEND_OUTCOME');
        return { threadId, clientUserMessageId, source: 'codex-app-server', turnId: result.turnId, status: 'inProgress', mode: 'steer' };
      }
      await this.client.request('thread/resume', { threadId, excludeTurns: true, ...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}) });
      const result = await this.client.request('turn/start', { threadId, clientUserMessageId, input: inputFor({ text, images, files }),
        turnTrigger: 'codex-deskbridge', ...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}) });
      const turn = result?.turn;
      if (!turn?.id || !['inProgress', 'completed', 'interrupted', 'failed'].includes(turn.status)) throw failure('Codex returned an unrecognized turn.', 'UNKNOWN_SEND_OUTCOME');
      if (turn.status === 'failed' || turn.status === 'interrupted') throw failure(`Codex turn is ${turn.status}.`, 'TURN_NOT_RUNNING', 409);
      return { threadId, clientUserMessageId, source: 'codex-app-server', turnId: turn.id, status: turn.status };
    } finally { this.pendingTasks.delete(threadId); }
  }

  async createTask({ cwd, projectId, text, images = [], files = [] }, { requestKey } = {}) {
    validateInput({ text, images, files });
    if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) throw failure('Project path is invalid.', 'INVALID_INPUT', 400);
    if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 100)) throw failure('Project id is invalid.', 'INVALID_INPUT', 400);
    let project;
    if (cwd !== undefined) {
      try { project = await realpath(cwd); if (!(await stat(project)).isDirectory()) throw new Error(); }
      catch { throw failure('Project directory is unavailable.', 'PROJECT_NOT_FOUND', 404); }
    }
    const started = await this.client.request('thread/start', {
      ...(project ? { cwd: project } : {}), ...(projectId ? { projectId } : {}), serviceName: 'codex_deskbridge',
      ...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}),
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw failure('Codex omitted the new task id.', 'APP_SERVER_INVALID_RESPONSE');
    const clientUserMessageId = uuidFor(`codex-deskbridge:${threadId}:${requestKey || Date.now()}`);
    const result = await this.client.request('turn/start', { threadId, clientUserMessageId, input: inputFor({ text, images, files }),
      turnTrigger: 'codex-deskbridge', ...(this.approvalPolicy ? { approvalPolicy: this.approvalPolicy } : {}) });
    const turn = result?.turn;
    if (!turn?.id || !['inProgress', 'completed'].includes(turn.status)) throw failure('Codex did not accept the first turn.', 'UNKNOWN_SEND_OUTCOME');
    return { threadId, clientUserMessageId, source: 'codex-app-server', turnId: turn.id, status: turn.status };
  }
}

export class AppServerThreadCreator {
  constructor(options = {}) { this.client = options.client || new AppServerClient(options); }
  async createThread({ cwd, projectId, ephemeral = false }) {
    try {
      const result = await this.client.request('thread/start', {
        ...(cwd ? { cwd } : {}), ...(projectId ? { projectId } : {}), serviceName: 'codex_deskbridge', ...(ephemeral ? { ephemeral: true } : {}),
      });
      if (!result?.thread?.id) throw failure('Codex omitted the new task id.', 'APP_SERVER_INVALID_RESPONSE');
      return { threadId: result.thread.id };
    } finally { await this.client.stop(); }
  }
}
