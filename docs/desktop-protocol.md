# Desktop 0.2.1-rc.2 protocol baseline

This implementation was compared with public program code and generated contracts inside the installed Desktop 0.2.1-rc.2 package. No business session, credential file content, private IPC value, or database was read. New synthetic sessions are inspected only through the public API. Current upstream master is not the compatibility definition.

## Contracts present in that installation

- `dsh-desktop-host/lib/index.js`: runs the `desktop` profile with `--no-open --host 127.0.0.1 --port 0`; passes its authenticated URL through Node IPC.
- Desktop `lib/main.js`: registers the native `dsh` scheme and handles exactly `dsh://open` (or its trailing-slash form) by focusing the primary window. It forwards the static GUI's HTTP transport to its owned Web Host and supplies that Host's origin for WebSocket streams.
- `dsh-client-connection/README.md` and `lib/index.js`: `GET /connect?token=...&interactions=none|answer` exchanges a process launch token for an independent owner API Peer. Omitted interaction mode defaults to none. Response: 302, `Location: ./api/remote.mux`, signed API Cookie. Authorization-header tokens are not accepted. HTTP and WebSocket must carry the same Cookie; closing its owning socket removes the Peer. The plugin never calls the browser root token exchange or reuses browser Cookies.
- `dsh-api-gateway`: `POST /api/<namespace>/<method>` for unary calls; `/api/remote.mux` for multiplexed logical streams. A stream opens with `{type:'open',streamId,endpoint,payload:{args:...}}`; frames are `item`, `end`, `error`; the client can cancel a stream. The plugin does not open the answering `$events` stream.
- `dsh-api-session-controller/lib/typert.remote-client.js`: the generated request and response shapes below.

```json
{
  "type": "client-request",
  "rpcId": "client-generated-id",
  "method": "session/prompt",
  "payload": {
    "args": {
      "request": {
        "requestId": "durable-prompt-id",
        "sessionId": "session-id",
        "mode": "queue",
        "content": [{"type": "text", "text": "synthetic example"}]
      }
    }
  }
}
```

Responses must be `server-response` with the same rpcId and `result:{ok:true,value:...}` or an error result. A failure message from the Host is not copied into diagnostics, because it may contain user data.

| Method | Named wire arguments / behavior |
| --- | --- |
| `workspace/create` | `request:{path}`; idempotently registers the explicitly authorized project in Desktop |
| `session/create` | `request:{workspaceId}` (or `{cwd}` in the native contract); result includes sessionId |
| `session/prompt` | `request:{requestId,sessionId,mode,content}`; requestId is recorded as user message source.rpcId |
| `session/cancel` | `request:{sessionId}`; cancels one active turn, retains inbox/session |
| `session/list` | `_request:{}`; rows include cwd, running and projection asOfSeq |
| `session/page` | `request:{address:{kind:'session',sessionId},throughSeq,beforeSeq?,maxMessages}`; returns records and hasMore |
| `session/follow` | stream with `request:{address,maxMessages}`; opening snapshot then durable events |
| `session/control` | stream with empty args; complete projection baseline then replacement frames |
| `session/modelCatalog` | empty args; configured routable models |
| `session/selectModel` | `request:{sessionId,provider,model,reasoningEffort?}`; changes session selection and saves the default in the background |

Human approvals travel through the Host's `approval/request` waterfall and its existing answering GUI client. This adapter remains passive. The legacy synthetic path checks the session projection is `workspace-write`. Production attach requires the native per-caller Host bridge described below; it never sets full access or automatically approves a request.

The original managed Web adapter uses dot-separated methods, unwrapped payloads and `session.history`; those are intentionally confined to explicit `managed-web`. There is no attach-to-managed fallback.

## Recovery and remaining acceptance work

A run's identifiers and pre-submit cursor are written before prompt submission. Transport uncertainty is never handled by retrying a prompt. Observation correlates the stored requestId with the durable user message and ends output at that turn's end. Restart recovery loads metadata, reconnects explicitly, verifies current cwd/session identity, then reads the existing session. A new Host port is permitted only through another explicitly approved connection.

The native GUI has a focus link, not a verified external session deep link. Return `dsh://open` plus sessionId, and do not advertise token-free HTTP origin as an authenticated browser session.

