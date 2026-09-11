import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [, , command, ...args] = process.argv;
const port = process.env.PORT || '43180';
const base = `http://127.0.0.1:${port}`;
const tokenPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'token');

function usage() { throw new Error('Usage: cli.mjs status|list|read ID|send ID TEXT'); }
async function main() {
  const token = (await readFile(tokenPath, 'utf8')).trim();
  let method = 'GET', path, body;
  if (command === 'status' && args.length === 0) path = '/api/status';
  else if (command === 'list' && args.length === 0) path = '/api/threads?limit=20';
  else if (command === 'read' && args.length === 1) path = `/api/threads/${encodeURIComponent(args[0])}?limit=10`;
  else if (command === 'send' && args.length === 2) { method = 'POST'; path = `/api/threads/${encodeURIComponent(args[0])}/messages`; body = { text: args[1] }; }
  else usage();
  const headers = { authorization: `Bearer ${token}` };
  if (body) { headers['content-type'] = 'application/json'; headers['idempotency-key'] = process.env.IDEMPOTENCY_KEY || randomBytes(24).toString('base64url'); }
  if (body) process.stderr.write(`Idempotency-Key: ${headers['idempotency-key']}\nIf the outcome is uncertain, check the task and reuse this key; do not blindly resend.\n`);
  const response = await fetch(`${base}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${text}`);
  process.stdout.write(`${text}\n`);
}
main().catch((cause) => { process.stderr.write(`${cause.message}\n`); process.exitCode = 1; });
