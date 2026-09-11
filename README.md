# Codex DeskBridge

Codex DeskBridge is a local, dependency-free Node.js framework that brings the Codex task workflow to an instant-messaging product. It is designed as a companion for people who use Codex Desktop and Codex CLI, and uses the official Codex App Server protocol as its portable runtime boundary. A Feishu adapter is included as the first full-featured IM implementation.

> Connect Codex Desktop and CLI to the IM you already use.

The portable release does not attach to a running Codex Desktop process, read ChatGPT Desktop databases, call private Desktop IPC methods, copy login tokens, or require a public callback server. Codex owns task persistence and execution; the bridge translates IM events, attachments, progress, results, and approval requests.

## Architecture

```text
Feishu / Slack / Discord / Matrix / custom IM
                    │
             IM adapter contract
                    │
          AgentBridgeFramework core
                    │
             runtime contract
                    │
       Codex App Server (JSONL RPC)
                    │
          local Codex tasks/workspaces
```

The portable command contract currently contains `task.list`, `task.read`, `task.send`, and `task.create`. Codex `runtime.event` notifications flow back to the adapter. Adapters own product-specific UX such as slash commands, topic threads, cards, reactions, attachment transfer, and identity mapping.

## Requirements

- Node.js 24 or later
- A working `codex` executable and signed-in Codex environment
- For Feishu: `lark-cli` configured with a bot profile

Set `CODEX_BIN` when `codex` is not on `PATH`:

```bash
export CODEX_BIN=/absolute/path/to/codex
```

## Run the portable JSONL adapter

```bash
npm test
npm run framework
```

Write one command per line:

```json
{"type":"task.list","requestId":"demo-1","limit":5}
{"type":"task.read","requestId":"demo-2","taskId":"TASK_ID","limit":2}
{"type":"task.send","requestId":"demo-3","taskId":"TASK_ID","text":"Run the tests"}
{"type":"task.create","requestId":"demo-4","text":"Start a projectless task"}
{"type":"task.create","requestId":"demo-5","projectId":"01a0...","cwd":"/absolute/project/root","text":"Inspect this project"}
```

Responses and Codex runtime events are emitted as JSONL. `src/adapters/stdio.mjs` is intentionally small and can be copied as the starting point for another IM adapter.

## Build an IM adapter

An adapter implements three methods:

```js
export class MyImAdapter {
  async start(handle) {
    // Subscribe to the IM platform, then call handle(normalizedEvent).
  }

  async publish(normalizedResultOrRuntimeEvent) {
    // Render and send or update the native IM message.
  }

  async stop() {
    // Close subscriptions and release resources.
  }
}
```

Wire it to Codex:

```js
import { AgentBridgeFramework } from 'codex-deskbridge';
import { CodexAppServerRuntime } from 'codex-deskbridge/codex';

const bridge = new AgentBridgeFramework({
  runtime: new CodexAppServerRuntime(),
  adapter: new MyImAdapter(),
});

await bridge.start();
```

Use the incoming IM message ID as `requestId`. The Codex adapter turns it into a stable `clientUserMessageId`, so retrying a known request does not invent a second identity.

## Feishu implementation

Copy `bridge.example.json` to `.local/bridge.json`, fill in your local `lark-cli` profile and permitted Feishu users, then run:

```bash
npm run bridge
```

Install it as a per-user macOS service:

```bash
npm run service:install
npm run service:status
```

The Feishu implementation supports project/task selection, topic cards, progress replacement, results, images/files, and an `OnIt` reaction after Codex accepts a topic reply. Runtime data stays under `.local/`, which is excluded from source and npm packages.

## Approval handling

Codex can ask its client to approve commands, file changes, or permissions. `AppServerClient` exposes these as server requests through the `onServerRequest` option. Until an adapter implements an authenticated approval flow, the default handler declines command and file-change requests. It never auto-approves them.

## Release safety

Run these before publishing:

```bash
npm test
npm run release:check
npm pack --dry-run
```

Do not commit `.local/`, `work/`, Codex state, downloaded IM attachments, profiles, logs, database files, or real task transcripts. See [SECURITY.md](SECURITY.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [the open-source review](docs/open-source-review.md).

## Project status

Version `0.1.0` is an early framework release. The Codex App Server interface is the supported runtime boundary. The Feishu experience is more complete than the portable adapter contract; approval UI and reusable rich-card primitives remain extension points.

MIT licensed. This community project is not affiliated with or endorsed by OpenAI or Feishu. Codex, ChatGPT, OpenAI, Feishu, and other product names are trademarks of their respective owners.
