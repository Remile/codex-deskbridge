import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlist, LABEL } from '../src/service-cli.mjs';

test('launch agent uses fixed arguments, user paths and restart-on-failure semantics', () => {
  const plist = renderPlist({ node: '/tmp/node&x', lark: '/tmp/lark-cli', codex: '/tmp/codex' });
  assert.match(plist, new RegExp(LABEL));
  assert.match(plist, /<string>\/tmp\/node&amp;x<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /LARKSUITE_CLI_NO_UPDATE_NOTIFIER/);
  assert.match(plist, /<key>CODEX_BIN<\/key><string>\/tmp\/codex<\/string>/);
  assert.doesNotMatch(plist, /ProgramArguments[\s\S]*npm/);
});
