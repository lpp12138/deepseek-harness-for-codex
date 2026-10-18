# DeepSeek Harness for Codex — Desktop Attach

这是 [Seann0824/deepseek-harness-for-codex](https://github.com/Seann0824/deepseek-harness-for-codex) 的个人 fork，保留 MIT 许可证。默认把 Codex 连接到**已经运行且由用户授权的 DSH Desktop Host**。已验证被动连接与模型目录查询；按调用限制目录的任务派发目前因 Desktop 执行侧缺少策略接口而阻止。人工审批仍在 Desktop GUI 中处理。

本分支为 `0.4.0-desktop.2`，适配依据是 Desktop **0.2.1-rc.2 安装包中的契约**，不是持续追踪 master。曾通过用户明确批准的连接文件验证真实认证、被动 WebSocket 与模型目录读取；未发送真实模型任务。模拟测试不能代替真实任务验收。本 fork 没有发布 npm 包。

## 安装

需要 Node.js >=22，以及支持插件的 Codex 客户端。插件携带自包含构建，不通过 npx 下载另一个 DSH。

```sh
codex plugin marketplace add lpp12138/deepseek-harness-for-codex --ref codex/desktop-attach
codex plugin add deepseek-harness@deepseek-harness-desktop
```

Desktop attach 不采用全局 `DSH_MCP_WORKSPACE_ROOTS` 授权：不同 agent/任务必须分别提交 `accessScope.readRoots` 与 `accessScope.writeRoots`，且 Codex 必须在传输层提供当前调用方策略。安装或更新后新建 Codex 任务加载工具。若保留上游插件作为回滚，请关闭旧插件，避免两个同名 MCP 同时加载。

## 认证：需要用户明确批准的连接文件

1. 用户必须通过受支持的入口取得现有 Host 的授权连接地址。文件内容只能是一行 `http://127.0.0.1:<当前端口>/connect?token=<已授权的启动令牌>`，也接受 loopback HTTPS/IPv6。端口来自用户提供的地址，不固定端口。
2. 用户自行把地址保存到本地文件，并限制文件权限（例如 `chmod 600 /absolute/approved-connection.txt`）。不要把地址或令牌粘贴进聊天、命令参数、Git 或 Codex 配置。
3. 用户提供该文件路径，并明确批准插件读取该文件、把 URL 发送到指定 loopback `/connect`、创建一个 API Peer。然后 Codex 才可调用 `connect_desktop`。提供文件路径的权限不会自动延伸到其他凭据或文件。
4. 插件以 `interactions=none` 交换 Cookie，并保持 `/api/remote.mux` WebSocket。令牌和 Cookie 都不落盘、不出现在结果中。Cookie 对 Host 是 owner 身份；插件自身另行限制项目和会话范围。断线后凭据立即从插件内存失效，需要明确重新连接。

**连接入口：**此 Desktop 版本正常从终端启动时会在该终端显示启动认证地址，可由用户自行保存为上述文件；未发现 GUI 内的外部客户端导出入口。不能因用户安装了插件就假定取得了连接权限。没有用户提供并批准的连接文件时 `doctor` 只报告缺项。插件不会从私有 IPC、日志、环境、会话目录、凭据文件或数据库发现 token，也不会抓取浏览器 Cookie、伪造 Cookie、关闭认证或另起 Web 服务。用户不需要为“检查接口”重新配置模型。

## 不同 agent 的目录范围

`start_run` 与 `inspect_access_scope` 接受本次调用的请求范围，例如：

```json
{
  "workspace": "/absolute/project",
  "accessScope": {
    "readRoots": ["/absolute/project", "/absolute/shared-reference"],
    "writeRoots": ["/absolute/project"]
  }
}
```

这些路径由 agent 提出，**不是权限证明**。插件声明 Codex 的实验能力 `codex/sandbox-state`（兼容旧名 `codex/sandbox-state-meta`），仅从工具调用传输层 `_meta` 接收宿主的 `threadId`、`sessionId` 和完整 opaque policy。模型参数内伪造的 `_meta`、MCP `roots/list`、`cwd` 以及全局环境变量都不能授权。缺少可信上下文时拒绝，不猜测默认权限。不会拆解并重建 opaque policy；未知字段也影响策略指纹。

范围规范化检查绝对目录、`realpath`、符号链接实际目标，并区分读与写。会话元数据绑定调用方、策略和范围指纹；观察、取消、续接均重新核对，原路径的实际目标发生变化也会拒绝。不同调用方、变更策略或变更范围不能复用旧会话；未绑定的历史/外来会话不能自动收养。MCP 重启保留元数据，不保留提示词、结果或凭据。

**当前阻塞：**Desktop 0.2.1-rc.2 的 `session/create` 只有 workspace/cwd，没有接收 Codex 逐调用策略或多组读写目录的入口。它的 `workspace-write` 文件层写入限制为 cwd 和临时目录，文件读取并不等同于 Codex 的读取限制。对已运行的 Desktop Host，仅包装 MCP 进程无法约束 Host 的工具进程。提示词声明目录不构成隔离。

因此 `inspect_access_scope` 在收到可信上下文后仍返回 `canDispatch:false`、`desktopPolicyEnforcement:"unavailable"`；`start_run` 在创建 workspace/session 或发送 prompt **之前**拒绝。完整方案需要 DSH 执行侧接收并执行当前调用方的完整策略；本 fork 没有修改 Desktop，也没有通过 managed-web 绕过此阻塞。Codex 端真实逐调用 metadata 是否送达，仍需在加载新版插件的新任务中验证；合成传输测试已通过。

现存生命周期实现的完成、取消、续接和恢复仅通过合成 Host 验证，当前生产派发保持关闭。将来接入原生执行边界后仍须显示 [打开 Desktop](dsh://open) 与 sessionId；该链接只聚焦应用，用户在 GUI 选择会话，不能伪称 session 深链。所有收费真实任务需要另行明确授权。

## 工具与模式

| 工具 | Desktop attach 行为 |
| --- | --- |
| `doctor` | 只读本机运行前提和连接状态，不读取连接文件、不探测凭据 |
| `inspect_access_scope` | 检查本次请求范围与宿主上下文；当前报告缺少 DSH 原生执行边界，不触碰 Host |
| `connect_desktop` | 用户批准后，读取一个指定文件并建立被动 API Peer |
| `start_service` / `list_services` | 检查或列出已有 Host 的附件，不启动 DSH |
| `open_service` | 仅在用户要求时聚焦 Desktop |
| `stop_service` | 只断开插件自己的 Peer；不停止 Desktop、不取消其任务 |
| `start_run` / `get_run` / `wait_run` / `list_runs` | 派发当前阻止；其余操作只接受同一调用方与策略绑定的会话 |
| `read_session` | 仅对同一调用方与策略绑定的已派发会话读状态与分页历史 |
| `get_run_events` / `get_run_control` | 读取该会话的 follow 流或 control 投影；follow 可能物化该会话 |
| `cancel_run` | 取消当前 turn |
| `list_models` | 查询 Host 已配置的模型目录，服务商可能刷新目录 |
| `select_model` | 仅在用户明确要求时选择空闲会话模型；Host 同时会后台保存为新会话默认值 |

`DSH_MCP_MODE=desktop-attach` 为默认值。`managed-web` 是显式选择的旧模式，使用上游固定的 `@deepseek-ai/dsh@0.1.0-rc.6`；不会因 attach 失败而自动启用。旧模式仍支持上游 `DSH_MCP_WORKSPACE_ROOTS` 等环境变量，但其旧协议不能当作 Desktop 0.2.1 的协议。

`DSH_MCP_DATA_DIR` 指定插件元数据目录，默认采用 Codex `PLUGIN_DATA` 或 `~/.deep-seek-harness-mcp`。`desktop-runs/` 每个运行一个原子写入的元数据文件（不含提示词、结果、token、Cookie），`desktop-locks/` 防止同一数据目录下的 MCP 客户端并发控制同一会话。其他程序和 GUI 独立发起的操作仍由 Host 管理；插件不能给远端 API 增加事务锁。

## 开发和验证

```sh
npm ci --ignore-scripts
npm run check
```

测试中的 Host、端口、凭据、模型和会话都是合成数据，不连接真实 Desktop、不调用模型。构建一次生成 `plugins/deepseek-harness/dist/bin.mjs`，依赖已打包以支持 Git 插件安装。修改源码后应同时更新这个构建文件。

接口差异与验收边界见 [Desktop 协议说明](docs/desktop-protocol.md)。
