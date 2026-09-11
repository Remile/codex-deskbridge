import assert from 'node:assert/strict';
import test from 'node:test';
import { enrichThreadProjects } from '../src/project-membership.mjs';

test('resolves legacy project tasks by registered roots while leaving scratch tasks projectless', () => {
  const projects = [
    { id: 'multi-id', name: 'Multi-root project', roots: [{ path: '/code/mesh' }, { path: '/code/platform' }] },
    { id: 'platform-id', name: 'Platform', roots: [{ path: '/code/platform' }] },
    { id: 'tools-id', name: 'Tools', roots: [{ path: '/code/tools' }] },
  ];
  const result = enrichThreadProjects([
    { id: 'root', cwd: '/code/tools/subdir', projectId: null },
    { id: 'worktree', cwd: '/Users/me/.codex/worktrees/6900/platform', projectId: null },
    { id: 'scratch', cwd: '/Users/me/Documents/Codex/2026-09-11/random', projectId: null },
  ], projects);
  assert.deepEqual(result.map(thread => [thread.id, thread.projectName, thread.projectIdSource]), [
    ['root', 'Tools', 'root'],
    ['worktree', 'Platform', 'worktree'],
    ['scratch', undefined, null],
  ]);
});

test('explicit project identity wins over cwd inference', () => {
  const [thread] = enrichThreadProjects([
    { id: 'task', cwd: '/code/one', projectId: 'two' },
  ], [
    { id: 'one', name: 'One', roots: [{ path: '/code/one' }] },
    { id: 'two', name: 'Two', roots: [{ path: '/code/two' }] },
  ]);
  assert.equal(thread.projectName, 'Two');
  assert.equal(thread.projectIdSource, 'explicit');
});
