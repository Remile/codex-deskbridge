import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['src', 'docs'];
const topFiles = ['README.md', 'ARCHITECTURE.md', 'SECURITY.md', 'CONTRIBUTING.md', 'LICENSE', 'package.json', 'bridge.example.json', '.gitignore'];
const textExtensions = new Set(['.mjs', '.js', '.json', '.md', '.txt', '']);
const forbidden = [
  [/thread-owner-discovery|thread-follower-start-turn|ipc\.sock/i, 'private Desktop IPC'],
  [/(^|[^A-Za-z0-9_])(ou|oc|om)_[A-Za-z0-9_-]{14,}/m, 'real-looking Feishu identifier'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
  [/(?:app_secret|client_secret|access_token|refresh_token)\s*[=:]\s*["'][^"']{8,}/i, 'credential-like value'],
];

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await walk(child));
    else files.push(child);
  }
  return files;
}

const files = topFiles.map(name => join(root, name));
for (const name of roots) files.push(...await walk(join(root, name)));
const failures = [];
for (const path of files) {
  if (!textExtensions.has(extname(path))) continue;
  const contents = await readFile(path, 'utf8');
  for (const [pattern, label] of forbidden) if (pattern.test(contents)) failures.push(`${relative(root, path)}: ${label}`);
}
if (failures.length) {
  process.stderr.write(`Release check failed:\n${failures.map(value => `- ${value}`).join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write(`Release check passed (${files.length} source files scanned).\n`);
