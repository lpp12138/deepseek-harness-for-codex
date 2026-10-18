---
name: deepseek-harness
description: Delegate a scoped task to the user's existing authorized DeepSeek Harness Desktop, keep human approvals in its GUI, observe and continue the same session, then independently verify results. Use when the user asks to use DeepSeek Harness.
---

# DeepSeek Harness Desktop Attach

1. Call `doctor`. Default mode is `desktop-attach`; no failure permits a managed Web fallback. Explain exact missing connection or workspace roots. Do not ask for another model API key just to attach.
2. Authentication is a separate permission. Only call `connect_desktop` after the human explicitly supplies a connection-file path and approves reading that file and sending its authorized URL to the named loopback `/connect` endpoint. Do not put the URL/token in chat or tool arguments. Never discover it from private IPC, logs, ambient environment, credentials, session directories, databases or browser storage. No public Desktop export entry has been identified; report this limitation if the user cannot provide an authorized URL.
3. Inspect only the authorized project. Write a complete scoped task with repository instructions and acceptance checks. Use an existing absolute directory within `DSH_MCP_WORKSPACE_ROOTS`. Never pass credentials in the task.
4. For independent work omit sessionId. For a direct follow-up to a completed attempt, pass its sessionId. Do not control a running session concurrently. An explicitly selected blank session is allowed in the same workspace. Session cwd must match the selected workspace.
5. Call `start_run` once with `openBrowser:false`. The session must have `workspace-write` selected in Desktop. If it does not, show the returned sessionId and have the user choose that existing GUI permission before continuing. Never enable full access or automatic approvals.
6. Show the native [Open Desktop](dsh://open) link and exact sessionId. This link focuses the app only; the user selects that session in Desktop. Do not invent a session deep link or treat the returned token-free HTTP origin as an authenticated Web page. Use `open_service` only if the user asks to focus the app.
7. Use `get_run` / `wait_run` (at most 30 seconds) to observe the same session. `read_session` is cold-safe history/status; `get_run_events` reads bounded follow frames and can materialize the delegated session; `get_run_control` returns its projection. Human approvals stay in Desktop; this client never answers them.
8. If submission is `uncertain`, keep the runId/requestId and read that existing run. Never automatically resubmit or create a paid replacement. MCP restarts recover identifiers, not authentication; reconnect explicitly before reading the existing session.
9. Inspect actual changed files and independently run appropriate checks. Continue the completed session for a concrete correction if useful, then verify again.
10. `cancel_run` cancels the current turn and retains the session/Host. In attach mode, `stop_service` or MCP shutdown disconnects only this client's Peer and does not cancel or stop Desktop. Do not promise that an MCP disconnect cancels work.

`list_models` uses the Host's configured catalog and may refresh provider metadata. Use `select_model` only when the user explicitly requests it: Desktop also saves that choice as its default for new sessions. Attachment itself does not change models or copy credentials.

`managed-web` remains an explicit legacy mode selected by configuration. Do not switch modes to evade a missing Desktop credential or incompatible contract. This fork does not implement a Pi extension.
