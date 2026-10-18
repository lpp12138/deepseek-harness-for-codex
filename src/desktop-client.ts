import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import WebSocket from "ws";

export const DESKTOP_GUI_URL = "dsh://open";
const RECONNECT = "Desktop is not connected. Use connect_desktop with a connection file explicitly supplied and approved by the user.";
const METHODS = new Set(["workspace/create", "session/create", "session/prompt", "session/cancel", "session/list", "session/page", "session/projections", "session/modelCatalog", "session/selectModel"]);
const STREAMS = new Set(["session/follow", "session/control"]);

/** Accept a user-provided local launch URL; never discover one from Desktop internals. */
export function validateConnectUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("Connection file must contain one authorized loopback /connect URL."); }
  const host = url.hostname;
  if (!["http:", "https:"].includes(url.protocol) || !(host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)) || url.username || url.password || url.hash || url.pathname !== "/connect") {
    throw new Error("Connection URL must name a loopback /connect endpoint without embedded credentials or a fragment.");
  }
  const tokens = url.searchParams.getAll("token");
  const interactions = url.searchParams.getAll("interactions");
  if (tokens.length !== 1 || !tokens[0] || interactions.length > 1 || interactions.some(value => value !== "none") || [...url.searchParams.keys()].some(key => key !== "token" && key !== "interactions")) {
    throw new Error("Connection requires exactly one user-provided token and passive interactions=none. Approval stays in Desktop GUI.");
  }
  url.searchParams.set("interactions", "none");
  return url;
}

export interface DesktopConnectionStatus {
  connected: boolean;
  origin: string | null;
  interactions: "none";
  guiUrl: string;
}

interface Inbox {
  values: unknown[];
  wake: (() => void) | undefined;
  ended: boolean;
  error: Error | undefined;
}

/** Cookie and API Peer lifetime are memory-only and owned by one authenticated mux. */
export class DesktopClient {
  private origin: string | null = null;
  private cookie: string | null = null;
  private socket: WebSocket | undefined;
  private readonly streams = new Map<string, Inbox>();
  private connecting = false;

  status(): DesktopConnectionStatus {
    return { connected: this.socket?.readyState === WebSocket.OPEN && this.cookie !== null, origin: this.origin, interactions: "none", guiUrl: DESKTOP_GUI_URL };
  }

