import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { chmod, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const DEFAULT_MAX_TEXT_LENGTH = 4_000;
const MAX_CARD_BYTES = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_EVENT_QUEUE_SIZE = 100;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_RESOURCE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
const CARD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const transportError = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Thin, deliberately bounded adapter around lark-cli.
 *
 * It uses the CLI's processed IM event stream: each stdout line is one JSON
 * object and the consumer is usable only after its stderr ready marker.
 */
export class LarkTransport {
  constructor({
    profile,
    eventKey = 'im.message.receive_v1',
    spawn = nodeSpawn,
    onError = () => {},
    onDiagnostic = () => {},
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    resourceTimeoutMs = DEFAULT_RESOURCE_TIMEOUT_MS,
    resourceDir = resolve(process.cwd(), '.local', 'lark-resources'),
    maxResourceBytes = DEFAULT_MAX_RESOURCE_BYTES,
    maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
    maxBufferBytes = DEFAULT_MAX_BUFFER_BYTES,
    maxEventQueueSize = DEFAULT_EVENT_QUEUE_SIZE,
  } = {}) {
    if (typeof profile !== 'string' || !profile) throw new TypeError('profile must be a non-empty string');
    if (typeof eventKey !== 'string' || !/^[a-z][a-z0-9_.]{2,100}$/.test(eventKey)) throw new TypeError('eventKey is invalid');
    if (typeof resourceDir !== 'string' || !resourceDir.trim()) throw new TypeError('resourceDir must be a non-empty path');
    if (!Number.isSafeInteger(maxResourceBytes) || maxResourceBytes < 1 || maxResourceBytes > 100 * 1024 * 1024) throw new TypeError('maxResourceBytes is invalid');
    this._profile = profile;
    this._eventKey = eventKey;
    this._readyMarker = `[event] ready event_key=${eventKey}`;
    this._spawn = spawn;
    this._onError = onError;
    this._onDiagnostic = onDiagnostic;
    this._readyTimeoutMs = readyTimeoutMs;
    this._commandTimeoutMs = commandTimeoutMs;
    this._resourceTimeoutMs = resourceTimeoutMs;
    this._resourceDir = resolve(resourceDir);
    this._maxResourceBytes = maxResourceBytes;
    this._maxTextLength = maxTextLength;
    this._maxBufferBytes = maxBufferBytes;
    this._maxEventQueueSize = maxEventQueueSize;
    this._consumer = null;
    this._consumerClosed = null;
    this._startupReject = null;
    this._stopPromise = null;
    this._stopping = false;
    this._eventQueue = [];
    this._delivering = false;
  }

  async send({ chatId, text, key }) {
    return this._sendMessage({ operation: '+messages-send', targetFlag: '--chat-id', target: chatId, text, key });
  }

  async sendCard({ chatId, card, key }) {
    return this._sendMessage({ operation: '+messages-send', targetFlag: '--chat-id', target: chatId, card, key });
  }

  async sendCardToUser({ userId, card, key }) {
    return this._sendMessage({ operation: '+messages-send', targetFlag: '--user-id', target: userId, card, key });
  }

  async downloadResource({ messageId, fileKey, type }) {
    if (typeof messageId !== 'string' || !/^om_[\w-]+$/.test(messageId)) throw new TypeError('message id is invalid');
    if (typeof fileKey !== 'string' || !/^(?:img|file)_[A-Za-z0-9_-]{1,240}$/.test(fileKey)) throw new TypeError('resource key is invalid');
    if (!['image', 'file'].includes(type)) throw new TypeError('resource type is invalid');
    await mkdir(this._resourceDir, { recursive: true, mode: 0o700 });
    const output = join(this._resourceDir, `${messageId.slice(-32)}-${fileKey.slice(-96)}`);
    const result = await this._run([
      '--profile', this._profile, 'im', '+messages-resources-download',
      '--message-id', messageId, '--file-key', fileKey, '--type', type,
      '--output', output, '--as', 'bot',
    ], this._resourceTimeoutMs);
    if (result?.ok !== true) throw apiRejection(result);
    const payload = result.data ?? result;
    const savedPath = payload.saved_path ?? payload.data?.saved_path;
    if (typeof savedPath !== 'string' || !savedPath) throw new Error('lark-cli omitted the downloaded path');
    const absolute = resolve(savedPath);
    const rel = relative(this._resourceDir, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('downloaded resource escaped the media directory');
    const info = await stat(absolute);
    if (!info.isFile() || info.size <= 0 || info.size > this._maxResourceBytes) {
      await rm(absolute, { force: true });
      throw new Error('downloaded resource exceeds the media limit');
    }
    await chmod(absolute, 0o600);
    return { path: absolute, sizeBytes: info.size, type };
  }

  async startStreamingCard({ messageId, card, key }) {
    if (typeof messageId !== 'string' || !/^om_[\w-]+$/.test(messageId)) throw new TypeError('message id is invalid');
    const created = await this.createStreamingCard({ card });
    const sent = await this._sendMessage({
      operation: '+messages-reply', targetFlag: '--message-id', target: messageId,
      card: { type: 'card', data: { card_id: created.cardId } }, key, inThread: true,
    });
    return { cardId: created.cardId, messageId: sent?.message_id ?? sent?.messageId ?? sent?.data?.message_id };
  }

  async createStreamingCard({ card }) {
    const serialized = JSON.stringify(card);
    if (!card || typeof card !== 'object' || Buffer.byteLength(serialized) > MAX_CARD_BYTES) throw new RangeError('card exceeds transport limit');
    const created = await this._run([
      '--profile', this._profile, 'api', 'POST', '/open-apis/cardkit/v1/cards', '--as', 'bot',
      '--data', JSON.stringify({ type: 'card_json', data: serialized }),
    ], this._commandTimeoutMs);
    if (created?.ok !== true) throw apiRejection(created);
    const payload = created.data ?? created;
    const cardId = payload.card_id ?? payload.data?.card_id;
    if (typeof cardId !== 'string' || !CARD_ID_PATTERN.test(cardId)) throw new Error('CardKit response omitted card id');
    return { cardId };
  }

  async updateStreamingCard({ cardId, elementId = 'content', content, sequence }) {
    if (typeof cardId !== 'string' || !CARD_ID_PATTERN.test(cardId)) throw new TypeError('card id is invalid');
    if (typeof elementId !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(elementId)) throw new TypeError('stream element id is invalid');
    if (typeof content !== 'string' || !content || content.length > 12_000) throw new RangeError('stream content exceeds transport limit');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('stream sequence is invalid');
    const result = await this._run([
      '--profile', this._profile, 'api', 'PUT', `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`, '--as', 'bot',
      '--data', JSON.stringify({ content, sequence, uuid: randomUUID() }),
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw apiRejection(result);
    return result.data ?? result;
  }

  async resumeStreamingCard({ cardId, sequence }) {
    if (typeof cardId !== 'string' || !CARD_ID_PATTERN.test(cardId)) throw new TypeError('card id is invalid');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('stream sequence is invalid');
    const result = await this._run([
      '--profile', this._profile, 'api', 'PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, '--as', 'bot',
      '--data', JSON.stringify({
        settings: JSON.stringify({ config: {
          streaming_mode: true,
          streaming_config: {
            print_frequency_ms: { default: 50 },
            print_step: { default: 2 },
            print_strategy: 'fast',
          },
        } }),
        sequence, uuid: randomUUID(),
      }),
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw apiRejection(result);
    return result.data ?? result;
  }

  async closeStreamingCard({ cardId, summary, sequence }) {
    if (typeof cardId !== 'string' || !CARD_ID_PATTERN.test(cardId)) throw new TypeError('card id is invalid');
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new TypeError('stream sequence is invalid');
    const content = typeof summary === 'string' ? summary.replace(/[\r\n]+/g, ' ').trim().slice(0, 50) : '';
    const result = await this._run([
      '--profile', this._profile, 'api', 'PATCH', `/open-apis/cardkit/v1/cards/${cardId}/settings`, '--as', 'bot',
      '--data', JSON.stringify({
        settings: JSON.stringify({ config: { streaming_mode: false, summary: { content } } }),
        sequence, uuid: randomUUID(),
      }),
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw apiRejection(result);
    return result.data ?? result;
  }

  async reply({ messageId, text, key, inThread = true }) {
    return this._sendMessage({ operation: '+messages-reply', targetFlag: '--message-id', target: messageId, text, key, inThread });
  }

  async replyCard({ messageId, card, key, inThread = true }) {
    return this._sendMessage({ operation: '+messages-reply', targetFlag: '--message-id', target: messageId, card, key, inThread });
  }

  async replyImage({ messageId, path, allowedRoots = [], key, inThread = true }) {
    if (typeof messageId !== 'string' || !/^om_[\w-]+$/.test(messageId)) throw new TypeError('message id is invalid');
    if (typeof key !== 'string' || !key || key.length > 50) throw new TypeError('key must be a non-empty string of at most 50 characters');
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new TypeError('image path is invalid');
    if (!Array.isArray(allowedRoots) || !allowedRoots.length || allowedRoots.some(root => typeof root !== 'string' || !isAbsolute(root))) {
      throw new TypeError('image roots are invalid');
    }
    const absolute = await realpath(path);
    let allowed = false;
    for (const root of allowedRoots) {
      try {
        const actualRoot = await realpath(root);
        const rel = relative(actualRoot, absolute);
        if (!rel.startsWith('..') && !isAbsolute(rel)) { allowed = true; break; }
      } catch { /* unavailable roots do not grant access */ }
    }
    if (!allowed) throw new Error('image path is outside allowed roots');
    if (!/^\.(?:png|jpe?g|gif|webp)$/i.test(extname(absolute))) throw new Error('unsupported image format');
    const info = await stat(absolute);
    if (!info.isFile() || info.size <= 0 || info.size > this._maxResourceBytes) throw new Error('image exceeds the media limit');
    const args = ['--profile', this._profile, 'im', '+messages-reply', '--message-id', messageId,
      '--image', `./${basename(absolute)}`];
    if (inThread) args.push('--reply-in-thread');
    args.push('--idempotency-key', key, '--as', 'bot');
    const result = await this._run(args, this._resourceTimeoutMs, dirname(absolute));
    if (result?.ok !== true) throw new Error('lark-cli did not return a successful response');
    return result.data ?? result;
  }

  async react({ messageId, emojiType = 'OnIt' }) {
    if (typeof messageId !== 'string' || !/^om_[\w-]+$/.test(messageId)) throw new TypeError('message id is invalid');
    if (emojiType !== 'OnIt') throw new TypeError('emoji type is invalid');
    const result = await this._run([
      '--profile', this._profile, 'im', 'reactions', 'create', '--message-id', messageId,
      '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }), '--as', 'bot',
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw new Error('lark-cli did not return a successful response');
    return result.data ?? result;
  }

  async updateCard({ token, card }) {
    if (typeof token !== 'string' || !token || token.length > 2048 || /[\u0000-\u001f\u007f]/.test(token)) throw new TypeError('card update token is invalid');
    const content = JSON.stringify(card);
    if (!card || typeof card !== 'object' || Buffer.byteLength(content) > MAX_CARD_BYTES) throw new RangeError('card exceeds transport limit');
    const result = await this._run([
      '--profile', this._profile, 'api', 'POST', '/open-apis/interactive/v1/card/update',
      '--as', 'bot', '--data', JSON.stringify({ token, card }),
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw new Error('lark-cli did not return a successful response');
    return result.data ?? result;
  }

  async replaceCard({ messageId, card }) {
    if (typeof messageId !== 'string' || !/^om_[\w-]+$/.test(messageId)) throw new TypeError('message id is invalid');
    const content = JSON.stringify(card);
    if (!card || typeof card !== 'object' || Buffer.byteLength(content) > MAX_CARD_BYTES) throw new RangeError('card exceeds transport limit');
    const result = await this._run([
      '--profile', this._profile, 'im', 'messages', 'patch', '--message-id', messageId,
      '--data', JSON.stringify({ content }), '--as', 'bot',
    ], this._commandTimeoutMs);
    if (result?.ok !== true) throw new Error('lark-cli did not return a successful response');
    return result.data ?? result;
  }

  async _sendMessage({ operation, targetFlag, target, text, card, key, inThread = false }) {
    const targetPattern = targetFlag === '--user-id' ? /^ou_[\w-]+$/
      : targetFlag === '--message-id' ? /^om_[\w-]+$/ : /^oc_[\w-]+$/;
    if (typeof target !== 'string' || !targetPattern.test(target)) throw new TypeError('message target is invalid');
    if (typeof key !== 'string' || !key || key.length > 50) throw new TypeError('key must be a non-empty string of at most 50 characters');
    if ((text === undefined) === (card === undefined)) throw new TypeError('provide exactly one of text or card');
    const args = ['--profile', this._profile, 'im', operation, targetFlag, target];
    if (text !== undefined) {
      if (typeof text !== 'string' || !text || text.length > this._maxTextLength) throw new RangeError('text exceeds transport limit');
      args.push('--text', text);
    } else {
      const content = JSON.stringify(card);
      if (!card || typeof card !== 'object' || Buffer.byteLength(content) > MAX_CARD_BYTES) throw new RangeError('card exceeds transport limit');
      args.push('--msg-type', 'interactive', '--content', content);
    }
    if (inThread) args.push('--reply-in-thread');
    args.push('--idempotency-key', key, '--as', 'bot');
    const result = await this._run(args, this._commandTimeoutMs);
    if (result?.ok !== true) throw new Error('lark-cli did not return a successful response');
    return result.data ?? result;
  }

  async start(onEvent) {
    if (this._consumer) throw new Error('Lark transport is already running');
    if (typeof onEvent !== 'function') throw new TypeError('onEvent must be a function');

    this._stopping = false;
    let child;
    try {
      child = this._spawn('lark-cli', ['--profile', this._profile, 'event', 'consume', this._eventKey, '--as', 'bot'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = new Error('Unable to start Lark event consumer');
      this._report(failure);
      throw failure;
    }
    this._consumer = child;

    return new Promise((resolve, reject) => {
      let ready = false;
      let settled = false;
      let failed = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let resolveClosed;
      this._consumerClosed = new Promise((resolve) => { resolveClosed = resolve; });
      const timer = setTimeout(() => fail(new Error('Timed out waiting for Lark event consumer readiness')), this._readyTimeoutMs);
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const fail = (error) => {
        if (failed) return;
        failed = true;
        this._eventQueue = [];
        if (!this._stopping) this._report(error);
        this._terminate(child);
        if (!ready) settle(reject, error);
      };
      this._startupReject = (error) => {
        if (!ready) settle(reject, error);
      };

      child.once('error', (error) => fail(new Error(`Unable to start Lark event consumer: ${error.message}`)));
      child.once('exit', (code, signal) => {
        if (this._stopping || failed) return;
        failed = true;
        this._eventQueue = [];
        const error = new Error(`Lark event consumer exited unexpectedly (${signal ?? `code ${code}`})`);
        this._report(error);
        if (!ready) settle(reject, error);
      });
      child.once('close', () => {
        // Flush decoder state so incomplete UTF-8 never remains buffered indefinitely.
        if (!failed) {
          stdoutBuffer = appendBounded(stdoutBuffer, stdoutDecoder.end(), this._maxBufferBytes);
          stderrBuffer = appendBounded(stderrBuffer, stderrDecoder.end(), this._maxBufferBytes);
        }
        if (this._consumer === child) this._consumer = null;
        if (!ready && !settled) settle(reject, new Error('Lark event consumer closed before readiness'));
        if (this._startupReject) this._startupReject = null;
        resolveClosed();
      });
      child.stderr.on('data', (chunk) => {
        if (failed || settled && !ready) return;
        stderrBuffer = appendBounded(stderrBuffer, stderrDecoder.write(chunk), this._maxBufferBytes);
        if (stderrBuffer === null) return fail(new Error('Lark event consumer stderr exceeded buffer limit'));
        const markerIndex = !ready ? stderrBuffer.indexOf(this._readyMarker) : -1;
        if (markerIndex >= 0) {
          const markerLineEnd = stderrBuffer.indexOf('\n', markerIndex);
          // Startup output is not a runtime diagnostic. Drop the full ready line
          // (and anything before it) so no startup error text is surfaced later.
          stderrBuffer = markerLineEnd >= 0 ? stderrBuffer.slice(markerLineEnd + 1) : '';
          ready = true;
          settle(resolve);
          drainLines();
        }
        if (ready) drainDiagnostics();
      });
      child.stdout.on('data', (chunk) => {
        if (failed || !this._consumer || this._consumer !== child) return;
        stdoutBuffer = appendBounded(stdoutBuffer, stdoutDecoder.write(chunk), this._maxBufferBytes);
        if (stdoutBuffer === null) return fail(new Error('Lark event consumer stdout exceeded buffer limit'));
        if (ready) drainLines();
      });

      const drainLines = () => {
        let newline;
        while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch { return fail(new Error('Lark event consumer emitted invalid JSON')); }
          if (this._eventQueue.length >= this._maxEventQueueSize) return fail(new Error('Lark event queue limit exceeded'));
          this._eventQueue.push(event);
          this._drain(onEvent);
        }
      };
      const drainDiagnostics = () => {
        let newline;
        while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
          const line = stderrBuffer.slice(0, newline).trim();
          stderrBuffer = stderrBuffer.slice(newline + 1);
          if (line && !line.includes(this._readyMarker) && !line.startsWith('[event] exited')) {
            this._diagnostic();
          }
        }
      };
    });
  }

  async stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopping = true;
    const child = this._consumer;
    this._eventQueue = [];
    if (!child) return;
    this._startupReject?.(new Error('Lark event consumer stopped before readiness'));
    this._startupReject = null;
    const closed = this._consumerClosed;
    this._terminate(child);
    let stopTimer;
    this._stopPromise = Promise.race([
      closed,
      new Promise((_, reject) => { stopTimer = setTimeout(() => reject(new Error('Timed out waiting for Lark event consumer shutdown')), this._commandTimeoutMs); }),
    ]).finally(() => {
      clearTimeout(stopTimer);
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  _drain(onEvent) {
    if (this._delivering) return;
    this._delivering = true;
    void (async () => {
      while (this._eventQueue.length && !this._stopping && this._consumer) {
        const event = this._eventQueue.shift();
        try { await onEvent(event); } catch (error) { this._report(error); }
      }
      this._delivering = false;
    })();
  }

  _report(error) {
    try { this._onError(error); } catch { /* error reporting must not crash the process */ }
  }

  _diagnostic() {
    try { this._onDiagnostic({ code: 'LARK_EVENT_DIAGNOSTIC' }); } catch { /* diagnostic reporting must not crash the process */ }
  }

  _terminate(child) {
    if (child && !child.killed) child.kill('SIGTERM');
  }

  _run(args, timeoutMs, cwd) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'], ...(cwd ? { cwd } : {}) });
      } catch (error) {
        reject(transportError(`Unable to start lark-cli: ${error.message}`, 'LARK_COMMAND_START_FAILED'));
        return;
      }
      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        this._terminate(child);
        finish(reject, transportError('Lark send command timed out', 'LARK_COMMAND_TIMEOUT'));
      }, timeoutMs);
      child.once('error', () => finish(reject, transportError('Unable to start lark-cli', 'LARK_COMMAND_START_FAILED')));
      child.stdout.on('data', (chunk) => {
        if (done) return;
        stdout = appendBounded(stdout, stdoutDecoder.write(chunk), this._maxBufferBytes);
        if (stdout === null) { this._terminate(child); finish(reject, transportError('Lark send output exceeded buffer limit', 'LARK_COMMAND_OUTPUT_LIMIT')); }
      });
      child.stderr.on('data', (chunk) => {
        if (done) return;
        stderr = appendBounded(stderr, stderrDecoder.write(chunk), this._maxBufferBytes);
        if (stderr === null) { this._terminate(child); finish(reject, transportError('Lark send error output exceeded buffer limit', 'LARK_COMMAND_OUTPUT_LIMIT')); }
      });
      child.once('close', (code) => {
        if (done) return;
        stdout = appendBounded(stdout, stdoutDecoder.end(), this._maxBufferBytes);
        stderr = appendBounded(stderr, stderrDecoder.end(), this._maxBufferBytes);
        if (stdout === null || stderr === null) return finish(reject, transportError('Lark send output exceeded buffer limit', 'LARK_COMMAND_OUTPUT_LIMIT'));
        if (code !== 0) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed?.ok === false) return finish(reject, apiRejection(parsed));
          } catch { /* fall back to the bounded transport error below */ }
          return finish(reject, classifyCommandFailure(stderr, code));
        }
        try { finish(resolve, JSON.parse(stdout)); } catch { finish(reject, transportError('Lark send command returned invalid JSON', 'LARK_COMMAND_INVALID_JSON')); }
      });
    });
  }
}

function apiRejection(result) {
  const candidate = result?.error?.code ?? result?.data?.code ?? result?.code;
  const numeric = Number(candidate);
  return transportError('lark-cli did not return a successful response', 'LARK_API_REJECTED',
    Number.isSafeInteger(numeric) ? { remoteCode: numeric } : {});
}

function classifyCommandFailure(stderr, exitCode) {
  const value = typeof stderr === 'string' ? stderr : '';
  const numericMatch = value.match(/(?:err(?:or)?_?code|code)\s*[=:]\s*["']?(-?\d+)/i);
  const numeric = numericMatch ? Number(numericMatch[1]) : NaN;
  const lower = value.toLowerCase();
  const code = /rate.?limit|too many|frequency|频率|限流/.test(lower) ? 'LARK_RATE_LIMITED'
    : /sequence|序号/.test(lower) ? 'LARK_SEQUENCE_REJECTED'
      : /card[^\n]{0,40}(?:expired|not found)|卡片[^\n]{0,40}(?:失效|不存在)/.test(lower) ? 'LARK_CARD_UNAVAILABLE'
        : /unauthori[sz]ed|permission|scope|forbidden|权限/.test(lower) ? 'LARK_PERMISSION_REJECTED'
          : /timeout|timed out|network|connection|socket|fetch/.test(lower) ? 'LARK_NETWORK_FAILED'
            : 'LARK_COMMAND_FAILED';
  return transportError(`Lark send command failed (exit ${exitCode})`, code,
    Number.isSafeInteger(numeric) ? { remoteCode: numeric } : {});
}

function appendBounded(previous, chunk, maximum) {
  const next = previous + chunk;
  return Buffer.byteLength(next) > maximum ? null : next;
}
