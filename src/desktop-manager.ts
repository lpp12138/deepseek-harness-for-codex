import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { DesktopClient, DESKTOP_GUI_URL } from "./desktop-client.js";
import { DesktopStore, type DesktopRun } from "./desktop-store.js";
import { resolveDataDirectory } from "./runtime.js";
import { DesktopBridgePolicy } from "./desktop-bridge-policy.js";
import { DesktopScopePolicy, type CallerMetadata } from "./access-scope.js";
import type { RunSnapshot, ServiceSnapshot, StartRunInput, StartServiceInput } from "./types.js";

interface Event { type: string; seq: number; data: any }
interface RecordEntry { type: "event"; event: Event }
interface Summary { sessionId: string; cwd?: string; running: boolean; blank?: boolean; projections?: { asOfSeq: number; values: { permissions?: { currentValue: string } } } }
interface ReadSessionInput { workspace: string; sessionId: string }
export interface SelectModelInput extends ReadSessionInput { provider: string; model: string; reasoningEffort?: string | undefined }
export interface DesktopManagerOptions {
  dataDirectory?: string;
  /** Optional additional test/deployment ceiling, never a permission grant. */
  allowedRoots?: string[];
  scopePolicy?: DesktopScopePolicy;
  pollIntervalMs?: number;
  client?: DesktopClient;
  openBrowser?: (url: string) => Promise<void>;
}

/** Attaches to an existing Host. No branch in this class launches or stops DSH. */
export class DesktopAttachManager {
  readonly mode = "desktop-attach" as const;
  private readonly client: DesktopClient;
  private readonly store: DesktopStore;
  private readonly roots: string[];
  private readonly scopePolicy: DesktopScopePolicy;
  private readonly pollIntervalMs: number;
  private readonly opener: (url: string) => Promise<void>;
  private readonly runs = new Map<string, DesktopRun>();
  private readonly leases = new Map<string, () => Promise<void>>();
  private readonly services = new Map<string, ServiceSnapshot>();
  private loading: Promise<void> | undefined;