  async connectFile(connectionFile: string): Promise<DesktopConnectionStatus> {
    if (this.connecting) throw new Error("A Desktop connection attempt is already in progress.");
    if (!isAbsolute(connectionFile)) throw new Error("connectionFile must be an absolute user-approved file path.");
    this.connecting = true;
    try {
      const info = await stat(connectionFile);
      if (!info.isFile() || info.size > 16_384) throw new Error("Connection file must be a small regular text file.");
      const url = validateConnectUrl(await readFile(connectionFile, "utf8"));
      await this.close();
      let response: Response;
      try { response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) }); }
      catch { throw new Error("Desktop authorization request failed; no alternate service was started."); }
      if (response.status !== 302) throw new Error(`Desktop authorization failed (HTTP ${response.status}). Obtain an authorized connection URL through a supported user-facing entry.`);
      const target = new URL(response.headers.get("location") ?? "", url);
      if (target.origin !== url.origin || target.pathname !== "/api/remote.mux" || target.search || target.hash || target.username || target.password) throw new Error("Desktop returned an unsupported connection destination.");
      const headers = response.headers.getSetCookie();
      const cookies = headers.map(value => value.split(";", 1)[0]!).filter(value => /^[!#$%&'*+.^_`|~\w-]+=[^\s;,]+$/.test(value));
      if (cookies.length !== 1) throw new Error("Desktop did not return one API authentication cookie.");
      this.origin = url.origin;
      this.cookie = cookies[0]!;
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(target, { headers: { Cookie: this.cookie }, handshakeTimeout: 10_000, followRedirects: false, maxPayload: 16 * 1024 * 1024 });
      this.socket = socket;
      socket.on("message", raw => this.message(String(raw)));
      socket.on("error", () => { this.invalidate(socket); });
      socket.on("close", () => { this.invalidate(socket); });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", () => reject(new Error("Desktop API WebSocket could not be opened; reconnect with an authorized file.")));
        socket.once("close", () => reject(new Error("Desktop API WebSocket closed before readiness.")));
      });
      return this.status();
    } catch (error) {
      await this.close();
      throw error;
    } finally { this.connecting = false; }
  }

  async rpc<T = unknown>(method: string, args: Record<string, unknown>): Promise<T> {
    if (!METHODS.has(method)) throw new Error("Unsupported Desktop operation.");
    this.requireConnection();
    const rpcId = randomUUID();
    let response: Response;
    try {
      response = await fetch(`${this.origin}/api/${method}`, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/json", Cookie: this.cookie! },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }), signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new Error(`Desktop ${method} transport failed; its outcome may be uncertain. Do not automatically resend a prompt.`); }
    if (response.status === 401 || response.status === 403) { await this.close(); throw new Error(`Desktop authorization expired (HTTP ${response.status}). ${RECONNECT}`); }
    if (!response.ok) throw new Error(`Desktop ${method} failed (HTTP ${response.status}); no fallback was attempted.`);
    let envelope: any;
    try { envelope = await response.json(); } catch { throw new Error("Desktop returned an invalid RPC response."); }
    if (envelope?.type !== "server-response" || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== "boolean") throw new Error("Desktop RPC response did not match this request.");
    if (!envelope.result.ok) {
      const code = typeof envelope.result.error?.code === "string" && /^[\w/.-]{1,120}$/.test(envelope.result.error.code) ? envelope.result.error.code : "unknown";
      throw new Error(`Desktop ${method} rejected the operation (${code}). Inspect the corresponding session in Desktop.`);
    }
    return envelope.result.value as T;
  }

  async first<T = unknown>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("Desktop stream did not return its opening frame.")), 10_000);
    try {
      for await (const item of this.stream(endpoint, args, abort.signal)) return item as T;
      throw new Error("Desktop stream ended without an opening frame.");
    } finally { clearTimeout(timer); abort.abort(); }
  }

  async collect(endpoint: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown[]> {
    const abort = new AbortController();
    const frames: unknown[] = [];
    let expired = false;
    const duration = Math.min(30_000, Math.max(0, timeoutMs));
    const timer = setTimeout(() => { expired = true; abort.abort(); }, Math.max(1000, duration));
    try {
      for await (const frame of this.stream(endpoint, args, abort.signal)) {
        frames.push(frame);
        if (duration === 0 || frames.length >= 500) break;
      }
    } catch (error) { if (!expired) throw error; }
    finally { clearTimeout(timer); abort.abort(); }
    return frames;
  }

  async *stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown> {
    if (!STREAMS.has(endpoint)) throw new Error("Unsupported Desktop stream. This client never answers approval events.");
    this.requireConnection(); signal.throwIfAborted();
    const streamId = randomUUID();
    const inbox: Inbox = { values: [], wake: undefined, ended: false, error: undefined };
    const socket = this.socket!;
    const wake = () => { inbox.wake?.(); inbox.wake = undefined; };
    signal.addEventListener("abort", wake);
    this.streams.set(streamId, inbox);
    try {
      socket.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
      while (true) {
        signal.throwIfAborted();
        if (inbox.error) throw inbox.error;
        if (inbox.values.length) { yield inbox.values.shift(); continue; }
        if (inbox.ended) return;
        await new Promise<void>(resolve => { inbox.wake = resolve; });
      }
    } finally {
      signal.removeEventListener("abort", wake); this.streams.delete(streamId);
      if (!inbox.ended && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", streamId }));
    }
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined; this.cookie = null;
    for (const inbox of this.streams.values()) { inbox.error = new Error(RECONNECT); inbox.wake?.(); }
    this.streams.clear();
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate(); else socket.close();
      });
    }
  }

  private requireConnection(): void { if (!this.status().connected) throw new Error(RECONNECT); }
  private invalidate(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined; this.cookie = null;
    for (const inbox of this.streams.values()) { inbox.error = new Error(RECONNECT); inbox.wake?.(); }
    this.streams.clear();
  }
  private message(raw: string): void {
    let frame: any;
    try { frame = JSON.parse(raw); } catch { void this.close(); return; }
    const inbox = this.streams.get(frame?.streamId);
    if (!inbox) return;
    if (frame.type === "item") inbox.values.push(frame.value);
    else if (frame.type === "end") inbox.ended = true;
    else inbox.error = new Error("Desktop stream failed; inspect the session in Desktop.");
    if (inbox.values.length > 2048) inbox.error = new Error("Desktop stream exceeded the bounded client inbox.");
    inbox.wake?.(); inbox.wake = undefined;
  }
}
