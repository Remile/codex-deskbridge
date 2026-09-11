# 飞书鉴权与机器人配置

Codex DeskBridge 以飞书机器人身份运行，通过 WebSocket 长连接接收事件，因此不需要用户 OAuth，也不需要公网回调地址。App Secret 与 tenant access token 由 `lark-cli` 保存和维护，不会写入 `bridge.json`。

## 1. 安装 `lark-cli`

```bash
npx @larksuite/cli@latest install
lark-cli --version
```

## 2. 创建或绑定飞书应用 profile

创建一个新应用时，使用浏览器引导流程：

```bash
lark-cli config init --new --name codex-deskbridge --brand feishu
```

绑定已有的企业自建应用时，从飞书开发者后台复制 App ID，然后运行：

```bash
lark-cli config init --name codex-deskbridge \
  --app-id cli_xxx --app-secret-stdin --brand feishu
```

从标准输入粘贴 App Secret，按 `Ctrl-D` 结束输入。不要把 App Secret 放进命令行参数、环境文件、`bridge.json` 或 Git。

验证 profile 能以机器人身份工作：

```bash
lark-cli --profile codex-deskbridge whoami --as bot
lark-cli --profile codex-deskbridge auth scopes --json
```

`whoami` 应返回 `ok: true` 和 `identity: "bot"`。DeskBridge 不需要执行 `lark-cli auth login`。

## 3. 在飞书开发者后台配置应用

打开[飞书开发者后台](https://open.feishu.cn/app)，选择对应的企业自建应用并完成以下配置。

### 启用机器人

在 **应用能力** 中添加并启用 **机器人**。

### 开通权限

在 **权限管理** 中开通以下应用身份权限：

| Scope | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:message:send_as_bot` | 发送任务话题、卡片、进展和最终结果 |
| `im:message:readonly` | 读取卡片回调上下文以及下载消息附件 |
| `im:message:update` | 原位更新已有任务卡片 |
| `im:message.reactions:write_only` | 受理请求后添加“在做了”表情 |
| `im:resource` | 上传结果中的图片和文件 |
| `cardkit:card:write` | 创建和更新 CardKit 流式卡片 |

如果后台同时提供 `im:message` 这类范围更大的替代权限，优先使用上表中的最小权限。

### 配置长连接事件与回调

在 **事件与回调** 中选择 **使用长连接接收事件/回调**，并添加：

| Event key | 后台事件 |
| --- | --- |
| `im.message.receive_v1` | 接收消息 |
| `card.action.trigger` | 卡片交互回调 |

事件订阅和回调配置都需要启用。缺少卡片回调配置时，文字监听仍可能正常启动，但任务选择卡片的点击不会传给 DeskBridge。

### 发布并设置可用范围

修改权限或订阅后创建并发布一个应用版本，将自己的飞书账号加入应用可用范围，然后打开与机器人的单聊。

## 4. 获取自己的 `open_id`

启动一个只接收一条消息的监听器：

```bash
lark-cli --profile codex-deskbridge event consume im.message.receive_v1 \
  --as bot --max-events 1 --timeout 2m --jq '{sender_id,chat_id}'
```

看到 ready 标记后，给机器人发送任意一条单聊消息。命令会输出类似：

```json
{"sender_id":"ou_xxx","chat_id":"oc_xxx"}
```

将 `sender_id` 填入允许用户列表。`chat_id` 会从收到的消息中自动获取，无需配置。

## 5. 创建 DeskBridge 配置

```bash
mkdir -p .local
cp bridge.example.json .local/bridge.json
```

编辑 `.local/bridge.json`：

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

`allowedUsers` 中每一项都必须是以 `ou_` 开头的飞书 `open_id`。获准用户可以向本机 Codex 下达指令，因此应保持最小允许范围。

## 6. 验证并运行

先检查两个订阅的鉴权与前置条件：

```bash
lark-cli --profile codex-deskbridge event consume im.message.receive_v1 --as bot --dry-run
lark-cli --profile codex-deskbridge event consume card.action.trigger --as bot --dry-run
```

在前台启动 DeskBridge：

```bash
npm run bridge
```

日志出现 `BRIDGE_READY` 后，给机器人发送 `/codex`。前台验证完成后用 `Ctrl-C` 停止，再安装后台服务：

```bash
npm run service:install
npm run service:status
```

## 常见问题

- `CONFIG_PROFILE`：`.local/bridge.json` 中的 profile 不存在。运行 `lark-cli profile list`，填写完全一致的名称。
- `CONFIG_USERS`：`allowedUsers` 为空，或其中存在不是 `ou_...` 的值。
- 返回 `missing_scopes` 或 `console_url`：打开返回的开发者后台链接，开通缺失的机器人权限，发布新版本后重试。机器人权限缺失时不要执行 `auth login`。
- 机器人能收到文字，但点击选择卡片没有反应：启用 `card.action.trigger` 回调并重新发布应用。
- 完全收不到消息：检查应用可用范围、机器人能力、长连接模式以及 `im.message.receive_v1` 订阅。
- 本地诊断可运行 `lark-cli --profile codex-deskbridge doctor` 和 `npm run service:logs`。

