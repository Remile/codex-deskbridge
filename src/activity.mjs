const MAX_TEXT_LENGTH = 32_000;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_REASONING_LENGTH = 300;
const MAX_ARRAY_LENGTH = 50;
const MAX_THREAD_IDS = 30;

const TEXT_PART_TYPES = new Set(['Text', 'text', 'input_text', 'output_text']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

export function actionStatus(value, eventStatus) {
  const status = stringValue(value);
  // A completed event can retain the item's earlier in-progress field. Keep
  // explicit failures, but never let that stale field hide the terminal event.
  if (eventStatus === 'completed' && (!status || ['running', 'inProgress', 'in_progress'].includes(status))) return 'completed';
  return status || stringValue(eventStatus);
}

export function subagentStatus(kind) {
  if (kind === 'completed' || kind === 'interrupted') return kind;
  if (kind === 'started' || kind === 'interacted') return 'running';
  return undefined;
}

function commandText(value) {
  if (typeof value === 'string') return value.slice(0, MAX_COMMAND_LENGTH);
  if (!Array.isArray(value) || value.some(part => typeof part !== 'string')) return '';
  // Desktop records shell commands as [shell, "-lc", source]. Show the source
  // users recognize in the app instead of the shell launcher wrapper.
  const text = value.length >= 3 && value[1] === '-lc' ? value[2] : value.join(' ');
  return text.slice(0, MAX_COMMAND_LENGTH);
}

function base(item, type, context) {
  return {
    id: item.id,
    type,
    timestamp: context.timestamp,
    turnId: context.turnId,
  };
}

function textFromContent(content) {
  if (typeof content === 'string') return content.slice(0, MAX_TEXT_LENGTH);
  if (!Array.isArray(content)) return '';

  return content.slice(0, MAX_ARRAY_LENGTH)
    .filter(part => isObject(part) && TEXT_PART_TYPES.has(part.type) && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .slice(0, MAX_TEXT_LENGTH);
}

function fileEntry(path, kind) {
  if (typeof path !== 'string' || path.length === 0) return null;
  return {
    path,
    ...(typeof kind === 'string' ? { kind } : isObject(kind) && typeof kind.type === 'string' ? { kind: kind.type } : {}),
  };
}

function fileEntries(changes) {
  if (Array.isArray(changes)) {
    const files = [];
    for (const change of changes.slice(0, MAX_ARRAY_LENGTH)) {
      if (!isObject(change)) continue;
      const entry = fileEntry(change.path, change.kind ?? change.type);
      if (entry) files.push(entry);
    }
    return files;
  }

  if (!isObject(changes)) return [];

  // Accept a single change object as well as a map keyed by path. The latter
  // is used by some persisted event versions.
  if (typeof changes.path === 'string') {
    const entry = fileEntry(changes.path, changes.kind ?? changes.type);
    return entry ? [entry] : [];
  }

  const files = [];
  for (const path of Object.keys(changes).slice(0, MAX_ARRAY_LENGTH)) {
    const change = changes[path];
    const kind = typeof change === 'string' ? change : isObject(change) ? (change.kind ?? change.type) : undefined;
    const entry = fileEntry(path, kind);
    if (entry) files.push(entry);
  }
  return files;
}

function summaryText(value) {
  if (typeof value === 'string') return value.slice(0, MAX_REASONING_LENGTH);
  if (!Array.isArray(value)) return '';
  return value.slice(0, MAX_ARRAY_LENGTH)
    .filter(part => typeof part === 'string')
    .join('\n')
    .slice(0, MAX_REASONING_LENGTH);
}

export function normalizeItem(item, options = {}) {
  if (!isObject(item) || typeof item.type !== 'string') return null;
  const context = isObject(options) ? options : {};

  switch (item.type) {
    case 'UserMessage':
      return {
        ...base(item, 'message', context),
        role: 'user',
        phase: 'user',
        text: textFromContent(item.content),
      };

    case 'AgentMessage':
      return {
        ...base(item, 'message', context),
        role: 'assistant',
        phase: typeof item.phase === 'string' && item.phase ? item.phase : 'final_answer',
        text: textFromContent(item.content),
      };

    case 'CommandExecution': {
      const normalized = {
        ...base(item, 'command', context),
        command: commandText(item.command),
        status: actionStatus(item.status, context.status),
      };
      const exitCode = hasOwn(item, 'exitCode') ? item.exitCode : item.exit_code;
      if (typeof exitCode === 'number' && Number.isFinite(exitCode)) normalized.exitCode = exitCode;
      return normalized;
    }

    case 'FileChange':
      return {
        ...base(item, 'file_change', context),
        status: actionStatus(item.status, context.status),
        files: fileEntries(item.changes),
      };

    case 'SubAgentActivity':
      return {
        ...base(item, 'subagent', context),
        kind: stringValue(item.kind),
        status: subagentStatus(item.kind),
        agentThreadId: stringValue(item.agent_thread_id),
        agentPath: stringValue(item.agent_path),
      };

    case 'CollabAgentToolCall':
      return {
        ...base(item, 'subagent_tool', context),
        tool: stringValue(item.tool),
        status: actionStatus(item.status, context.status),
        threadIds: Array.isArray(item.receiver_thread_ids)
          ? item.receiver_thread_ids.filter(value => typeof value === 'string').slice(0, MAX_THREAD_IDS)
          : [],
      };

    case 'McpToolCall':
      return {
        ...base(item, 'tool', context),
        server: stringValue(item.server),
        tool: stringValue(item.tool),
        status: actionStatus(item.status, context.status),
      };

    case 'Reasoning': {
      const text = summaryText(item.summary_text);
      if (!text) return null;
      return {
        ...base(item, 'reasoning_summary', context),
        text,
      };
    }

    default:
      return null;
  }
}
