import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem } from '../src/activity.mjs';

const context = { timestamp: '2026-09-09T12:00:00.000Z', turnId: 'turn-1' };

test('normalizes user text and retains commentary and uppercase Text parts', () => {
  assert.deepEqual(normalizeItem({
    type: 'UserMessage',
    id: 'user-1',
    content: 'Please inspect the task.',
  }, context), {
    id: 'user-1', type: 'message', timestamp: context.timestamp, turnId: context.turnId,
    role: 'user', phase: 'user', text: 'Please inspect the task.',
  });

  assert.deepEqual(normalizeItem({
    type: 'AgentMessage',
    id: 'agent-1',
    phase: 'commentary',
    content: [
      { type: 'Text', text: 'Inspecting the repository.' },
      { type: 'output_text', text: 'The progress is visible.' },
      { type: 'image', text: 'must be excluded' },
    ],
  }, context), {
    id: 'agent-1', type: 'message', timestamp: context.timestamp, turnId: context.turnId,
    role: 'assistant', phase: 'commentary', text: 'Inspecting the repository.\nThe progress is visible.',
  });
});

test('bounds message text and normalizes command fields without raw output', () => {
  const command = normalizeItem({
    type: 'CommandExecution',
    id: 'command-1',
    command: 'x'.repeat(2_100),
    status: 'completed',
    exit_code: 0,
    stdout: 'SECRET_STDOUT',
    stderr: 'SECRET_STDERR',
    aggregated_output: 'SECRET_AGGREGATED_OUTPUT',
  }, context);
  assert.equal(command.command.length, 2_000);
  assert.equal(command.exitCode, 0);
  assert.deepEqual(Object.keys(command).sort(), ['command', 'exitCode', 'id', 'status', 'timestamp', 'turnId', 'type']);
  assert.doesNotMatch(JSON.stringify(command), /SECRET_/);

  const running = normalizeItem({
    type: 'CommandExecution', id: 'command-2', command: ['/bin/zsh', '-lc', 'npm test'],
  }, { ...context, status: 'running' });
  assert.equal(running.command, 'npm test');
  assert.equal(running.status, 'running');

  const message = normalizeItem({ type: 'AgentMessage', id: 'long', content: 'a'.repeat(33_000) }, context);
  assert.equal(message.text.length, 32_000);
});

test('normalizes file changes through the path and kind allowlist', () => {
  const arrayChanges = normalizeItem({
    type: 'FileChange',
    id: 'files-1',
    status: 'completed',
    changes: [
      { path: 'src/activity.mjs', kind: 'update', diff: 'SECRET_DIFF' },
      { path: 'README.md', kind: 'add', body: 'SECRET_BODY' },
    ],
  }, context);
  assert.deepEqual(arrayChanges.files, [
    { path: 'src/activity.mjs', kind: 'update' },
    { path: 'README.md', kind: 'add' },
  ]);
  assert.doesNotMatch(JSON.stringify(arrayChanges), /SECRET_/);

  const mapChanges = normalizeItem({
    type: 'FileChange',
    id: 'files-2',
    changes: {
      'src/one.mjs': { kind: 'add', diff: 'SECRET_MAP_DIFF' },
      'src/two.mjs': 'delete',
    },
  }, context);
  assert.deepEqual(mapChanges.files, [
    { path: 'src/one.mjs', kind: 'add' },
    { path: 'src/two.mjs', kind: 'delete' },
  ]);
});

test('exposes bounded subagent markers and tool metadata only', () => {
  const subagent = normalizeItem({
    type: 'SubAgentActivity',
    id: 'subagent-1',
    kind: 'started',
    agent_thread_id: 'child-thread',
    agent_path: '/workspace/child',
    instructions: 'SECRET_INSTRUCTIONS',
  }, context);
  assert.deepEqual(subagent, {
    id: 'subagent-1', type: 'subagent', timestamp: context.timestamp, turnId: context.turnId,
    kind: 'started', agentThreadId: 'child-thread', agentPath: '/workspace/child',
  });
  assert.doesNotMatch(JSON.stringify(subagent), /SECRET_/);

  const receiverThreadIds = Array.from({ length: 35 }, (_, index) => `thread-${index}`);
  const collab = normalizeItem({
    type: 'CollabAgentToolCall',
    id: 'collab-1',
    tool: 'spawn_agent',
    status: 'completed',
    receiver_thread_ids: receiverThreadIds,
    agents_states: { secret: 'SECRET_AGENT_STATE' },
  }, context);
  assert.equal(collab.threadIds.length, 30);
  assert.deepEqual(collab.threadIds, receiverThreadIds.slice(0, 30));
  assert.doesNotMatch(JSON.stringify(collab), /SECRET_/);

  const tool = normalizeItem({
    type: 'McpToolCall',
    id: 'tool-1',
    server: 'local',
    tool: 'read_file',
    status: 'completed',
    arguments: { path: 'SECRET_ARGUMENT' },
    result: { text: 'SECRET_RESULT' },
  }, context);
  assert.deepEqual(tool, {
    id: 'tool-1', type: 'tool', timestamp: context.timestamp, turnId: context.turnId,
    server: 'local', tool: 'read_file', status: 'completed',
  });
  assert.doesNotMatch(JSON.stringify(tool), /SECRET_/);
});

test('publishes only public reasoning summaries and ignores raw reasoning', () => {
  const summary = normalizeItem({
    type: 'Reasoning',
    id: 'reasoning-1',
    summary_text: ['Visible heading', 'Visible detail'],
    raw_content: ['SECRET_RAW_CONTENT'],
    encrypted_content: 'SECRET_ENCRYPTED_CONTENT',
    response_item: { type: 'reasoning', content: 'SECRET_RESPONSE_ITEM' },
  }, context);
  assert.deepEqual(summary, {
    id: 'reasoning-1', type: 'reasoning_summary', timestamp: context.timestamp, turnId: context.turnId,
    text: 'Visible heading\nVisible detail',
  });
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_/);
  assert.equal(normalizeItem({ type: 'Reasoning', id: 'empty', summary_text: [] }, context), null);
  assert.equal(normalizeItem({ type: 'Reasoning', id: 'raw-only', raw_content: ['SECRET'] }, context), null);
  assert.equal(normalizeItem({ type: 'Unknown', id: 'unknown' }, context), null);
});


test('reads persisted path-map file operations without including unified diffs', () => {
  const value = normalizeItem({ type: 'FileChange', changes: {
    'api.py': { type: 'update', unified_diff: 'private patch', move_path: null },
  } });
  assert.deepEqual(value.files, [{ path: 'api.py', kind: 'update' }]);
  assert.equal(JSON.stringify(value).includes('private patch'), false);
});
