const messages = {
  BRIDGE_LOCKED: '已有桥接服务在运行。请用 npm run service:status 查看，或 npm run service:stop 停止；无需手动查找和杀进程。',
  CONFIG_MISSING: '找不到配置文件。请创建 .local/bridge.json，或通过 npm run bridge -- 配置路径 指定。',
  CONFIG_INVALID_JSON: '配置文件不是有效的 JSON，请检查引号、逗号和括号。',
  CONFIG_PROFILE: '配置 profile 必须是有效的飞书 CLI 配置名称。',
  CONFIG_USERS: '配置 allowedUsers 必须包含至少一个有效的 ou_ 用户标识。',
  CONFIG_DISCOVERY: '配置 autoDiscover 必须是 true 或 false。',
  CONFIG_INTERVAL: '配置 pollIntervalMs 必须是 5000 到 300000 之间的整数。',
};
export function startupMessage(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'CONFIG_OR_TRANSPORT_ERROR';
  const pid = code === 'BRIDGE_LOCKED' && Number.isSafeInteger(error?.lockPid) ? ` PID=${error.lockPid}。` : '';
  return `Bridge startup failed [${code}]: ${messages[code] || '启动失败。请检查配置文件权限、lark-cli 是否可运行以及所选 profile 的登录/事件连接状态。'}${pid}\n`;
}