  constructor(options: DesktopManagerOptions = {}) {
    this.client = options.client ?? new DesktopClient();
    this.store = new DesktopStore(resolve(options.dataDirectory ?? resolveDataDirectory()));
    this.roots = options.allowedRoots ?? [];
    this.scopePolicy = options.scopePolicy ?? new DesktopBridgePolicy(this.client);
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.opener = options.openBrowser ?? (async url => {
      if (process.platform !== "darwin") throw new Error("Open Desktop manually and select the returned sessionId.");
      await new Promise<void>((done, reject) => {
        const child = spawn("open", [url], { shell: false, stdio: "ignore" });
        child.once("error", reject); child.once("close", code => code === 0 ? done() : reject(new Error("Could not focus Desktop.")));
      });
    });
  }
  async inspectAccessScope(input: StartRunInput | { workspace: string; accessScope?: { readRoots: string[]; writeRoots: string[] } }, meta: CallerMetadata) { return this.scopePolicy.inspect(input, meta); }
  connectionStatus() { return this.client.status(); }
  async connectDesktop(input: { connectionFile: string }) {
    return this.client.connectFile(input.connectionFile);
  }
  async startService(input: StartServiceInput): Promise<ServiceSnapshot> {
    const workspace = await this.workspace(input.workspace);
    const status = this.client.status();
    if (!status.connected || status.origin === null) throw new Error("Desktop is not connected. Use connect_desktop with a user-approved connection file; desktop-attach never starts another DSH service.");
    let service = [...this.services.values()].find(value => value.workspace === workspace && value.webUrl === status.origin && value.status === "running");
    if (!service) {
      service = { serviceId: randomUUID(), workspace, status: "running", webUrl: status.origin, browserOpened: false, browserError: null, startedAt: new Date().toISOString(), stoppedAt: null, processId: null, logTail: "Attached to existing Desktop; GUI entry dsh://open. No child process is owned." };
      this.services.set(service.serviceId, service);
    }
    if (input.openBrowser) return this.openService(service.serviceId);
    return { ...service };
  }
  listServices(): ServiceSnapshot[] { return [...this.services.values()].map(value => ({ ...value, status: this.client.status().connected && value.status === "running" ? "running" : "stopped" })); }
  async openService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.services.get(serviceId); if (!service) throw new Error("Unknown Desktop attachment.");
    await this.opener(DESKTOP_GUI_URL); service.browserOpened = true; return { ...service };
  }
  async stopService(serviceId: string): Promise<ServiceSnapshot> {
    const service = this.services.get(serviceId); if (!service) throw new Error("Unknown Desktop attachment.");
    await this.close(); return { ...service, status: "stopped", stoppedAt: new Date().toISOString() };
  }

  async start(input: StartRunInput, meta?: CallerMetadata): Promise<RunSnapshot> {
    if (!input.task.trim() || input.task.length > 100_000) throw new Error("task must contain 1–100,000 characters.");
    const callerScope = await this.scopePolicy.authorize(input, meta);
    await this.load();
    const service = await this.startService({ workspace: input.workspace, openBrowser: false });
    const workspace = service.workspace;
    let sessionId = input.sessionId?.trim();
    const reused = Boolean(sessionId);
    if (sessionId) {
      for (const previous of this.runs.values()) {
        if (previous.workspace === workspace && previous.sessionId === sessionId && previous.status === "running") {
          const observed = await this.get(previous.runId, meta);
          if (observed.status === "running") throw new Error("The previous run is still running or unresolved. Read that run or inspect Desktop; do not resend its prompt.");
        }
      }
      const previous = await this.knownSession(workspace, sessionId, meta);
      if (previous.callerScope!.scopeFingerprint !== callerScope.scopeFingerprint) throw new Error("Requested scope changed; an existing session cannot be reused under different directory bounds.");
    }
    else {
      const created = await this.client.rpc<{ workspace: { workspaceId: string } }>("workspace/create", { request: { path: workspace } });
      const session = this.scopePolicy instanceof DesktopBridgePolicy
        ? await this.client.rpc<{ sessionId: string }>("codexBridge/create", { request: { input, metadata: meta } })
        : await this.client.rpc<{ sessionId: string }>("session/create", { request: { workspaceId: created.workspace.workspaceId } });
      sessionId = session.sessionId;
    }
    callerScope.desktopSessionId = sessionId;
    const runId = randomUUID();
    const release = await this.store.acquire(workspace, sessionId, runId);
    try {
      const summary = await this.summary(workspace, sessionId);
      if (summary.running) throw new Error("Desktop session is still running.");
      if (!(this.scopePolicy instanceof DesktopBridgePolicy) && summary.projections?.values.permissions?.currentValue !== "workspace-write") throw new Error(`Select workspace-write for session ${sessionId} in Desktop GUI before dispatch. Continue with this sessionId after selecting it; this plugin does not expand permissions.`);
      const run: DesktopRun = {
        runId, serviceId: service.serviceId, sessionId, sessionReused: reused, task: input.task.trim(), workspace,
        callerScope, webUrl: service.webUrl!, guiUrl: DESKTOP_GUI_URL, mode: "desktop-attach", requestId: randomUUID(), submissionState: "prepared",
        status: "running", cancelRequested: false, startedAt: new Date().toISOString(), finishedAt: null, assistantText: "", lastEventSeq: this.cursor(summary), startEventSeq: this.cursor(summary), error: null,
      };
      this.runs.set(runId, run); this.leases.set(runId, release);
      // Commit identifiers before the write. A dropped acknowledgement never causes replay.
      await this.store.save(run);
      try {
        await this.client.rpc("session/prompt", { request: { sessionId, requestId: run.requestId, mode: "queue", content: [{ type: "text", text: run.task }] } });
        run.submissionState = "accepted";
      } catch {
        run.submissionState = "uncertain";
        run.error = "Desktop prompt outcome is uncertain. Do not resend; read this run or inspect its session in Desktop.";
      }
      await this.store.save(run);
      if (input.openBrowser) { try { await this.openService(service.serviceId); } catch { service.browserError = "Could not focus Desktop; open it manually."; } }
      return { ...run };
    } catch (error) { this.leases.delete(runId); await release(); throw error; }
  }

  async get(runId: string, meta?: CallerMetadata): Promise<RunSnapshot> {
    await this.load(); const run = this.requireRun(runId);
    await this.scopePolicy.verifyStored(run.callerScope, meta);
    try {
      const service = await this.startService({ workspace: run.workspace }); run.serviceId = service.serviceId; run.webUrl = service.webUrl!;
      const summary = await this.summary(run.workspace, run.sessionId);
      const records = await this.history(run.sessionId, this.cursor(summary), run.startEventSeq);
      const events = records.map(record => record.event).filter(event => event.seq > run.startEventSeq && (run.endEventSeq === undefined || event.seq <= run.endEventSeq));
      const prompt = events.find(event => event.type === "user/message" && (event.data?.message?.source?.rpcId ?? event.data?.source?.rpcId) === run.requestId);
      if (prompt) run.submissionState = "accepted";
      const relevant = prompt ? events.filter(event => event.seq >= prompt.seq) : [];
      const end = relevant.find(event => event.type === "turn/end");
      const current = end ? relevant.filter(event => event.seq <= end.seq) : relevant;
      run.assistantText = textOf(current);
      run.lastEventSeq = current.at(-1)?.seq ?? run.startEventSeq;
      const error = current.find(event => event.type === "agent/error");
      if (error || end?.data?.reason?.kind === "error") {
        run.status = "failed";
        // Host error text can contain credential fragments. Return only a fixed
        // classification and leave the detailed failure in the user's GUI.
        const failure = end?.data?.reason?.error;
        run.error = failure?.code === "AUTH" || failure?.status === 401
          ? "Desktop model authentication failed (HTTP 401). Repair the existing model in Desktop settings; no task was automatically retried."
          : "Desktop reported an agent error; inspect the same GUI session.";
        if (end) run.endEventSeq = end.seq;
      }
      else if (end) { run.status = run.cancelRequested || ["cancelled", "cancel", "aborted"].includes(end.data?.reason?.kind) ? "cancelled" : "succeeded"; run.endEventSeq = end.seq; run.error = null; }
      else if (run.cancelRequested && !summary.running) { run.status = "cancelled"; run.error = null; }
      else if (run.submissionState === "accepted") run.error = null;
      if (run.status !== "running") { run.finishedAt ??= new Date().toISOString(); await this.release(run.runId); }
      await this.store.save(run);
    } catch (error) { run.error = error instanceof Error ? error.message : "Desktop state is unavailable. Reconnect explicitly; do not resend the task."; }
    return { ...run };
  }
  async wait(runId: string, timeoutMs: number, meta?: CallerMetadata): Promise<RunSnapshot> {
    const deadline = Date.now() + Math.min(30_000, Math.max(0, timeoutMs));
    let snapshot = await this.get(runId, meta);
    while (snapshot.status === "running" && !snapshot.error && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now()))));
      snapshot = await this.get(runId, meta);
    }
    return snapshot;
  }
  async list(meta?: CallerMetadata): Promise<RunSnapshot[]> { await this.load(); return Promise.all([...this.runs.values()].filter(run => this.scopePolicy.owns(run.callerScope, meta)).map(run => this.get(run.runId, meta))); }
  async cancel(runId: string, meta?: CallerMetadata): Promise<RunSnapshot> {
    await this.load(); const run = this.requireRun(runId);
    await this.scopePolicy.verifyStored(run.callerScope, meta);
    const workspace = await this.workspace(run.workspace);
    await this.get(runId, meta);
    if (run.status !== "running") return { ...run };
    if (!this.leases.has(runId)) this.leases.set(runId, await this.store.acquire(run.workspace, run.sessionId, runId));
    await this.summary(workspace, run.sessionId);
    run.cancelRequested = true; await this.store.save(run);
    await this.client.rpc("session/cancel", { request: { sessionId: run.sessionId } });
    return this.get(runId, meta);
  }
  async readSession(input: ReadSessionInput, meta?: CallerMetadata) {
    await this.load(); const workspace = await this.workspace(input.workspace); await this.knownSession(workspace, input.sessionId, meta);
    const summary = await this.summary(workspace, input.sessionId);
    return { sessionId: input.sessionId, running: summary.running, guiUrl: DESKTOP_GUI_URL, records: await this.history(input.sessionId, this.cursor(summary), -1) };
  }
  async runEvents(runId: string, timeoutMs: number, meta?: CallerMetadata) {
    await this.load(); const run = this.requireRun(runId);
    await this.scopePolicy.verifyStored(run.callerScope, meta); await this.summary(await this.workspace(run.workspace), run.sessionId);
    const frames = await this.client.collect("session/follow", { request: { address: { kind: "session", sessionId: run.sessionId }, maxMessages: 50 } }, timeoutMs);
    return { runId, sessionId: run.sessionId, guiUrl: DESKTOP_GUI_URL, frames };
  }
  async runControl(runId: string, meta?: CallerMetadata) {
    await this.load(); const run = this.requireRun(runId);
    await this.scopePolicy.verifyStored(run.callerScope, meta); await this.summary(await this.workspace(run.workspace), run.sessionId);
    const baseline = await this.client.first<any>("session/control", {});
    return { runId, sessionId: run.sessionId, guiUrl: DESKTOP_GUI_URL, projection: baseline?.value?.projections?.[run.sessionId] ?? null };
  }
  async modelCatalog() { return this.client.rpc("session/modelCatalog", {}); }
  async selectModel(input: SelectModelInput, meta?: CallerMetadata) {
    await this.load(); const workspace = await this.workspace(input.workspace); await this.knownSession(workspace, input.sessionId, meta);
    const release = await this.store.acquire(workspace, input.sessionId, randomUUID());
    try {
      if ((await this.summary(workspace, input.sessionId)).running) throw new Error("Desktop session is still running.");
      const { workspace: _, ...request } = input;
      return await this.client.rpc("session/selectModel", { request });
    } finally { await release(); }
  }
  async close(): Promise<void> {
    await this.client.close();
    await Promise.all([...this.leases.keys()].map(id => this.release(id)));
    for (const service of this.services.values()) { service.status = "stopped"; service.stoppedAt = new Date().toISOString(); }
  }
  private async load(): Promise<void> {
    this.loading ??= this.store.load().then(runs => { for (const run of runs) if (!this.runs.has(run.runId)) this.runs.set(run.runId, run); });
    await this.loading;
  }
  private requireRun(id: string): DesktopRun { const run = this.runs.get(id); if (!run) throw new Error("Unknown Desktop runId."); return run; }
  private async release(id: string) { const release = this.leases.get(id); this.leases.delete(id); if (release) await release(); }
  private async knownSession(workspace: string, sessionId: string, meta: CallerMetadata): Promise<DesktopRun> {
    const run = [...this.runs.values()].find(run => run.sessionId === sessionId && run.workspace === workspace);
    await this.scopePolicy.verifyStored(run?.callerScope, meta);
    await this.summary(workspace, sessionId);
    return run!;
  }
  private async summary(workspace: string, sessionId: string): Promise<Summary> {
    const list = await this.client.rpc<{ items: Summary[] }>("session/list", { _request: {} });
    const row = list.items.find(item => item.sessionId === sessionId);
    if (!row) throw new Error("The selected session is absent from this Desktop Host; do not create a replacement automatically.");
    if (!row.cwd || await realpath(row.cwd) !== workspace) throw new Error("Desktop session belongs to another workspace.");
    return row;
  }
  private cursor(summary: Summary): number {
    const cursor = summary.projections?.asOfSeq;
    if (!Number.isSafeInteger(cursor) || cursor! < -1) throw new Error("Desktop has no current history cursor for this session. Open it in GUI before continuing.");
    return cursor!;
  }
  private async history(sessionId: string, throughSeq: number, afterSeq: number): Promise<RecordEntry[]> {
    const result: RecordEntry[] = []; let beforeSeq: number | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.client.rpc<{ records: RecordEntry[]; hasMore: boolean }>("session/page", { request: { address: { kind: "session", sessionId }, throughSeq, maxMessages: 50, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
      result.unshift(...page.records);
      const first = page.records[0]?.event.seq;
      if (!page.hasMore || first === undefined || first <= afterSeq + 1) return result.filter(record => record.event.seq > afterSeq);
      if (beforeSeq !== undefined && first >= beforeSeq) throw new Error("Desktop history cursor did not advance.");
      beforeSeq = first;
    }
    throw new Error("Desktop history exceeded the bounded page window; inspect the GUI session.");
  }
  private async workspace(input: string): Promise<string> {
    if (!isAbsolute(input)) throw new Error("workspace must be an absolute path.");
    const path = await realpath(input);
    if (!(await stat(path)).isDirectory()) throw new Error("workspace must be a directory.");
    if (!this.roots.length) return path;
    const roots = await Promise.all(this.roots.map(root => realpath(root)));
    if (!roots.some(root => { const child = relative(root, path); return child === "" || (!child.startsWith("..") && !isAbsolute(child)); })) throw new Error("workspace is outside the additional deployment ceiling.");
    return path;
  }
}

function textOf(events: Event[]): string {
  return events.filter(event => event.type === "assistant/message").flatMap(event => {
    const content = (event.data?.message ?? event.data)?.content;
    return Array.isArray(content) ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text) : [];
  }).join("\n");
}
