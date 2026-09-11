# Architecture

## Boundaries

`AgentBridgeFramework` routes normalized commands between two replaceable sides:

- An **IM adapter** receives native events, authenticates the sender, downloads allowed attachments, and renders replies.
- A **runtime adapter** lists, reads, creates, and continues coding-agent tasks and emits live runtime events.

`CodexAppServerRuntime` implements the runtime contract over Codex App Server JSONL RPC. It owns one long-lived subprocess, matches responses by request ID, accepts interleaved notifications, and surfaces client requests without granting them implicitly.

The bundled Feishu service contains richer state for topic roots, CardKit updates, deduplication, and task subscriptions. It consumes the same runtime method surface and is the reference for capabilities that future reusable adapter helpers should extract.

## Normalized IM commands

| Type | Required fields | Result |
| --- | --- | --- |
| `task.list` | none | recent local tasks |
| `task.read` | `taskId` | task metadata, turns, visible messages and activities |
| `task.send` | `taskId`, `text` | accepted Codex turn |
| `task.create` | `cwd`, `text` | new durable task and accepted first turn |

Optional `images` and `files` are absolute local paths prepared by the IM adapter. The runtime sends images as `localImage` inputs. Other files are described to Codex as local attachments so the agent can inspect them with its configured tools.

## Security invariants

- IM identity and authorization are decided before an event reaches the runtime.
- Native task IDs should not be trusted when they round-trip through an interactive card; store an opaque, expiring server-side reference.
- A request ID comes from the native IM event and remains stable across transport retries.
- Runtime approvals require an authenticated adapter decision. The default is denial.
- The framework does not access private Desktop IPC, browser cookies, ChatGPT tokens, or Codex state databases directly.
- Local attachments need size, count, path, and retention limits in each adapter.

## Extension direction

New runtimes implement the same four task methods and emit `event`. New IM integrations implement `start`, `publish`, and `stop`. Rich IM capabilities can be optional adapter capabilities without making them mandatory for text-only products.

