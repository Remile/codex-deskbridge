# Feishu authentication and bot setup

Codex DeskBridge runs as a Feishu bot. It uses the bot identity and a WebSocket long connection, so it does not need user OAuth or a public callback URL. `lark-cli` stores the App Secret and obtains tenant access tokens; Codex DeskBridge never reads credentials from `bridge.json`.

## 1. Install `lark-cli`

```bash
npx @larksuite/cli@latest install
lark-cli --version
```

## 2. Create or bind a Feishu app profile

For a new app, run the guided browser flow:

```bash
lark-cli config init --new --name codex-deskbridge --brand feishu
```

For an existing custom app, copy its App ID from the Feishu Developer Console and run:

```bash
lark-cli config init --name codex-deskbridge \
  --app-id cli_xxx --app-secret-stdin --brand feishu
```

Paste the App Secret into standard input and finish with `Ctrl-D`. Do not put the secret in a command-line argument, environment file, `bridge.json`, or Git.

Verify that the named profile resolves to the bot identity:

```bash
lark-cli --profile codex-deskbridge whoami --as bot
lark-cli --profile codex-deskbridge auth scopes --json
```

`whoami` should return `ok: true` and `identity: "bot"`. User login with `lark-cli auth login` is not required for DeskBridge.

## 3. Configure the app in Feishu Developer Console

Open the [Feishu Developer Console](https://open.feishu.cn/app), select the custom app, and complete these settings.

### Enable the bot

Under **App capabilities**, add and enable **Bot**.

### Grant scopes

Under **Permissions**, grant these application/bot scopes:

| Scope | Used for |
| --- | --- |
| `im:message.p2p_msg:readonly` | Receive direct messages sent to the bot |
| `im:message:send_as_bot` | Send topic roots, cards, progress, and results |
| `im:message:readonly` | Read card callback context and download message resources |
| `im:message:update` | Replace an existing task card |
| `im:message.reactions:write_only` | Add the `OnIt` reaction after accepting a request |
| `im:resource` | Upload result images and files |
| `cardkit:card:write` | Create and update CardKit streaming cards |

If the console offers a broader scope such as `im:message` as an alternative, the narrower scopes above are preferred.

### Enable long-connection events and callbacks

Under **Events & Callbacks**, select **Use long connection to receive events/callbacks** and add:

| Event key | Console event |
| --- | --- |
| `im.message.receive_v1` | Receive messages |
| `card.action.trigger` | Card interaction callback |

Enable the callback configuration as well as the event subscription. A missing card callback configuration lets the text listener start, but task-picker interactions will never arrive.

### Publish and make the app available

Create and publish an app version after changing permissions or subscriptions. Include your own Feishu account in the app availability range, then open a direct conversation with the bot.

## 4. Obtain your `open_id`

Start a one-event listener:

```bash
lark-cli --profile codex-deskbridge event consume im.message.receive_v1 \
  --as bot --max-events 1 --timeout 2m --jq '{sender_id,chat_id}'
```

Wait for the ready marker, then send any direct message to the bot. The command prints an object like:

```json
{"sender_id":"ou_xxx","chat_id":"oc_xxx"}
```

Use `sender_id` as your allowed user. `chat_id` is discovered from incoming messages and does not need to be configured.

## 5. Create the bridge configuration

```bash
mkdir -p .local
cp bridge.example.json .local/bridge.json
```

Edit `.local/bridge.json`:

```json
{
  "profile": "codex-deskbridge",
  "allowedUsers": ["ou_xxx"],
  "autoDiscover": true,
  "pollIntervalMs": 5000,
  "codex": {
    "approvalPolicy": "on-request"
  }
}
```

Every entry in `allowedUsers` must be an explicit Feishu `open_id` beginning with `ou_`. Keep the allowlist narrow because an allowed user can instruct the local Codex runtime.

## 6. Validate and run

Check both subscriptions without starting a permanent consumer:

```bash
lark-cli --profile codex-deskbridge event consume im.message.receive_v1 --as bot --dry-run
lark-cli --profile codex-deskbridge event consume card.action.trigger --as bot --dry-run
```

Start DeskBridge in the foreground:

```bash
npm run bridge
```

Wait for a `BRIDGE_READY` log entry, then send `/codex` to the bot. Stop the foreground process with `Ctrl-C` before installing the background service:

```bash
npm run service:install
npm run service:status
```

## Troubleshooting

- `CONFIG_PROFILE`: the `profile` in `.local/bridge.json` does not exist. Run `lark-cli profile list` and use the exact profile name.
- `CONFIG_USERS`: `allowedUsers` is empty or contains a value that is not an `ou_...` open ID.
- `missing_scopes` or `console_url`: open the returned Developer Console URL, grant the reported bot scope, publish a new app version, and retry. Do not run `auth login` for a missing bot scope.
- The bot receives text but picker clicks do nothing: enable `card.action.trigger` under callback configuration and publish the app again.
- No messages arrive: verify the app availability range, bot capability, long-connection mode, and `im.message.receive_v1` subscription.
- Run `lark-cli --profile codex-deskbridge doctor` and `npm run service:logs` for local diagnostics.

