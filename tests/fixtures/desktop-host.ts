import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/** Synthetic 0.2.1-rc.2 contract. Never connects to an installed Desktop or model. */
export async function desktopHost() {
  const requests: { path: string; body: any; cookie?: string; authorization?: string }[] = [];
  const connections: URL[] = [];
  const sessions = new Map<string, { cwd: string; running: boolean; events: any[] }>();
  const workspaces = new Map<string, string>();
  const peers = new Set<string>();
  const sockets = new Set<WebSocket>();
  let authFailure = false;
  let losePromptResponse = false;
  let permission = "workspace-write";
  const streams = new Map<WebSocket, Map<string, { endpoint: string; args: any }>>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/connect") {
      connections.push(url);
      if (authFailure || url.searchParams.get("token") !== "synthetic-test-secret") {
        res.writeHead(401); res.end("not authorized"); return;
      }
      const cookie = `synthetic_peer=${randomUUID()}`;
      peers.add(cookie);
      res.writeHead(302, { location: "./api/remote.mux", "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end(); return;
    }
    if (!peers.has(req.headers.cookie ?? "")) { res.writeHead(401); res.end(); return; }
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw);
    requests.push({ path: url.pathname, body, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}), ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) });
    const { method, payload, rpcId } = body;
    const request = payload.args.request ?? payload.args._request;
    let value: any = {};
    if (method === "workspace/create") {
      const workspaceId = `workspace-${request.path}`;
      workspaces.set(workspaceId, request.path);
      value = { workspace: { workspaceId, path: request.path }, created: true };
    }
    else if (method === "session/create") {
      const sessionId = `synthetic-${sessions.size + 1}`;
      sessions.set(sessionId, { cwd: request.cwd ?? workspaces.get(request.workspaceId), running: false, events: [] });
      value = { sessionId };
    } else if (method === "session/list") value = { items: [...sessions].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, running: s.running, blank: s.events.length === 0, projections: { asOfSeq: s.events.length - 1, values: { permissions: { currentValue: permission } } } })) };
    else if (method === "session/page") {
      const s = sessions.get(request.address.sessionId)!;
      const end = Math.min((request.beforeSeq ?? request.throughSeq + 1), request.throughSeq + 1);
      const begin = Math.max(0, end - (request.maxMessages ?? 50));
      value = { records: s.events.slice(begin, end).map(event => ({ type: "event", event })), hasMore: begin > 0 };
    } else if (method === "session/prompt") {
      if (!request.requestId) throw new Error("fixture requires a requestId");
      const s = sessions.get(request.sessionId)!;
      s.running = true;
      append(request.sessionId, "turn/start", {});
      append(request.sessionId, "user/message", { message: { source: { kind: "user", rpcId: request.requestId }, content: request.content } });
      if (!request.content[0].text.includes("keep running")) {
        setTimeout(() => complete(request.sessionId, request.content[0].text), 15);
      }
      if (losePromptResponse) { req.socket.destroy(); return; }
      value = { accepted: true };
    } else if (method === "session/cancel") {
      sessions.get(request.sessionId)!.running = false;
      append(request.sessionId, "turn/end", { reason: "cancelled" });
      value = { accepted: true };
    } else if (method === "session/modelCatalog") value = { default: { provider: "synthetic", model: "test-model" }, groups: [], failures: [], routableProviders: ["synthetic"] };
    else if (method === "session/selectModel") value = { selected: { provider: request.provider, model: request.model } };
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }));
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/api/remote.mux" || !peers.has(req.headers.cookie ?? "")) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws); streams.set(ws, new Map());
      ws.on("close", () => { peers.delete(req.headers.cookie ?? ""); sockets.delete(ws); streams.delete(ws); });
      ws.on("message", raw => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "cancel") { streams.get(ws)?.delete(frame.streamId); return; }
        if (frame.type !== "open") return;
        streams.get(ws)!.set(frame.streamId, { endpoint: frame.endpoint, args: frame.payload.args });
        let value: any;
        if (frame.endpoint === "session/control") value = { type: "baseline", value: { projections: {} } };
        else if (frame.endpoint === "session/follow") {
          const s = sessions.get(frame.payload.args.request.address.sessionId)!;
          value = { type: "snapshot", cursor: s.events.length - 1, records: s.events.map(event => ({ type: "event", event })), hasMore: false };
        } else { ws.send(JSON.stringify({ type: "error", streamId: frame.streamId, error: { code: "unknown", message: "not supported", details: {} } })); return; }
        ws.send(JSON.stringify({ type: "item", streamId: frame.streamId, value }));
      });
    });
  });
  function append(id: string, type: string, data: any) {
    const s = sessions.get(id)!;
    const event = { type, seq: s.events.length, data };
    s.events.push(event);
    for (const [ws, active] of streams) for (const [streamId, stream] of active) {
      if (stream.endpoint === "session/follow" && stream.args.request.address.sessionId === id) ws.send(JSON.stringify({ type: "item", streamId, value: { type: "event", event } }));
    }
  }
  function complete(id: string, text: string) {
    const s = sessions.get(id)!;
    if (!s.running) return;
    append(id, "assistant/message", { message: { content: [{ type: "text", text: `completed:${text}` }] } });
    append(id, "turn/end", { reason: "stop" });
    s.running = false;
  }
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, connectUrl: `${origin}/connect?token=synthetic-test-secret`, requests, connections, sessions, complete,
    rejectAuthentication: () => { authFailure = true; },
    setPermission: (value: string) => { permission = value; },
    dropPromptAcknowledgement: () => { losePromptResponse = true; },
    disconnect: () => { for (const ws of sockets) ws.close(); },
    close: async () => { for (const ws of sockets) ws.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); wss.close(); },
  };
}
