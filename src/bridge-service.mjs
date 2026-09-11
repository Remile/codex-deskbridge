import { startupMessage } from './bridge-errors.mjs';
import { mkdir, readFile, readdir, writeFile, chmod, rm, mkdtemp, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { AppServerClient, CodexAppServerRuntime } from './app-server.mjs';
import { Bridge, BridgeStore } from './bridge.mjs';
import { LarkTransport } from './lark-transport.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = event => process.stderr.write(JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
const MEDIA_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function pruneMedia(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const names = await readdir(dir);
  await Promise.all(names.map(async name => {
    const path = join(dir, name);
    try {
      const info = await stat(path);
      if (info.isFile() && Date.now() - info.mtimeMs > MEDIA_RETENTION_MS) await rm(path, { force: true });
    } catch { /* a concurrent cleanup or download may have changed the entry */ }
  }));
}

export async function acquireBridgeLock(lock, pid = process.pid) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'pid'), String(pid), { mode: 0o600 });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let lockPid;
      try { lockPid = Number((await readFile(join(lock, 'pid'), 'utf8')).trim()); } catch { lockPid = NaN; }
      if (Number.isSafeInteger(lockPid) && lockPid > 1) {
        try {
          process.kill(lockPid, 0);
          throw Object.assign(new Error(), { code: 'BRIDGE_LOCKED', lockPid });
        } catch (probe) {
          if (probe.code !== 'ESRCH') {
            if (probe.code === 'EPERM') throw Object.assign(new Error(), { code: 'BRIDGE_LOCKED', lockPid });
            throw probe;
          }
        }
      }
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw Object.assign(new Error(), { code: 'BRIDGE_LOCKED' });
}

export function createCoalescedEnqueuer({ enqueue, operation, isStopped = () => false, onError = () => {}, onIdle = () => {} }) {
  if (typeof enqueue !== 'function' || typeof operation !== 'function') throw new TypeError('enqueue and operation must be functions');
  let queued = false, running = false, rerun = false, latest = Promise.resolve();
  const request = () => {
    if (isStopped()) return latest;
    if (queued) return latest;
    if (running) {
      rerun = true;
      return latest;
    }
    queued = true;
    latest = enqueue(async () => {
      queued = false;
      if (isStopped()) return;
      running = true;
      rerun = false;
      try { await operation(); }
      catch (error) { onError(error); }
      finally {
        running = false;
        if (isStopped()) return;
        if (rerun) {
          rerun = false;
          queueMicrotask(request);
        } else onIdle();
      }
    });
    return latest;
  };
  return { request, state: () => ({ queued, running, rerun }) };
}

