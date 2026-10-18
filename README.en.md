# DeepSeek Harness for Codex — Desktop Attach

MIT fork of [Seann0824/deepseek-harness-for-codex](https://github.com/Seann0824/deepseek-harness-for-codex). Codex plugin `0.5.0-desktop.1` plus local Host bridge `0.1.0`, targeting installed Desktop **0.2.1-rc.2**. No separate DSH service, app patch, npm release or Pi extension.

Real passive authentication, WebSocket, catalog and twelve filesystem/identity checks passed. 56 automated tests passed. One authorized synthetic prompt reached the real Host, but the existing model returned HTTP 401. Paid retries stopped; real model completion/cancel/follow-up and live Codex metadata delivery remain unverified. Synthetic metadata is not proof of live host delivery.

Install the Codex fork from branch `codex/desktop-attach`, then explicitly approve installing/enabling the absolute `dsh-execution-bridge` directory through DSH's official Plugin Manager. Linked installs need their source directory retained. Disable the old upstream copy and open a new Codex task after updates.

The human privately saves an authorized loopback /connect URL into a 0600 file and explicitly approves its use. `connect_desktop` reads only that file, creates a passive memory-only owner API Peer and never exposes token/Cookie. No token discovery from IPC, logs, environment, credentials, sessions or browser storage. Reconnection after a changed Host URL belongs to the human.

Each call proposes `workspace` and `accessScope:{readRoots,writeRoots}`. Authority comes exclusively from Codex transport `_meta`: threadId, sessionId, intact sandbox state and host-provided absolute sandbox launcher. Model arguments, roots/list, cwd and global env roots are not grants. The intact opaque state is passed to `codex sandbox --sandbox-state-json`; unknown fields remain intact. Only managed/restricted filesystem policies are supported. No launcher PATH lookup or unconfined fallback.

Adapted tools: `codex_read`, `codex_write`, `codex_list`. All file operations, including resolution, occur inside the native child. Requested bounds narrow access further. Reads/writes cap at 64 KiB, listing at 100 entries. Runtime code and DSH configuration are protected from tool writes. Shell, PTC, terminal, subagents, plugin administration and every other tool are denied. Electron Node execution preserves only its required runtime flag; Host credential environment is not inherited.

Call doctor, connect only with existing human authorization, then inspect_access_scope. Dispatch only if canDispatch=true and model work/cost is authorized. A new session may specify maxOutputTokens (32–8192), without changing defaults. Show dsh://open plus sessionId; the link focuses the app only. Observe every <=30 seconds to renew a 90-second execution lease. Cancellation retains the session. Reuse requires the same caller, opaque policy, canonical directory identity and scope. Policy change cancels and permanently revokes the old binding. A revoked binding cannot be restored using old metadata.

MCP restart recovery works while the Host binding and caller identity remain. Host restart currently requires a new scoped session; never automatically adopt legacy/foreign/blank sessions. No prompts, results, raw policy or credentials are persisted by the plugin. MCP shutdown disconnects only its peer; its work remains lease-bounded. Human approvals stay in GUI. Independently verify changes under the original Codex caller's permissions.

Legacy managed-web is explicit and never a workaround for a refusal. To roll back, disable/remove only this local Host bundle with official Plugin Manager. Preserve unrelated profile changes. Do not modify Codex databases.

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

See [Chinese guide](README.md), [Host bridge](dsh-execution-bridge/README.md) and [protocol notes](docs/desktop-protocol.md).
