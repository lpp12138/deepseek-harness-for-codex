# DeepSeek Harness for Codex — Desktop Attach

A personal fork of [Seann0824/deepseek-harness-for-codex](https://github.com/Seann0824/deepseek-harness-for-codex), retaining the MIT license. Version `0.4.0-desktop.1` defaults to attaching to an existing, explicitly authorized DeepSeek Harness Desktop Host. It keeps configured models and human approvals in Desktop. No npm package was published.

The protocol baseline is the installed Desktop **0.2.1-rc.2** contract, not an assumption that current master is compatible. Synthetic tests are not a real model or authentication acceptance test.

## Installation

Requires Node >=22 and a plugin-capable Codex client. The plugin carries a self-contained bundle and does not install another DSH via npx.

```sh
codex plugin marketplace add lpp12138/deepseek-harness-for-codex --ref codex/desktop-attach
codex plugin add deepseek-harness@deepseek-harness-desktop
```

Set `DSH_MCP_WORKSPACE_ROOTS` in the installed MCP configuration to explicitly authorized absolute project roots (platform path delimiter). Without roots, dispatch is disabled. Open a new Codex task after installation. Disable an older upstream plugin if retaining it for rollback, so duplicate MCP names do not load.

## Explicit authorization

The human must obtain a connection URL through a supported entry, save it in a private local text file, provide its path, and approve reading that file and sending its URL to the named loopback `/connect` endpoint. The file contains one line such as `http://127.0.0.1:<current-port>/connect?token=<authorized-launch-token>`. Do not paste real tokens into chat, shell arguments, Git, or Codex configuration. Prefer file permissions `0600`.

Only then call `connect_desktop`. The plugin exchanges the URL for a memory-only API Cookie using `interactions=none` and holds its authenticated `/api/remote.mux` socket. The Cookie has Host owner authority; the plugin additionally restricts workspaces and delegated sessions. It never returns or persists the token or Cookie. Disconnect invalidates its in-memory credential; reconnection is explicit.

**Known limitation:** Desktop passes its startup authentication URL to Electron through private Node IPC. A user-facing export/authorize-external-client entry has not been identified. Installation is not authorization to extract that private URL. Without a legally provided URL, `doctor` reports the missing connection and dispatch stops. The plugin does not inspect private IPC, logs, ambient environment, credential/session directories, databases, or browser storage to discover tokens. It does not forge Cookies, disable authentication, start another Web service, or ask the user to reconfigure models merely to inspect interfaces.

## Workflow

1. Run `doctor`. The default is `desktop-attach`, with no managed fallback.
2. Connect using only a file the human explicitly provided and approved.
3. `start_run` creates a session in the same Host and sends one prompt with a unique persisted requestId. Its effective permission must be `workspace-write`; otherwise select that permission in GUI and continue the returned blank sessionId.
4. Display [Open Desktop](dsh://open) and sessionId. This verified native URL focuses the app **without selecting a session**. Select the session in Desktop. `webUrl` is a token-free Host origin, not a promise that an unauthenticated browser can open the session. Do not invent a session deep link.
5. Use `get_run`/`wait_run`. Human approvals remain in GUI. This client does not subscribe as an answering `$events` client and implements no auto-approval operation.
6. `cancel_run` cancels the current turn and keeps Desktop/session intact. Continue a completed session with the same sessionId. Locks prevent concurrent control by clients sharing this plugin data directory; Host/GUI operations remain Host-owned.
7. After an MCP restart, recover identifiers and reconnect explicitly. A lost prompt acknowledgement is reported as uncertain and never automatically replayed. Independently inspect workspace changes and verify results.

`read_session` reads scoped, cold-safe status/history. `get_run_events` reads bounded follow frames (the Host may materialize that delegated session); `get_run_control` returns only that session's projection. `list_models` reads the configured catalog, which providers may refresh. `select_model` requires an explicit user request: Desktop also saves the selection as its new-session default.

`stop_service` in attach mode disconnects only this client's Peer. MCP shutdown does not stop Desktop or cancel its turns. `open_service` focuses Desktop only on user request.

## Modes and storage

`DSH_MCP_MODE=desktop-attach` is the default. Explicit `managed-web` retains upstream's `@deepseek-ai/dsh@0.1.0-rc.6` runtime and legacy protocol; it is never an automatic recovery path and is not the Desktop 0.2.1 protocol.

`DSH_MCP_DATA_DIR` selects plugin metadata storage (Codex `PLUGIN_DATA` or `~/.deep-seek-harness-mcp` by default). Atomic per-run files in `desktop-runs/` retain identifiers, workspace, cursor, status and native GUI entry, without prompts, results or credentials. Per-session locks live in `desktop-locks/` and recover dead owners.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Tests use synthetic local Hosts, credentials, sessions and models. They never connect to real Desktop or a paid model. Build once into `plugins/deepseek-harness/dist/bin.mjs`; update the tracked self-contained bundle when changing source. See [protocol notes](docs/desktop-protocol.md).
