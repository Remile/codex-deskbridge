const MAX_TASKS = 12;
const MAX_REF_LENGTH = 256;
const MAX_TITLE_LENGTH = 200;
const MAX_STATUS_LENGTH = 80;
const MAX_UPDATED_AT_LENGTH = 64;
const MAX_SUMMARY_LENGTH = 3_000;
const MAX_RESULT_LENGTH = 12_000;

function boundedText(value, maxLength, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength) || fallback;
}

function markdownSource(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim() || fallback;
}

// Preserve ordinary Markdown while preventing task output from invoking Lark's
// HTML-like extensions (for example <at> and <person>) or unsafe link schemes.
function markdownText(value, maxLength, fallback = '') {
  const escaped = markdownSource(value, fallback)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/(!?)\[([^\]\n]*)\]\(([^)\n]*)\)/g, (match, image, label, destination) => {
      const url = destination.trim().replaceAll('&amp;', '&');
      if (/^https?:\/\/[^\s]+$/i.test(url)) return `${image}[${label}](${destination.trim()})`;
      return image ? `[图片：${label || '附件'}]` : label;
    });
  return escaped.slice(0, maxLength);
}

function markdownLiteral(value, maxLength, fallback = '') {
  return markdownSource(value, fallback).replace(
    /[&<>~*\[\]()#:_`\\]/g,
    character => character === '&' ? '&amp;' : `&#${character.charCodeAt(0)};`,
  ).slice(0, maxLength);
}

function plainText(value, maxLength, fallback = '') {
  return boundedText(value, maxLength, fallback);
}

function card(title, elements, status) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      title: { tag: 'plain_text', content: plainText(title, MAX_TITLE_LENGTH, 'Codex 任务') },
      template: 'blue',
      ...(status ? {
        text_tag_list: [{
          tag: 'text_tag',
          text: { tag: 'plain_text', content: plainText(status, MAX_STATUS_LENGTH, '未知') },
          color: 'blue',
        }],
      } : {}),
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'large',
      elements,
    },
  };
}

export function projectPickerCard({ projects } = {}) {
  const seenRefs = new Set();
  const options = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (options.length === MAX_TASKS || !project || typeof project !== 'object') break;
    const ref = boundedText(project.ref, MAX_REF_LENGTH);
    if (!ref || seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const title = plainText(project.title, MAX_TITLE_LENGTH, '未命名项目');
    const count = Number.isSafeInteger(project.count) && project.count > 0 ? project.count : 0;
    options.push({ text: { tag: 'plain_text', content: count ? `${title} · ${count} 个任务` : title }, value: ref });
  }
  return card('Codex 项目', [
    { tag: 'markdown', element_id: 'project_intro', content: '先选择项目，再选择已有任务或创建新任务。' },
    {
      tag: 'form', element_id: 'project_form', name: 'project_picker_form', elements: [
        {
          tag: 'select_static', element_id: 'project_picker', name: 'project_picker',
          placeholder: { tag: 'plain_text', content: '选择项目' }, options, required: true, width: 'fill',
        },
        {
          tag: 'button', element_id: 'project_next', name: 'show_project_tasks',
          text: { tag: 'plain_text', content: '下一步：选择任务' }, type: 'primary_filled', width: 'fill', form_action_type: 'submit',
        },
      ],
    },
  ]);
}

export function pickerCard({ tasks, projectTitle, error } = {}) {
  const seenRefs = new Set();
  const options = [];

  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (options.length === MAX_TASKS || !task || typeof task !== 'object') break;
    const ref = boundedText(task.ref, MAX_REF_LENGTH);
    if (!ref || seenRefs.has(ref)) continue;
    seenRefs.add(ref);

    const title = plainText(task.title, MAX_TITLE_LENGTH, '未命名任务');
    const status = plainText(task.status, MAX_STATUS_LENGTH, '未知');
    const updatedAt = plainText(task.updatedAt, MAX_UPDATED_AT_LENGTH);
    options.push({
      text: {
        tag: 'plain_text',
        content: updatedAt ? `${title} · ${status}\n更新于 ${updatedAt}` : `${title} · ${status}`,
      },
      // This is an opaque, server-issued reference. A task/thread id is never displayed.
      value: ref,
    });
  }

  return card(plainText(projectTitle, MAX_TITLE_LENGTH, 'Codex 任务'), [
    {
      tag: 'markdown',
      element_id: 'picker_intro',
      content: `${error ? `**${markdownLiteral(error, 300)}**\n\n` : ''}选择已有任务或新建任务。文字可在下方填写；图片和文件请先接入任务，再在话题里发送。`,
      text_size: 'normal',
    },
    {
      tag: 'form',
      element_id: 'picker_form',
      name: 'picker_prompt_form',
      elements: [
        {
          tag: 'select_static',
          element_id: 'task_picker',
          name: 'task_picker',
          placeholder: { tag: 'plain_text', content: '选择最近任务' },
          options,
          required: true,
          width: 'fill',
        },
        {
          tag: 'input',
          element_id: 'picker_prompt',
          name: 'prompt',
          input_type: 'multiline_text',
          rows: 5,
          max_length: 1000,
          required: false,
          width: 'fill',
          placeholder: { tag: 'plain_text', content: '可选：输入文字；图片或文件请在任务话题中发送' },
        },
        {
          tag: 'button',
          element_id: 'picker_send',
          name: 'send_picker_prompt',
          text: { tag: 'plain_text', content: '打开话题 / 发送文字' },
          type: 'primary_filled',
          width: 'fill',
          form_action_type: 'submit',
        },
      ],
    },
  ]);
}

