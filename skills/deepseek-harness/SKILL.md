---
name: deepseek-harness
description: Inspect per-call directory scope and explicitly authorized passive connection to an existing DeepSeek Harness Desktop. Dispatch remains blocked until Desktop can enforce the caller policy. Use when the user asks to use DeepSeek Harness.
---

# DeepSeek Harness Desktop Attach

1. Call `doctor`. Default is desktop-attach; never fall back to managed-web to bypass missing authority or execution enforcement. No extra model API key is needed merely to attach.
2. Each agent/task proposes its own absolute `workspace` and `accessScope:{readRoots,writeRoots}`. Call `inspect_access_scope` first. Paths are requests, not grants. Codex must attach current thread/session identity and opaque sandbox state in transport `_meta`; do not invent or put those fields in tool arguments. MCP roots, cwd and global env roots are not authority. Missing context must fail closed.
3. Current Desktop 0.2.1-rc.2 lacks an execution-side interface for this policy. `canDispatch` is false even with trusted metadata; explain this precise blocker and stop task dispatch. Do not bypass it using prompts, shell, another mode or another tool. Do not claim directory restrictions have reached DSH. Live Codex metadata delivery still requires a new-task preflight; synthetic transport tests alone do not prove it.
4. Authentication is separate. Only call `connect_desktop` after the human explicitly supplies a private connection-file path and approves reading it and sending its authorized URL to the named loopback /connect endpoint. The human may privately save the URL printed by their own normal Desktop launch. Never discover tokens from private IPC, logs, environment, credentials, session directories, databases or browser storage. Never put tokens in chat or tool arguments.
5. Connection and `list_models` do not submit generation. Approval to connect is not approval for a paid model task. Keep human approvals in Desktop; never enable full access or answer them automatically.
6. Lifecycle code is synthetic-tested only while production dispatch is blocked. Future use after a native bridge must bind the session to the same caller, opaque policy and canonical requested scope. Different agent, policy, directory bounds or realpath identity requires a fresh session; never adopt a legacy/foreign/blank session automatically. Unknown submission outcome must never be replayed.
7. Show [Open Desktop](dsh://open) and sessionId when applicable. The native URL only focuses the app, not a session. Never invent session deep links or treat token-free Host origin as an authenticated page. Focus the GUI only on user request.
8. `stop_service` and MCP shutdown disconnect only this peer, leaving Desktop and its tasks alive. `cancel_run` is separately scoped. `select_model` requires explicit user request and changes Desktop's new-session default. Independently verify any future task's actual file changes.

Do not modify Desktop or implement a Pi extension as part of using this plugin.
