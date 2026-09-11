# Feishu adapter

The bundled Feishu service is the first rich IM implementation. It uses `lark-cli` event consumers and outbound commands, so no public callback listener is required.

## Configuration

Copy `bridge.example.json` to `.local/bridge.json` and set your `lark-cli` profile plus permitted Feishu users. `codex.binary` is optional when `codex` is on `PATH`. Valid approval policies are `untrusted`, `on-request`, and `never`. A policy that can request approval still needs an authenticated `onServerRequest` handler; the built-in default declines requests.

## Capabilities

- Two-level project and task picker with opaque references
- New durable task creation
- One Feishu topic per Codex task
- In-place CardKit progress replacement and final result rendering
- Text, image, and file input from task topics
- `OnIt` reaction when Codex accepts a user reply
- Local idempotency, task fences, and restart-safe topic state

Runtime state and downloaded attachments live under `.local/bridge/<profile>/`. They are private deployment data and must never enter source control.

## Service

```bash
npm run service:install
npm run service:status
npm run service:logs
npm run service:restart
npm run service:uninstall
```

The LaunchAgent label is `io.github.agent-im-bridge.service`. Installation is per macOS user because both Codex state and Feishu credentials belong to that user session.

