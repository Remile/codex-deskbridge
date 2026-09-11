import test from 'node:test';
import assert from 'node:assert/strict';
import { startupMessage } from '../src/bridge-errors.mjs';
test('explains lock and config errors without printing raw errors or secrets', () => {
  assert.match(startupMessage({ code: 'BRIDGE_LOCKED' }), /已有桥接服务在运行/);
  assert.match(startupMessage({ code: 'CONFIG_MISSING' }), /找不到配置文件/);
  assert.match(startupMessage({ code: 'CONFIG_INVALID_JSON' }), /不是有效的 JSON/);
  for (const code of ['BRIDGE_LOCKED', 'secret-token', '__proto__', undefined]) {
    const text = startupMessage({ code, message: 'secret-token', stderr: 'private body' });
    assert.doesNotMatch(text, /secret-token|private body/);
  }
});
