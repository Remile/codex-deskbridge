import { EventEmitter } from 'node:events';

const COMMANDS = new Set(['task.list', 'task.read', 'task.send', 'task.create']);

function invalid(message) { return Object.assign(new Error(message), { code: 'INVALID_ADAPTER_EVENT', status: 400 }); }

export function validateAdapterEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw invalid('Adapter event must be an object.');
  if (!COMMANDS.has(event.type)) throw invalid(`Unsupported adapter event: ${event.type}`);
  if (event.requestId !== undefined && typeof event.requestId !== 'string') throw invalid('requestId must be a string.');
  if (['task.read', 'task.send'].includes(event.type) && (typeof event.taskId !== 'string' || !event.taskId)) throw invalid('taskId is required.');
  if (event.type === 'task.send' && typeof event.text !== 'string') throw invalid('text is required.');
  if (event.type === 'task.create' && typeof event.text !== 'string') throw invalid('text is required.');
  if (event.type === 'task.create' && event.cwd !== undefined && typeof event.cwd !== 'string') throw invalid('cwd must be a string.');
  if (event.type === 'task.create' && event.projectId !== undefined && typeof event.projectId !== 'string') throw invalid('projectId must be a string.');
  return event;
}

/**
 * Minimal portable core. An IM adapter translates its native events into these
 * commands and renders the normalized responses in whatever UX it supports.
 */
export class AgentBridgeFramework extends EventEmitter {
  constructor({ runtime, adapter }) {
    super();
    if (!runtime || !adapter || typeof adapter.start !== 'function' || typeof adapter.publish !== 'function') {
      throw new TypeError('runtime and adapter are required');
    }
    this.runtime = runtime;
    this.adapter = adapter;
    this.started = false;
    this.onRuntimeEvent = event => void this.adapter.publish({ type: 'runtime.event', event });
  }

  async start() {
    if (this.started) return;
    await this.runtime.start?.();
    this.runtime.on?.('event', this.onRuntimeEvent);
    await this.adapter.start(event => this.handle(event));
    this.started = true;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    this.runtime.off?.('event', this.onRuntimeEvent);
    await this.adapter.stop?.();
    await this.runtime.stop?.();
  }

  async handle(rawEvent) {
    let event;
    try {
      event = validateAdapterEvent(rawEvent);
      let data;
      if (event.type === 'task.list') data = await this.runtime.listThreads({ limit: event.limit });
      if (event.type === 'task.read') data = await this.runtime.readThread({ threadId: event.taskId, limit: event.limit });
      if (event.type === 'task.send') data = await this.runtime.sendMessage({ threadId: event.taskId, text: event.text, images: event.images || [], files: event.files || [] }, { requestKey: event.requestId });
      if (event.type === 'task.create') data = await this.runtime.createTask({ cwd: event.cwd, projectId: event.projectId, text: event.text, images: event.images || [], files: event.files || [] }, { requestKey: event.requestId });
      const response = { type: 'command.result', requestId: event.requestId, command: event.type, ok: true, data };
      await this.adapter.publish(response);
      this.emit('result', response);
      return response;
    } catch (error) {
      const response = { type: 'command.result', requestId: rawEvent?.requestId, command: rawEvent?.type, ok: false,
        error: { code: error?.code || 'BRIDGE_ERROR', message: error?.message || 'Bridge operation failed' } };
      await this.adapter.publish(response);
      this.emit('result', response);
      return response;
    }
  }
}