export function taskTopicCard({ title, status, submitted, note } = {}) {
  const safeTitle = plainText(title, MAX_TITLE_LENGTH, 'Codex 任务');
  const safeStatus = plainText(status, MAX_STATUS_LENGTH, '未知');
  const safeSubmitted = markdownText(submitted, MAX_SUMMARY_LENGTH);
  const safeNote = markdownText(note, 500);

  return card(safeTitle, [
    {
      tag: 'markdown',
      element_id: 'topic_context',
      content: `**${markdownLiteral(safeTitle, MAX_TITLE_LENGTH)}**\n状态：${markdownLiteral(safeStatus, MAX_STATUS_LENGTH)}`,
    },
    ...(safeSubmitted ? [{
      tag: 'markdown',
      element_id: 'submitted',
      content: `**你提交的内容**\n${safeSubmitted}`,
    }] : []),
    {
      tag: 'markdown',
      element_id: 'topic_help',
      content: safeNote || '这个主题用于收拢阶段进展和最终结果。要继续发送，请重新使用 `/codex`。',
      text_size: 'notation',
    },
  ]);
}

export function completionCard({ title, status, summary } = {}) {
  const safeTitle = plainText(title, MAX_TITLE_LENGTH, 'Codex 任务');
  const safeStatus = plainText(status, MAX_STATUS_LENGTH, '已完成');

  return card(safeTitle, [
    {
      tag: 'markdown',
      element_id: 'completion_state',
      content: `**${markdownLiteral(safeStatus, MAX_STATUS_LENGTH)}**`,
    },
    {
      tag: 'markdown',
      element_id: 'completion_summary',
      content: markdownText(summary, MAX_RESULT_LENGTH, '暂无最终结果。'),
    },
  ], safeStatus);
}

export function streamingProgressCard({ title, content = '', completed = false, streaming = true } = {}) {
  const safeTitle = plainText(title, MAX_TITLE_LENGTH, 'Codex 任务');
  const safeContent = typeof content === 'string' ? content.slice(0, 12_000) : '';
  const status = completed ? '已完成' : '处理中';
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      ...(streaming ? {
        streaming_mode: true,
        summary: { content: `${safeTitle} · ${status}` },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      } : {}),
    },
    header: {
      title: { tag: 'plain_text', content: safeTitle },
      template: 'blue',
      text_tag_list: [{
        tag: 'text_tag',
        text: { tag: 'plain_text', content: status },
        color: 'blue',
      }],
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'large',
      elements: [
        {
          tag: 'column_set',
          flex_mode: 'none',
          columns: [{
            tag: 'column', width: 'weighted', weight: 1,
            background_style: 'blue-50', padding: '12px',
            elements: [{
              tag: 'markdown', element_id: 'state',
              content: completed ? '**Codex 已完成**\n下方内容为最终结果。' : '**Codex 正在执行**\n下方显示最新阶段进展与最近行为。',
            }],
          }],
        },
        { tag: 'markdown', element_id: 'content', content: safeContent },
        { tag: 'markdown', element_id: 'note', content: "<font color='grey'>来自 Codex App Server 的可见进展</font>", text_size: 'notation' },
      ],
    },
  };
}

function activityStatus(value) {
  if (value === 'running' || value === 'inProgress' || value === 'in_progress') return '运行中';
  if (value === 'completed') return '已完成';
  if (value === 'failed') return '失败';
  return '';
}

function eventTime(value) {
  let date;
  if ((typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\d+$/.test(value))) {
    let milliseconds = Number(value);
    if (milliseconds > 1e17) milliseconds /= 1_000_000;
    else if (milliseconds > 1e14) milliseconds /= 1_000;
    else if (milliseconds < 1e11) milliseconds *= 1_000;
    date = new Date(milliseconds);
  } else date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(part => String(part).padStart(2, '0')).join(':');
}

function activityText(activity) {
  if (!activity || typeof activity !== 'object') return '';
  const status = activityStatus(activity.status);
  let detail = '';
  if (activity.type === 'command') detail = activity.command ? `运行命令：${markdownLiteral(activity.command, 360)}` : '运行命令';
  else if (activity.type === 'file_change') {
    const files = Array.isArray(activity.files) ? activity.files.map(file => file?.path).filter(path => typeof path === 'string').slice(0, 3) : [];
    detail = files.length ? `修改文件：${markdownLiteral(files.join('、'), 360)}` : '修改文件';
  } else if (activity.type === 'tool') {
    const name = [activity.server, activity.tool].filter(value => typeof value === 'string' && value).join(' / ');
    detail = name ? `调用工具：${markdownLiteral(name, 240)}` : '调用工具';
  } else if (activity.type === 'subagent' || activity.type === 'subagent_tool') {
    const name = activity.agentPath || activity.tool || activity.kind;
    detail = name ? `子任务：${markdownLiteral(name, 240)}` : '处理子任务';
  }
  return detail ? `- **${eventTime(activity.timestamp)}** · ${detail}${status ? `（${status}）` : ''}` : '';
}

export function streamingProgressText(messages, activities = []) {
  const texts = Array.isArray(messages) ? messages : [];
  const phase = texts.map(message => ({
    content: markdownText(typeof message === 'string' ? message : message?.text, 3_800),
    time: eventTime(typeof message === 'string' ? undefined : message?.timestamp),
  })).filter(message => message.content).at(-1);
  const recent = (Array.isArray(activities) ? activities : []).map(activityText).filter(Boolean).slice(-3).join('\n');
  if (!phase && !recent) return '';
  return `**阶段进展 · ${phase?.time || '时间未知'}**\n\n${phase?.content || '正在处理，尚无新的阶段说明。'}\n\n---\n\n**最近行为**\n\n${recent || '暂无新的已落盘行为。'}`.slice(0, 12_000);
}

export function streamingFinalText(message) {
  return markdownText(typeof message === 'string' ? message : message?.text, 10_000);
}
