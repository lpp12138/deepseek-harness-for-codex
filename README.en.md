# DeepSeek Harness for Codex — Desktop Attach

Personal MIT-licensed fork of [Seann0824/deepseek-harness-for-codex](https://github.com/Seann0824/deepseek-harness-for-codex), version `0.4.0-desktop.2`. Connects to an existing, human-authorized Desktop **0.2.1-rc.2** Host. Real passive authentication, WebSocket and model-catalog access were verified with explicit human approval. No real model task was submitted. No npm release or Desktop modification.

Requires Node >=22 and plugin-capable Codex. The tracked bundle is self-contained.

```sh
codex plugin marketplace add lpp12138/deepseek-harness-for-codex --ref codex/desktop-attach
codex plugin add deepseek-harness@deepseek-harness-desktop
```

Open a new Codex task to load updated tools. Keep any upstream copy disabled to avoid duplicate MCP names.

## Per-call directory scope: dispatch currently blocked

Different agents submit different `accessScope:{readRoots:[...],writeRoots:[...]}` alongside `workspace`. These are proposals, never grants. The server opts into `codex/sandbox-state` and its deprecated `codex/sandbox-state-meta` alias. Only transport `_meta` supplies the host's threadId, sessionId and opaque sandbox policy. Model arguments, MCP roots, cwd and global `DSH_MCP_WORKSPACE_ROOTS` cannot establish authority. Unknown opaque policy fields are preserved in the policy fingerprint; the plugin does not flatten or reconstruct permission profiles.

`inspect_access_scope` validates existing absolute directories and canonical symlink targets without contacting Desktop. Missing trusted metadata fails closed. With metadata, it still reports `canDispatch:false` and `desktopPolicyEnforcement:"unavailable"`. `start_run` rejects **before workspace/session creation or prompt submission**.

Desktop 0.2.1-rc.2 session/create accepts cwd/workspace, not the caller's opaque policy or separate read/write roots. Its filesystem workspace-write fence covers writes to cwd plus temporary directories; its reads do not enforce Codex read bounds. Sandboxing an MCP peer does not sandbox an already-running Desktop Host. Full dispatch needs a DSH execution-side policy bridge, which is outside this plugin change. Neither a prompt nor a managed-web fallback substitutes for enforcement.

Run metadata binds caller identity, opaque-policy fingerprint and canonical scope. Read/cancel/continuation check the binding and re-resolve original paths; another caller, changed policy/scope, symlink target drift or an unbound legacy session is rejected. Synthetic fixtures verify lifecycle behavior; production dispatch remains closed. Live Codex metadata delivery must still be checked in a new task. Synthetic transport delivery passed.

## Explicit connection authorization

The user may obtain the startup URL from their own terminal when normally launching Desktop and privately save one authorized loopback `/connect?token=...` URL in a `0600` text file. No GUI external-client export entry was identified. Only call `connect_desktop` after the human explicitly supplies and approves that file path and the loopback exchange. Never put real tokens in chat, command arguments, Git or Codex configuration.

The plugin uses `interactions=none`, a memory-only owner API Cookie and persistent `/api/remote.mux` WebSocket. It does not discover credentials from IPC, logs, environment, session directories, databases or browser storage, start another service, change models, or answer approvals. Reconnection is explicit.

`doctor` reports prerequisites and the missing execution bridge. `list_models` queries the configured catalog without generation. `stop_service` disconnects only this peer; Desktop and its tasks remain alive. `dsh://open` focuses Desktop only; show sessionId separately and never invent a session link. Existing completion/cancel/follow-up code is synthetic-tested only. Model selection requires explicit user request and affects Desktop's new-session default.

Default mode is `desktop-attach`. Legacy `managed-web` is explicit and retains upstream @deepseek-ai/dsh@0.1.0-rc.6 and its global root configuration; never switch to it to evade a policy or authentication failure. No Pi extension is included.

Metadata defaults to Codex PLUGIN_DATA or ~/.deep-seek-harness-mcp; no prompts, results, token, Cookie or raw opaque policy are persisted. Build/tests use synthetic local Hosts only:

```sh
npm ci --ignore-scripts
npm run check
```

See [Chinese documentation](README.md) and [protocol notes](docs/desktop-protocol.md).
