# Desktop 0.2.1-rc.2 protocol baseline

This implementation was compared with public program code and generated contracts inside the installed Desktop 0.2.1-rc.2 package. No user session, credential content, private IPC value, or database was read. Current upstream master is not the compatibility definition.

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

Human approvals travel through the Host's `approval/request` waterfall and its existing answering GUI client. This adapter remains passive. Before dispatch it verifies the session's projected permission is `workspace-write`; it never sets full access or automatically approves a request.

The original managed Web adapter uses dot-separated methods, unwrapped payloads and `session.history`; those are intentionally confined to explicit `managed-web`. There is no attach-to-managed fallback.

## Recovery and remaining acceptance work

A run's identifiers and pre-submit cursor are written before prompt submission. Transport uncertainty is never handled by retrying a prompt. Observation correlates the stored requestId with the durable user message and ends output at that turn's end. Restart recovery loads metadata, reconnects explicitly, verifies current cwd/session identity, then reads the existing session. A new Host port is permitted only through another explicitly approved connection.

The native GUI has a focus link, not a verified external session deep link. Return `dsh://open` plus sessionId, and do not advertise token-free HTTP origin as an authenticated browser session.

No supported user-facing Desktop launch-token export was identified. Real attach, native GUI synchronization, paid completion, cancellation and follow-up remain unverified until an authorized connection URL is supplied and a bounded real task is approved. Synthetic tests exercise the protocol implementation and failure paths without claiming those acceptance results.
