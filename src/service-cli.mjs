import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const LABEL = 'io.github.agent-im-bridge.service';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.local');
const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const target = `gui/${process.getuid()}/${LABEL}`;
const command = process.argv[2];

function xml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep searching */ }
  }
  throw new Error(`找不到 ${name}，请先在当前终端确认 command -v ${name} 有输出。`);
}

export function renderPlist({ node = process.execPath, lark = findExecutable('lark-cli'), codex = findExecutable('codex') } = {}) {
  const path = [...new Set([dirname(node), dirname(lark), dirname(codex), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const values = { label: LABEL, node, codex, script: join(root, 'src', 'bridge-service.mjs'), cwd: root,
    out: join(local, 'logs', 'bridge.out.log'), err: join(local, 'logs', 'bridge.err.log'), path };
  for (const key of Object.keys(values)) values[key] = xml(values[key]);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${values.label}</string>
  <key>ProgramArguments</key><array><string>${values.node}</string><string>${values.script}</string></array>
  <key>WorkingDirectory</key><string>${values.cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${values.out}</string>
  <key>StandardErrorPath</key><string>${values.err}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${values.path}</string>
    <key>CODEX_BIN</key><string>${values.codex}</string>
    <key>LARKSUITE_CLI_NO_UPDATE_NOTIFIER</key><string>1</string>
    <key>LARKSUITE_CLI_NO_SKILLS_NOTIFIER</key><string>1</string>
  </dict>
</dict></plist>\n`;
}

function launchctl(args, { acceptMissing = false } = {}) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status !== 0 && !acceptMissing) throw new Error((result.stderr || result.stdout || `launchctl ${args[0]} 失败`).trim());
  return result;
}

function ensureInstalled() {
  try { accessSync(plist); } catch { throw new Error('服务尚未安装，请先运行 npm run service:install。'); }
}

function install() {
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(join(local, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(plist, renderPlist(), { mode: 0o600 });
  launchctl(['bootout', target], { acceptMissing: true });
  launchctl(['bootstrap', `gui/${process.getuid()}`, plist]);
  process.stdout.write(`已安装并启动 ${LABEL}\n`);
}

function start() { ensureInstalled(); launchctl(['bootstrap', `gui/${process.getuid()}`, plist]); process.stdout.write('服务已启动。\n'); }
function stop() { launchctl(['bootout', target], { acceptMissing: true }); process.stdout.write('服务已停止。\n'); }
function restart() { ensureInstalled(); launchctl(['kickstart', '-k', target]); process.stdout.write('服务已重启。\n'); }
function status() {
  const result = launchctl(['print', target], { acceptMissing: true });
  if (result.status !== 0) { process.stdout.write('服务未运行或尚未安装。\n'); process.exitCode = 1; return; }
  const state = /\bstate = ([^\n]+)/.exec(result.stdout)?.[1]?.trim() || 'unknown';
  const pid = /\bpid = (\d+)/.exec(result.stdout)?.[1];
  process.stdout.write(`服务状态：${state}${pid ? `，PID ${pid}` : ''}\n`);
}
function logs() {
  const path = join(local, 'logs', 'bridge.err.log');
  let lines;
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-80); }
  catch { lines = ['暂时没有日志。']; }
  process.stdout.write(`${lines.join('\n')}\n`);
}
function uninstall() {
  stop();
  try { unlinkSync(plist); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  process.stdout.write('服务定义已移除，配置、日志和订阅数据仍保留。\n');
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    ({ install, start, stop, restart, status, logs, uninstall }[command] || (() => { throw new Error('用法：service-cli.mjs install|start|stop|restart|status|logs|uninstall'); }))();
  } catch (error) {
    process.stderr.write(`服务操作失败：${error.message}\n`);
    process.exitCode = 1;
  }
}
