import test from 'node:test';
import assert from 'node:assert/strict';
import { completionCard, pickerCard, projectPickerCard, streamingProgressCard, streamingProgressText, taskTopicCard } from '../src/cards.mjs';

function elementIds(card) {
  const ids = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value.element_id === 'string') ids.push(value.element_id);
    for (const child of Object.values(value)) visit(child);
  };
  visit(card.body);
  return ids;
}

test('picker is a bounded Card 2.0 selector that exposes opaque refs only as values', () => {
  const tasks = Array.from({ length: 14 }, (_, index) => ({
    ref: `opaque-${index}`,
    title: `Task ${index}`,
    status: 'running',
    updatedAt: '2026-09-10',
    threadId: `thread-${index}`,
  }));
  const card = pickerCard({ tasks });
  const form = card.body.elements.find(element => element.tag === 'form');
  const selector = form.elements.find(element => element.tag === 'select_static');
  const input = form.elements.find(element => element.tag === 'input');
  const button = form.elements.find(element => element.tag === 'button');

  assert.equal(card.schema, '2.0');
  assert.equal(card.config.width_mode, 'default');
  assert.equal(card.header.template, 'blue');
  assert.equal(selector.name, 'task_picker');
  assert.equal(selector.options.length, 12);
  assert.deepEqual(selector.options.map(option => option.value), tasks.slice(0, 12).map(task => task.ref));
  assert.equal(input.name, 'prompt');
  assert.equal(input.input_type, 'multiline_text');
  assert.equal(button.name, 'send_picker_prompt');
  assert.equal(button.form_action_type, 'submit');
  assert.doesNotMatch(JSON.stringify(card), /thread-\d+/);
  assert.equal(card.body.elements.length, 2);
});

test('project picker is a bounded first-level selector with opaque values', () => {
  const projects = Array.from({ length: 15 }, (_, index) => ({ ref: `project-${index}`, title: `Project ${index}`, count: index + 1, path: `/secret/${index}` }));
  const card = projectPickerCard({ projects });
  const form = card.body.elements.find(element => element.tag === 'form');
  const selector = form.elements.find(element => element.tag === 'select_static');
  assert.equal(selector.name, 'project_picker');
  assert.equal(selector.options.length, 12);
  assert.equal(selector.options[0].value, 'project-0');
  assert.match(selector.options[0].text.content, /1 个任务/);
  assert.doesNotMatch(JSON.stringify(card), /\/secret\//);
});

test('task topic is a static root without a second prompt form', () => {
  const card = taskTopicCard({ title: 'Investigate alert', status: 'running' });

  assert.equal(card.schema, '2.0');
  assert.equal(card.header.template, 'blue');
  assert.equal(card.header.text_tag_list, undefined);
  assert.equal(card.body.elements.some(element => element.tag === 'form'), false);
  assert.match(JSON.stringify(card), /收拢阶段进展和最终结果/);
  assert.equal(card.body.elements.length, 2);
});

test('completion preserves safe Markdown while escaping Lark tags and unsafe links', () => {
  const card = completionCard({
    title: 'T'.repeat(300),
    status: '**done**',
    summary: '[PR #542](https://github.com/example/repo/pull/542)\n\n- 已合并\n- 已验证\n\n```sh\nnpm test\n```\n<at id=all></at> [bad](javascript:alert)'.repeat(100),
  });
  const content = card.body.elements.map(element => element.content ?? '').join('\n');

  assert.equal(card.body.elements.length, 2);
  assert.equal(card.header.title.content.length, 200);
  assert.ok(card.body.elements[1].content.length <= 12_000);
  assert.match(content, /\[PR #542\]\(https:\/\/github\.com\/example\/repo\/pull\/542\)/);
  assert.match(content, /\n\n- 已合并\n- 已验证/);
  assert.match(content, /```sh\nnpm test\n```/);
  assert.doesNotMatch(content, /<at|javascript:/);
  assert.match(content, /&lt;at id=all&gt;&lt;\/at&gt;/);
  assert.equal(elementIds(card).every(id => /^[A-Za-z][A-Za-z0-9_]*$/.test(id) && id.length <= 20), true);
  assert.equal(new Set(elementIds(card)).size, elementIds(card).length);
});

test('streaming progress card exposes state and content targets and keeps only the latest stage', () => {
  const content = streamingProgressText([
    { text: '第一阶段 [link](https://bad.example)', timestamp: '2026-09-09T12:00:01' },
    { text: '第二阶段\n\n- 保留列表\n- [查看 PR](https://github.com/example/repo/pull/1)\n\n<script>', timestamp: '2026-09-09T12:34:56' },
  ], [
    { type: 'file_change', files: [{ path: 'src/old.mjs' }], status: 'completed', timestamp: '2026-09-09T12:34:57' },
    { type: 'command', command: 'npm test', status: 'running', timestamp: '2026-09-09T12:35:02' },
  ]);
  const card = streamingProgressCard({ title: '真实任务标题', content });
  assert.equal(card.schema, '2.0');
  assert.equal(card.config.update_multi, true);
  assert.equal(card.config.streaming_mode, true);
  assert.doesNotMatch(JSON.stringify(card), /corner_radius/);
  assert.equal(elementIds(card).includes('state'), true);
  assert.equal(card.body.elements.filter(element => element.element_id === 'content').length, 1);
  assert.doesNotMatch(content, /第一阶段/);
  assert.match(content, /第二阶段/);
  assert.match(content, /阶段进展/);
  assert.match(content, /阶段进展 · 12:34:56/);
  assert.match(content, /最近行为/);
  assert.match(content, /12:34:57.*修改文件/);
  assert.match(content, /12:35:02.*npm test/);
  assert.match(content, /npm test/);
  assert.match(content, /- 保留列表/);
  assert.match(content, /\[查看 PR\]\(https:\/\/github\.com\/example\/repo\/pull\/1\)/);
  assert.doesNotMatch(content, /<script>/);
  assert.match(content, /&lt;script&gt;/);
  assert.equal(card.body.elements.find(element => element.element_id === 'content').content, content);
  assert.ok(content.length <= 12_000);
});

test('recent behavior includes the latest completion even when the action started earlier', () => {
  const content = streamingProgressText([], [
    { type: 'command', command: 'earlier action now done', status: 'completed', timestamp: '2026-09-12T12:00:05' },
    { type: 'command', command: 'old action', status: 'completed', timestamp: '2026-09-12T12:00:01' },
    { type: 'subagent', agentPath: '/root/review', status: 'completed', timestamp: '2026-09-12T12:00:03' },
    { type: 'command', command: 'new action', status: 'running', timestamp: '2026-09-12T12:00:04' },
  ]);
  assert.doesNotMatch(content, /old action/);
  assert.match(content, /earlier action now done（已完成）/);
  assert.match(content, /review（已完成）/);
  assert.ok(content.indexOf('new action') < content.indexOf('earlier action now done'));
});
