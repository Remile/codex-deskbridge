import { createInterface } from 'node:readline';

/** JSONL reference adapter. It doubles as a test harness for new IM adapters. */
export class StdioAdapter {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.lines = null;
  }

  async start(handle) {
    this.lines = createInterface({ input: this.input, crlfDelay: Infinity });
    this.lines.on('line', line => {
      if (!line.trim()) return;
      try { void handle(JSON.parse(line)); }
      catch { void this.publish({ type: 'command.result', ok: false, error: { code: 'INVALID_JSON', message: 'Input must be one JSON object per line.' } }); }
    });
  }

  async publish(event) { this.output.write(JSON.stringify(event) + '\n'); }
  async stop() { this.lines?.close(); this.lines = null; }
}