async function demo() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-lark-demo-'));
  const store = new BridgeStore(join(dir, 'state.sqlite'));
  let terminal = null;
  const desktop = {
    sendEnabled: true,
    sendMessage: async () => ({ turnId: 'turn-1', status: 'inProgress' }),
    listThreads: async () => ({ threads: [{ id: 'demo-task', title: '模拟任务' }] }),
    readThread: async () => ({ thread: { title: '模拟任务' }, observedStatus: terminal ? 'idle' : 'running', lastTerminal: terminal,
      messages: [{ role: 'assistant', phase: 'final_answer', turnId: 'turn-1', text: '模拟执行完成' }] }),
  };
  let sequence = 0;
  const output = value => process.stdout.write(JSON.stringify(value) + '\n\n');
  const transport = {
    send: async value => { output(value); return { message_id: `om_demo_${++sequence}` }; },
    sendCard: async value => { output(value.card); return { message_id: `om_demo_${++sequence}` }; },
    reply: async value => { output(value); return { message_id: `om_demo_${++sequence}` }; },
    replyCard: async value => { output(value.card); return { message_id: `om_demo_${++sequence}` }; },
  };
  const bridge = new Bridge({ desktop, store, allowedUsers: ['ou_demo'], transport });
  try {
    for (const [index, content] of ['/codex list', '/codex watch demo-task', '/codex send demo-task hello'].entries()) {
      await bridge.handle({ type: 'im.message.receive_v1', sender_type: 'user', sender_id: 'ou_demo', chat_type: 'p2p', chat_id: 'oc_demo',
        message_type: 'text', message_id: `om_demo${index}`, create_time: String(Date.now()), content });
    }
    terminal = { turnId: 'turn-1', status: 'completed' };
    await bridge.poll(); await bridge.poll();
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

async function run() {
  const configPath = resolve(process.argv[2] || join(root, '.local', 'bridge.json'));
  let rawConfig, config;
  try { rawConfig = await readFile(configPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') error.code = 'CONFIG_MISSING'; throw error; }
  try { config = JSON.parse(rawConfig); }
  catch { throw Object.assign(new Error(), { code: 'CONFIG_INVALID_JSON' }); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Object.assign(new Error(), { code: 'CONFIG_PROFILE' });
  if (typeof config.profile !== 'string' || !/^[\w-]{1,64}$/.test(config.profile)) throw Object.assign(new Error(), { code: 'CONFIG_PROFILE' });
  if (!Array.isArray(config.allowedUsers) || !config.allowedUsers.length || config.allowedUsers.some(id => typeof id !== 'string' || !/^ou_[\w-]+$/.test(id))) throw Object.assign(new Error(), { code: 'CONFIG_USERS' });
  if (config.autoDiscover !== undefined && typeof config.autoDiscover !== 'boolean') throw Object.assign(new Error(), { code: 'CONFIG_DISCOVERY' });
  const interval = config.pollIntervalMs ?? 5000;
  if (!Number.isInteger(interval) || interval < 5000 || interval > 300000) throw Object.assign(new Error(), { code: 'CONFIG_INTERVAL' });
  const stateDir = join(root, '.local', 'bridge', config.profile);
  await mkdir(stateDir, { recursive: true, mode: 0o700 }); await chmod(stateDir, 0o700);
  const lock = join(stateDir, 'lock');
  await acquireBridgeLock(lock);
  let store, runtime, transports = [], timer, nextTickAt = Infinity, stopped = false, pending = Promise.resolve(), cleanup;
  const enqueue = operation => { pending = pending.then(operation); return pending; };
  const stop = () => cleanup ||= (async () => {
    stopped = true; clearTimeout(timer);
    const results = await Promise.allSettled(transports.map(transport => transport.stop()));
    if (results.some(result => result.status === 'rejected')) throw Object.assign(new Error(), { code: 'CONSUMER_SHUTDOWN_FAILED' });
    await pending.catch(() => {});
    await runtime?.stop();
    store?.close(); await rm(lock, { recursive: true, force: true });
  })();
  const requestStop = () => { void stop().catch(() => { log({ code: 'SHUTDOWN_FAILED_LOCK_RETAINED' }); process.exitCode = 1; }); };
  const fatal = error => { log({ code: error?.code || 'BRIDGE_STOPPED' }); process.exitCode = 1; requestStop(); };
  try {
    store = new BridgeStore(join(stateDir, 'state.sqlite')); await chmod(join(stateDir, 'state.sqlite'), 0o600);
    await pruneMedia(join(stateDir, 'media'));
    const messageTransport = new LarkTransport({
      profile: config.profile,
      eventKey: 'im.message.receive_v1',
      resourceDir: join(stateDir, 'media'),
      onError: fatal,
      onDiagnostic: log,
    });
    let cardStarting = true;
    const cardTransport = new LarkTransport({
      profile: config.profile, eventKey: 'card.action.trigger',
      onError: error => cardStarting ? log({ code: 'CARD_CALLBACK_UNAVAILABLE' }) : fatal(error),
      onDiagnostic: log,
    });
    transports = [messageTransport, cardTransport];
    const codex = config.codex ?? {};
    if (!codex || typeof codex !== 'object' || Array.isArray(codex)) throw Object.assign(new Error(), { code: 'CONFIG_CODEX' });
    if (codex.binary !== undefined && (typeof codex.binary !== 'string' || !codex.binary.trim())) throw Object.assign(new Error(), { code: 'CONFIG_CODEX' });
    if (codex.approvalPolicy !== undefined && !['untrusted', 'on-request', 'never'].includes(codex.approvalPolicy)) throw Object.assign(new Error(), { code: 'CONFIG_CODEX' });
    runtime = new CodexAppServerRuntime({
      client: new AppServerClient({ ...(codex.binary ? { binary: codex.binary } : {}), onServerRequest: undefined }),
      ...(codex.approvalPolicy ? { approvalPolicy: codex.approvalPolicy } : {}),
    });
    await runtime.start();
    const bridge = new Bridge({ desktop: runtime, transport: messageTransport, store, allowedUsers: config.allowedUsers, log });
    process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
    const receive = event => stopped ? undefined : enqueue(() => bridge.handle(event));
    await messageTransport.start(receive);
    let eventConsumers = 1;
    try {
      await cardTransport.start(receive);
      cardStarting = false;
      eventConsumers = 2;
    } catch {
      await cardTransport.stop().catch(() => {});
      transports = [messageTransport];
    }
    if (stopped) return;
    log({ code: 'BRIDGE_READY', mode: eventConsumers === 2 ? 'card-topics' : 'text-only', eventConsumers, pollIntervalMs: interval });
    let poller;
    const scheduleTick = delay => {
      if (stopped) return;
      const due = Date.now() + delay;
      if (timer && nextTickAt <= due) return;
      clearTimeout(timer);
      nextTickAt = due;
      timer = setTimeout(() => {
        timer = undefined;
        nextTickAt = Infinity;
        void poller.request();
      }, Math.max(0, due - Date.now()));
    };
    poller = createCoalescedEnqueuer({
      enqueue,
      operation: async () => {
        if (config.autoDiscover !== false) await bridge.syncThreads();
        await bridge.poll();
      },
      isStopped: () => stopped,
      onError: fatal,
      onIdle: () => scheduleTick(interval),
    });
    runtime.on('change', () => scheduleTick(50));
    await poller.request();
  } catch (error) { await stop(); throw error; }
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  (process.argv[2] === '--demo' ? demo() : run()).catch(error => {
    // Do not print external CLI output, secrets or message bodies.
    process.stderr.write(startupMessage(error));
    process.exitCode = 1;
  });
}