The normal terminal launch prints an authentication URL that the human can privately save and explicitly authorize. No GUI export entry was found. Real passive attach and model catalog were verified with human approval. One bounded synthetic prompt was accepted by the Host but failed with HTTP 401 from the existing model. The default Host also attempted automatic title generation. No further prompt was submitted. The bridge now pins a deterministic title before prompts, suppressing that additional call. The human subsequently configured Ollama. Two remaining bounded task submissions verified the exact fixed-string answer, continuation of that completed session and cancellation of its current turn. The native GUI showed both turns, with completed/stopped states. The new session had no automatic title-model request. The cancellation reached the turn before a second model request header was recorded.

## Per-call Codex policy boundary

Official Codex source documents opt-in experimental capability `codex/sandbox-state` (deprecated alias `codex/sandbox-state-meta`). The Host attaches identity plus opaque policy in tool-call transport `_meta`; unknown fields must not be discarded or reconstructed. Launcher metadata is separate and its absence never permits PATH search or an unsandboxed fallback. See [Codex sandbox metadata](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/sandbox_metadata.rs) and [tool dispatch](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs). The installed Codex binary contains this capability; live delivery to this plugin remains to be tested in a new task. Synthetic MCP transport tests cover delivery and rejection of argument-forged metadata.

Standard [MCP roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots) have URI/name, not standardized read/write grants or caller identity. This plugin never uses roots or model-declared paths as authority.

The installed DSH session/create contract has no opaque-policy/readRoots/writeRoots input. `dsh-sandbox-policy/lib/index.js` derives workspaceRoot from session cwd. `dsh-sandbox/lib/index.js` resolves workspace-write roots to that workspace plus /tmp and os.tmpdir(). `dsh-fs-sandbox/lib/index.js` fences writeText/editText but preserves LocalFileSystem reads. Those mechanisms do not implement an arbitrary caller's Codex read/write policy. Restricting this MCP process cannot constrain the already-running Host's tool processes.

The scope layer introduced in 0.4.0-desktop.2 accepts per-call directory proposals, validates realpath/symlinks, recognizes trusted transport identity/policy and binds persisted sessions to their fingerprints. It never persists raw opaque state. Read/cancel/continuation verify that binding, original-path resolution and exact scope on reuse. Unbound legacy/foreign sessions cannot be adopted.

Version 0.5.0-desktop.1 adds the local Host execution bridge. The official bundle patch must use `insert`, not an override, to introduce its component. New sessions are attached through `workspaceRegistry` and receive a deterministic `sessionTitle.rename` before prompting. Native `turn/end` error/aborted reasons are classified explicitly; authentication errors expose a fixed HTTP 401 diagnostic without Host error text. The dedicated empty preset registers only three scoped file tools and masks inherited tools. A monotonic guard also denies unsupported/unbound/expired executions. Every adapted file operation runs under the unchanged native Codex state; requested bounds narrow it further. There is no shell/PTC/subagent implementation. The bridge's own source and DSH configuration cannot be written through these tools.

The installed Host uses Electron's Node runtime and requires ELECTRON_RUN_AS_NODE=1 for subprocess execution, as documented by dsh-desktop-host and Desktop main source. Preserve only this necessary flag rather than inheriting the Host credential environment. Native initialization failure is a refusal, never a reason to fall back. Diagnostics retain stages and bounded function names, not raw launcher stderr or user values.

Binding verification renews a 90-second lease; expiry cancels owned work. A same-caller policy change cancels and permanently revokes the old binding. Old metadata cannot reactivate it. A different caller cannot revoke another caller's work. MCP restart retains metadata while the live Host retains authority; Host restart currently requires a new scoped session. Host plugin teardown drains owned agents before removing the guard.

Real Host tests with controlled synthetic authority verified allowed read/write, read-only write denial, forbidden read/write, symlink denial, unsupported operation refusal, exactly three visible tools, foreign caller refusal, policy change refusal and irrevocable revocation. Automated native tests additionally prove child-process file-policy inheritance and direct loopback network refusal. The separate real Ollama/GUI acceptance confirms completion and same-session follow-up/cancellation under that controlled authority. Neither test proves live Codex _meta delivery from a new ordinary Codex task. No unsupported operation may be opened just to pass a test.
