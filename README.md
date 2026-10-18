# DeepSeek Harness for Codex — Desktop Attach

这是 [Seann0824/deepseek-harness-for-codex](https://github.com/Seann0824/deepseek-harness-for-codex) 的个人 fork，保留 MIT 许可证。默认把 Codex 连接到**已经运行且由用户授权的 DSH Desktop Host**，复用该 Host 已配置的模型和会话，人工审批继续在 Desktop GUI 中处理。

本分支为 `0.4.0-desktop.1`，适配依据是 Desktop **0.2.1-rc.2 安装包中的契约**，不是持续追踪 master。尚未使用真实模型完成端到端验收；模拟测试不能代替真实认证和模型验证。本 fork 没有发布 npm 包。

## 安装

需要 Node.js >=22，以及支持插件的 Codex 客户端。插件携带自包含构建，不通过 npx 下载另一个 DSH。

```sh
codex plugin marketplace add lpp12138/deepseek-harness-for-codex --ref codex/desktop-attach
codex plugin add deepseek-harness@deepseek-harness-desktop
```

在插件 MCP 配置中将 `DSH_MCP_WORKSPACE_ROOTS` 设置为明确授权的绝对项目目录；多个根目录使用平台路径分隔符。未配置根目录时不会派发任务。安装或更新后新建 Codex 任务加载工具。若保留上游插件作为回滚，请关闭旧插件，避免两个同名 MCP 同时加载。

## 认证：需要用户明确批准的连接文件

1. 用户必须通过受支持的入口取得现有 Host 的授权连接地址。文件内容只能是一行 `http://127.0.0.1:<当前端口>/connect?token=<已授权的启动令牌>`，也接受 loopback HTTPS/IPv6。端口来自用户提供的地址，不固定端口。
2. 用户自行把地址保存到本地文件，并限制文件权限（例如 `chmod 600 /absolute/approved-connection.txt`）。不要把地址或令牌粘贴进聊天、命令参数、Git 或 Codex 配置。
3. 用户提供该文件路径，并明确批准插件读取该文件、把 URL 发送到指定 loopback `/connect`、创建一个 API Peer。然后 Codex 才可调用 `connect_desktop`。提供文件路径的权限不会自动延伸到其他凭据或文件。
4. 插件以 `interactions=none` 交换 Cookie，并保持 `/api/remote.mux` WebSocket。令牌和 Cookie 都不落盘、不出现在结果中。Cookie 对 Host 是 owner 身份；插件自身另行限制项目和会话范围。断线后凭据立即从插件内存失效，需要明确重新连接。

**当前已知限制：**Desktop 内部把启动认证 URL 通过私有 Node IPC 交给 Electron；尚未找到其面向用户的“导出外部连接地址”入口。不能因用户安装了插件就假定拿到了该权限。没有合法连接地址时 `doctor` 只报告缺项，任务停在认证前。插件不会从私有 IPC、日志、环境、会话目录、凭据文件或数据库发现 token，也不会抓取浏览器 Cookie、伪造 Cookie、关闭认证或另起 Web 服务。用户不需要为“检查接口”重新配置模型。

## 日常委派

- 先调用 `doctor`；默认 `desktop-attach`，没有认证或目录限制时返回精确缺项。
- 只在用户已明确批准连接文件时调用 `connect_desktop`。
- `start_run` 创建同一 Desktop Host 中的会话，发送一次带唯一 `requestId` 的任务。发送前要求会话当前权限为 `workspace-write`。若需要在 GUI 更改权限，错误会给出空白会话的 sessionId，随后可用该 sessionId 继续。
- 展示 **[打开 Desktop](dsh://open)** 和返回的 `sessionId`。`dsh://open` 是本机版本正式注册的入口，**只聚焦应用，不选择会话**。用户在列表中选择对应会话。返回的 `webUrl` 是去除秘密的 Host origin，不承诺未认证浏览器能直接打开它；不要伪造带 sessionId 的深链。
- `get_run` / `wait_run` 读取状态和本轮输出；人工审批由 GUI 回答。插件不订阅回答型 `$events`，也没有自动批准接口。
- `cancel_run` 只取消该会话当前 turn，保留 Desktop 和会话。完成后给 `start_run` 同一个 sessionId 可继续；不允许并发控制同一会话。
- MCP 重启后可以找回 runId/sessionId/requestId 和 GUI 入口；重新连接后检查原会话，绝不自动重发收费任务。提示词和结果不存入插件的持久元数据。
- Codex 仍须独立检查实际文件改动并运行合适的验证。

## 工具与模式

| 工具 | Desktop attach 行为 |
| --- | --- |
| `doctor` | 只读本机运行前提和连接状态，不读取连接文件、不探测凭据 |
| `connect_desktop` | 用户批准后，读取一个指定文件并建立被动 API Peer |
| `start_service` / `list_services` | 检查或列出已有 Host 的附件，不启动 DSH |
| `open_service` | 仅在用户要求时聚焦 Desktop |
| `stop_service` | 只断开插件自己的 Peer；不停止 Desktop、不取消其任务 |
| `start_run` / `get_run` / `wait_run` / `list_runs` | 派发、观察和恢复持久会话标识 |
| `read_session` | 对已派发会话或同目录选定空白会话读状态与分页历史，不发送提示词 |
| `get_run_events` / `get_run_control` | 读取该会话的 follow 流或 control 投影；follow 可能物化该会话 |
| `cancel_run` | 取消当前 turn |
| `list_models` | 查询 Host 已配置的模型目录，服务商可能刷新目录 |
| `select_model` | 仅在用户明确要求时选择空闲会话模型；Host 同时会后台保存为新会话默认值 |

`DSH_MCP_MODE=desktop-attach` 为默认值。`managed-web` 是显式选择的旧模式，使用上游固定的 `@deepseek-ai/dsh@0.1.0-rc.6`；不会因 attach 失败而自动启用。旧模式仍支持上游环境变量，但其旧协议不能当作 Desktop 0.2.1 的协议。

`DSH_MCP_DATA_DIR` 指定插件元数据目录，默认采用 Codex `PLUGIN_DATA` 或 `~/.deep-seek-harness-mcp`。`desktop-runs/` 每个运行一个原子写入的元数据文件（不含提示词、结果、token、Cookie），`desktop-locks/` 防止同一数据目录下的 MCP 客户端并发控制同一会话。其他程序和 GUI 独立发起的操作仍由 Host 管理；插件不能给远端 API 增加事务锁。

## 开发和验证

```sh
npm ci --ignore-scripts
npm run check
```

测试中的 Host、端口、凭据、模型和会话都是合成数据，不连接真实 Desktop、不调用模型。构建一次生成 `plugins/deepseek-harness/dist/bin.mjs`，依赖已打包以支持 Git 插件安装。修改源码后应同时更新这个构建文件。

接口差异与验收边界见 [Desktop 协议说明](docs/desktop-protocol.md)。
