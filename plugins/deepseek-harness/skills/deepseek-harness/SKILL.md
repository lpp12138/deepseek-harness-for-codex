---
name: deepseek-harness
description: Delegate a scoped file task to an explicitly authorized existing DSH Desktop using the caller's native Codex sandbox; observe, cancel and continue its bound session. Use when the user asks to use DeepSeek Harness.
---

# Desktop delegation with native caller policy

1. Call doctor. Default is desktop-attach. Connect only through a file the human explicitly provided and approved. Never discover tokens from private IPC, logs, environment, credentials, sessions, databases or browser storage. Never put token/Cookie in chat or arguments. Reuse existing authorization; do not ask again unless it expired or scope changed.
2. Propose this call's workspace and accessScope.readRoots/writeRoots, then call inspect_access_scope. Paths, cwd, MCP roots and global env roots are not permission grants. Codex must supply caller identity, intact sandbox state and verified launcher in transport _meta; never fabricate or put them in tool arguments. Missing/unsupported policy or native bridge must refuse.
3. Only dispatch if canDispatch=true and the user has authorized model work/cost. Do not switch mode or tools to evade a refusal. The native bridge supports only codex_read, codex_write and codex_list, bounded at 64 KiB/100 entries. Shell/PTC/terminal/subagents and all other tools are refused. Runtime/configuration writes are protected. Have the original Codex caller run verification commands in its own sandbox.
4. Call start_run once. New sessions may set maxOutputTokens to bound output without changing the Desktop default. Show dsh://open and sessionId; this native link focuses the app, not a session. Never invent a session deep link or treat token-free origin as an authenticated page.
5. Observe at least every 30 seconds using wait_run/get_run to renew the 90-second lease. Human approvals remain in Desktop GUI; never answer them. cancel_run cancels only the current turn. Continue a completed/cancelled session with the same sessionId only under the same caller, intact policy and canonical scope.
6. Different caller, changed policy, changed directory identity/scope, revoked binding or unbound legacy session cannot be adopted. A policy change cancels/revokes old work. Lost prompt acknowledgement must be observed, never replayed automatically. MCP restart retains identifiers; Host restart currently requires a new scoped session.
7. Inspect actual changes independently. No report of end-to-end success without real acceptance. Synthetic metadata checks are not proof of live Codex host metadata delivery.

MCP shutdown/stop_service disconnects this peer; its work remains lease-bounded. select_model requires explicit user request because it changes the new-session default. No Pi extension, automatic approvals, full access, app patch or new DSH service.
