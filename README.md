# DeepSeek Harness for Codex — Desktop Attach

[上游](https://github.com/Seann0824/deepseek-harness-for-codex)的个人 MIT fork。Codex 插件 `0.5.0-desktop.1` 配合本地 Host 执行插件 `0.1.0`，连接已配置的 DSH Desktop **0.2.1-rc.2**。不另起 DSH，不修改应用包，不发布 npm 包。

已验证真实 Host 的认证、被动 WebSocket、模型目录和 12 项文件/身份边界；56 项自动测试通过。用户配置 Ollama 后，真实 Host 已返回固定字符串回答；完成后在同一会话续接并取消当前 turn，原生 GUI 显示第一轮“已完成”、第二轮“已停止”。测试会话没有额外标题模型请求。上述测试使用受控的合成调用者策略；实际新 Codex 任务的宿主 metadata 传递仍须单独验证，不能从测试驱动推断成功。

## 安装

需要 Node >=22、支持插件与 sandbox metadata 的 Codex、本机 DSH Desktop。

```sh
codex plugin marketplace add lpp12138/deepseek-harness-for-codex --ref codex/desktop-attach
codex plugin add deepseek-harness@deepseek-harness-desktop
```

在 DSH 官方“插件 → 添加插件”中安装本仓库 `dsh-execution-bridge` 的绝对本地目录并启用。它作为可信代码在共享 Host 内运行，安装前需要用户明确批准。只新增自己的 bundle、依赖及组件；旧配置和其他插件保留。链接安装需要保留该源码目录。安装或更新 Codex 插件后新开 Codex 任务加载工具；旧的上游插件应保持停用，避免同名 MCP 重复加载。

## 连接授权

由用户自行保存正常终端启动 Desktop 时显示的授权地址，转换成一行 loopback `/connect?token=...` URL，放入权限为 `0600` 的本地文件。用户明确批准文件路径和对指定 loopback Host 的连接后，才调用 `connect_desktop`。不要把真实 URL/token 放入聊天、命令参数、Git 或 Codex 配置。

插件仅通过指定文件读取地址，以 `interactions=none` 交换内存 Cookie，保持 `/api/remote.mux` WebSocket。不搜索私有 IPC、日志、环境、凭据、会话目录、数据库或浏览器存储以发现 token；不保存或返回 Cookie。连接失效时请用户正常保存新的地址，不自动提取。

## 每个 agent 的权限

MCP 名称是 `deepseek-harness`。每次 `inspect_access_scope` / `start_run` 都带本次请求范围：

```json
{
  "workspace": "/absolute/project",
  "accessScope": {
    "readRoots": ["/absolute/project", "/absolute/reference"],
    "writeRoots": ["/absolute/project"]
  }
}
```

路径只是请求，不是授权。Codex 必须在工具调用传输层 `_meta` 提供 `threadId`、`sessionId`、完整 `codex/sandbox-state`（兼容旧别名）和 `codex/sandbox-launcher.codexExecutable`。模型参数中的 `_meta`、MCP roots、cwd 和全局 `DSH_MCP_WORKSPACE_ROOTS` 均不能授予权限。

宿主策略原样传给宿主提供的绝对 Codex launcher：`codex sandbox --sandbox-state-json`。不拆解重建权限列表，不丢弃未知字段，不经 PATH 猜 launcher，也没有不受约束的回退。当前只支持 `managed/restricted` 文件系统策略，其他形式拒绝。

首版只开放 `codex_read`、`codex_write`、`codex_list`。路径解析、读取、列表和原子写入都发生在原生沙箱子进程中，请求范围进一步收窄访问。读写上限为 64 KiB，列表最多 100 项。shell、PTC、终端、子智能体、插件管理和其他工具全部拒绝。模型工具不能改写执行插件自身或 DSH 配置。Electron 的 Node 模式只保留官方必要运行标志，不继承 Host 凭据环境。

会话绑定调用者、完整策略与 canonical 范围。每次观察、取消、续接重新检查原路径的 realpath；不同调用者不能控制旧会话，策略变化会取消并永久撤销旧绑定。不能通过旧 metadata 恢复它；新范围使用新会话。未绑定的历史、外来或空白会话不能自动收养。

## 调用顺序

1. `doctor`，在已有明确授权时 `connect_desktop`。
2. `inspect_access_scope`。只有原生 Host 预检返回 `canDispatch:true` 才能继续；缺少可信 metadata、launcher、执行插件或受支持策略时拒绝。
3. 用户已授权模型工作及相关费用后，`start_run` 发送一次任务。新会话可用 `maxOutputTokens`（32–8192）限制输出，不改变默认模型。桥接会话使用确定性标题并挂到正常工作区，避免额外的自动标题模型调用。不要为失败或不确定提交自动重发任务。
4. 显示 [打开 Desktop](dsh://open) 和 sessionId。此链接只聚焦应用，用户在列表选择会话；去除 token 的 HTTP origin 不是已认证会话深链。
5. 用 `wait_run` / `get_run` 观察；至少每 30 秒观察一次以续期 90 秒执行租约。无人续期时 Host 取消自有 turn，阻止孤立任务继续执行工具。
6. `cancel_run` 取消当前 turn。完成或取消后，同一调用者及同一策略可向 `start_run` 传相同 sessionId 续接。人工审批仍在 GUI，不由插件代答。
7. 独立检查实际文件变化。DSH 不具备 shell/测试命令工具时，由原 Codex 调用者在自己的权限范围内验证。

MCP 重启保留 run/session/requestId 和范围指纹，Host 仍存活且调用者相同时可继续。Host 重启会失去内存绑定；当前版本需要新建 scoped session，不自动采用旧会话。`stop_service` / MCP 关闭只断开本客户端，不停止 Desktop；自有任务仍受租约控制。

`read_session`、`get_run_events`、`get_run_control` 仅观察绑定会话。`list_models` 不提交生成。`select_model` 仅在用户明确要求时使用，它会影响 Desktop 的新会话默认模型。

## 模式、存储和回滚

默认 `desktop-attach`。显式旧 `managed-web` 保留上游固定 runtime 和原有全局目录配置，不能用于绕过 attach 的认证或权限拒绝。

插件的持久元数据目录采用 `DSH_MCP_DATA_DIR`、Codex `PLUGIN_DATA` 或 `~/.deep-seek-harness-mcp`，不写入提示词、结果、原始策略、token 或 Cookie。绑定策略只留在 Host 内存。元数据中的会话锁不约束用户在 GUI 的独立操作。

回滚时在 DSH 官方插件管理器关闭或卸载 `@lpp12138/dsh-codex-policy-bridge`；它会先停止并清理自己的 agents，再移除保护。保留 manifest 备份用于差异核对，不覆盖用户后续新增配置。Codex 旧版缓存可保留，但不要启用两个同名 MCP。不要修改 Codex 数据库。

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

原生 Mac 测试只访问自建 canary，需要本机 Codex launcher；其他环境可运行合成测试。构建输出包括自包含 MCP bundle 和小型 Host bundle。见[协议说明](docs/desktop-protocol.md)。
