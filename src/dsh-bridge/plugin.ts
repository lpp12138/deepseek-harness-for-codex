import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Service, type Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { DesktopScopePolicy, callerIdentity, type CallerMetadata, type CallerScopeBinding, type ScopeInput } from "../access-scope.js";
import { nativeAuthority, nativeFileOperation, type NativeAuthority, type FileOperation } from "./native.js";

export const PRESET = "codex-native-files";
const TOOLS = new Set(["codex_read", "codex_write", "codex_list"]);
const LEASE_MS = 90_000;
type Host = any; // Runtime SDK services are supplied by the installed DSH composition.
interface Envelope { input: ScopeInput; metadata: CallerMetadata; sessionId?: string }
interface Entry { revoked?: boolean; metadata: CallerMetadata; binding: CallerScopeBinding; authority: NativeAuthority; agent: Host; handle?: Host; expires: number; timer?: NodeJS.Timeout }

/** Host plugin: existing owner-authenticated Gateway, no listener or new credential. */
export class CodexPolicyBridge extends TypertRemoteService {
  static inject = ["typert", "tools", "agents", "agentPresets", "agentDefaultModel", "workspaceRegistry", "sessionTitle"];
  private readonly entries = new Map<string, Entry>();
  private readonly policy = new DesktopScopePolicy();
  private stopping = false;
  private lastDiagnostic: object | null = null;
  private protectedRoots: string[] = [];
  constructor(ctx: Context) {
    super(ctx, "codexBridge");
    // Invoke the public standard-decorator API explicitly; Node does not yet parse decorators.
    for (const method of ["status", "preflight", "create", "verify", "checkOperation"] as const) {
      const receiver = this;
      Remote(this[method] as any, { kind: "method", name: method, static: false, private: false, access: { has: (value: object) => method in value, get: (value: any) => value[method] }, addInitializer(initializer: (this: object) => void) { initializer.call(receiver); }, metadata: {} } as any);
    }
  }
  async *[Service.init]() {
    this.protectedRoots = await Promise.all([fileURLToPath(new URL("../", import.meta.url)), join(homedir(), ".dsh")].map(path => realpath(path)));
    const host = this.ctx as Host;
    const unregisterPreset = await host.agentPresets.register({ id: PRESET, name: "Codex native files", description: "Caller-bound Codex sandbox; adapted file tools only", order: 900, plugins: [] });
    // Root-owned protection survives this plugin's automatic effect disposal until our handles drain.
    const removeGuard = host.root.tools.guard((exec: Host) => {
      if (!exec.agent || (exec.agent.session.header.agentPreset !== PRESET && !this.entries.has(exec.agent.id))) return;
      const entry = this.entries.get(exec.agent.id);
      if (this.stopping || !entry || entry.agent !== exec.agent || entry.expires <= Date.now()) return "Codex caller binding missing or expired; no tool may execute.";
      if (!TOOLS.has(exec.name)) return "Tool is not adapted to the caller's Codex sandbox and is refused.";
    });
    yield async () => {
      this.stopping = true;
      for (const entry of this.entries.values()) { if (entry.timer) clearTimeout(entry.timer); entry.agent.cancel({ kind: "user" }); }
      // Do not remove protection if a handle cannot be drained.
      await Promise.all([...this.entries.values()].map(entry => entry.handle?.dispose()));
      this.entries.clear(); await unregisterPreset(); removeGuard();
    };
  }
  status() { return { bridgeVersion: "0.1.0", preset: PRESET, tools: [...TOOLS], enforcement: "native-codex", supported: "managed/restricted filesystem policy; adapted file operations only", leaseMs: LEASE_MS, workerRuntime: { nodeVersion: process.versions.node, electronNodeMode: Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1") }, lastDiagnostic: this.lastDiagnostic }; }
  async preflight(request: Envelope) {
    try {
    if (this.stopping) throw new Error("Bridge is stopping.");
    const binding = await this.policy.prepare(request.input, request.metadata);
    const authority = await nativeAuthority(request.metadata);
    await nativeFileOperation(authority, binding, { kind: "ping" });
    return { canDispatch: true, bridgeVersion: "0.1.0", desktopPolicyEnforcement: "native-codex-files", callerContextReceived: true, globalRootsAreAuthority: false, requestedScope: binding.canonical, supportedTools: [...TOOLS], unsupportedTools: "all others, including shell, PTC and subagents" };
    } catch (error) { throw this.diagnostic("preflight", error); }
  }
  async create(request: Envelope) {
    await this.preflight(request);
    const binding = await this.policy.prepare(request.input, request.metadata);
    const authority = await nativeAuthority(request.metadata);
    const host = this.ctx as Host;
    const maxTokens = (request.input as ScopeInput & { maxOutputTokens?: number }).maxOutputTokens;
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens > 8192)) throw new Error("Invalid per-session output-token cap.");
    const sessionId = randomUUID();
    let entry: Entry | undefined;
    let stage = "agent-factory";
    try {
      const handle = await host.agents.create({
        sessionId,
        meta: { cwd: binding.canonical.workspace, agentPreset: PRESET },
        agentOptions: { ...host.agentDefaultModel.currentSelection(), ...(maxTokens === undefined ? {} : { maxTokens }) },
        setup: async (agentCtx: Host, agent: Host) => {
          stage = "preset-mount";
          await host.agentPresets.mount(agentCtx, PRESET);
          stage = "tool-registration";
          agentCtx.tools.restrict({ allow: [] });
          agentCtx.tools.presentAs("native");
          entry = { metadata: request.metadata, binding, authority, agent, expires: 0 };
          this.entries.set(sessionId, entry); this.renew(entry);
          this.registerFiles(agentCtx, entry);
        },
      });
      entry!.handle = handle;
      // Publish into the ordinary GUI workspace and pin a deterministic title before
      // any prompt can trigger the Host's separate automatic title-model request.
      stage = "gui-publication";
      host.sessionTitle.rename(handle.agent.session, `Codex task ${sessionId.slice(0, 8)}`);
      const workspace = await host.workspaceRegistry.create(binding.canonical.workspace);
      await workspace.attachSession(sessionId);
      return { sessionId, preset: PRESET, enforcement: "native-codex-files", supportedTools: [...TOOLS] };
    } catch (error) { if (entry?.timer) clearTimeout(entry.timer); await entry?.handle?.dispose(); this.entries.delete(sessionId); throw this.diagnostic(stage, error); }
  }
  async verify(request: Envelope) {
    const entry = this.entries.get(request.sessionId ?? "");
    if (!entry) throw new Error("No live caller binding for this session. Host restart recovery requires a new scoped session; no automatic adoption.");
    if (entry.revoked) throw new Error("Caller binding was revoked; use a new scoped session.");
    const incoming = callerIdentity(request.metadata);
    if (incoming.callerFingerprint !== entry.binding.callerFingerprint) throw new Error("Session belongs to another caller.");
    if (incoming.policyFingerprint !== entry.binding.policyFingerprint) {
      entry.revoked = true; entry.expires = 0; entry.agent.cancel({ kind: "user" });
      throw new Error("Caller policy changed; old task cancelled. Use a new scoped session.");
    }
    try { await this.policy.verifyStored(entry.binding, request.metadata); }
    catch (error) { entry.revoked = true; entry.expires = 0; entry.agent.cancel({ kind: "user" }); throw error; }
    const proposed = await this.policy.prepare(request.input, request.metadata);
    if (proposed.scopeFingerprint !== entry.binding.scopeFingerprint) throw new Error("Directory scope changed; use a new scoped session.");
    const authority = await nativeAuthority(request.metadata);
    if (authority.launcher !== entry.authority.launcher) { entry.revoked = true; entry.expires = 0; entry.agent.cancel({ kind: "user" }); throw new Error("Caller sandbox launcher changed; use a new scoped session."); }
    this.renew(entry);
    return { verified: true, sessionId: request.sessionId, enforcement: "native-codex-files" };
  }
  /** Explicit owner diagnostic through the same tool pipeline; no model or arbitrary code. */
  async checkOperation(request: Envelope & { operation: FileOperation }) {
    await this.verify(request);
    const entry = this.entries.get(request.sessionId!)!;
    if (entry.agent.status === "running") throw new Error("Cannot run a diagnostic during a model turn.");
    const operation = request.operation;
    const name = operation.kind === "read" ? "codex_read" : operation.kind === "write" ? "codex_write" : operation.kind === "list" ? "codex_list" : "unsupported_probe";
    const args = operation.kind === "ping" ? {} : { path: operation.path, ...(operation.kind === "write" ? { text: operation.text } : {}) };
    const result = await entry.agent.ctx.tools.execute({ callId: randomUUID(), name, arguments: args, agent: entry.agent, signal: new AbortController().signal });
    return { isError: result.isError === true, content: result.content, visibleTools: entry.agent.ctx.tools.schemas(entry.agent).map((tool: { name: string }) => tool.name) };
  }
  private diagnostic(stage: string, error: unknown) {
    const value = error as { name?: string; code?: string; stack?: string };
    const frames = String(value?.stack ?? "").split("\n").slice(1, 9).map(line => line.match(/^\s*at ([\w.$<> ]+?)(?: \(|$)/)?.[1]).filter(Boolean);
    this.lastDiagnostic = { stage, name: /^[\w]+$/.test(value?.name ?? "") ? value.name : "Error", code: /^[A-Z_0-9]+$/.test(value?.code ?? "") ? value.code : null, frames };
    return new (RemoteError as any)("codex-bridge/" + stage, "Scoped execution bridge failed; inspect its bounded status diagnostic.", {});
  }
  private renew(entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.expires = Date.now() + LEASE_MS;
    entry.timer = setTimeout(() => { entry.expires = 0; entry.agent.cancel({ kind: "user" }); }, LEASE_MS); entry.timer.unref();
  }
  private registerFiles(ctx: Host, entry: Entry) {
    for (const [name, kind, description] of [["codex_read", "read", "Read up to 64 KiB of a UTF-8 file under this caller's native Codex sandbox and requested read bounds."], ["codex_write", "write", "Atomically write up to 64 KiB under this caller's native Codex sandbox and requested write bounds."], ["codex_list", "list", "List up to 100 entries under this caller's native Codex sandbox and requested read bounds."]] as const) {
      ctx.tools.register(defineTool({
        name, description,
        parameters: { path: { type: "string", required: true, description: "File/directory path relative to this session workspace, or absolute." }, ...(kind === "write" ? { text: { type: "string" as const, required: true, description: "Exact file contents." } } : {}) },
        output: { schema: { type: "json" }, render: (_args: unknown, value: unknown) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] },
        execute: async (args: any, exec: Host) => {
          if (this.stopping || entry.expires <= Date.now() || this.entries.get(entry.agent.id) !== entry) throw new Error("Caller binding expired.");
          await this.policy.verifyStored(entry.binding, entry.metadata);
          return await nativeFileOperation(entry.authority, entry.binding, { kind, path: args.path, ...(kind === "write" ? { text: args.text } : {}) } as FileOperation, exec.signal, this.protectedRoots) as any;
        },
      }));
    }
  }
}
export default CodexPolicyBridge;
