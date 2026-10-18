import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAttachManager } from "../src/desktop-manager.js";
import { syntheticScope } from "./fixtures/synthetic-scope.js";
import { desktopHost } from "./fixtures/desktop-host.js";

describe("Desktop attach lifecycle", () => {
  let host: Awaited<ReturnType<typeof desktopHost>>;
  let root: string;
  let workspace: string;
  let data: string;
  let connectionFile: string;
  const managers: DesktopAttachManager[] = [];
  const opener = vi.fn(async () => undefined);
  function make() {
    const manager = new DesktopAttachManager({ dataDirectory: data, allowedRoots: [workspace], scopePolicy: syntheticScope(workspace), pollIntervalMs: 5, openBrowser: opener });
    managers.push(manager); return manager;
  }
  beforeEach(async () => {
    host = await desktopHost(); root = await realpath(await mkdtemp(join(tmpdir(), "desktop-manager-")));
    workspace = join(root, "workspace"); data = join(root, "state"); await mkdir(workspace);
    connectionFile = join(root, "approved-connection.txt"); await writeFile(connectionFile, host.connectUrl, { mode: 0o600 }); opener.mockClear();
  });
  afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.close())); await host.close(); await rm(root, { recursive: true, force: true }); });

  it("does not launch a service or read credentials when not connected", async () => {
    const m = make(); await expect(m.startService({ workspace })).rejects.toThrow("connect_desktop");
    expect(host.connections).toHaveLength(0); expect(m.listServices()).toEqual([]);
  });
  it("creates a scoped session, sends a unique requestId, and returns the real token-free GUI entry", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const started = await m.start({ workspace, task: "synthetic task" });
    expect(started).toMatchObject({ mode: "desktop-attach", sessionId: "synthetic-1", webUrl: host.origin, guiUrl: "dsh://open" });
    const prompt = host.requests.find(x => x.body.method === "session/prompt")!.body.payload.args.request;
    expect(prompt).toMatchObject({ mode: "queue", sessionId: started.sessionId });
    expect(prompt.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(host.sessions.get(started.sessionId)!.cwd).toBe(workspace);
    expect(opener).not.toHaveBeenCalled();
  });
  it("completes and continues the same session with only this turn's output", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const first = await m.start({ workspace, task: "first" }); await m.wait(first.runId, 1000);
    const next = await m.start({ workspace, sessionId: first.sessionId, task: "second" });
    const done = await m.wait(next.runId, 1000);
    expect(done.status).toBe("succeeded"); expect(done.sessionReused).toBe(true);
    expect(done.assistantText).toBe("completed:second");
    expect(host.connections).toHaveLength(1);
  });
  it("cancels only the current turn and retains its Host and session", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "keep running" });
    expect((await m.cancel(run.runId)).status).toBe("cancelled");
    expect(m.listServices()[0]?.status).toBe("running");
    expect(host.sessions.has(run.sessionId)).toBe(true);
  });
  it("reads native message payloads and classifies native turn-end authentication failures safely", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const first = await m.start({ workspace, task: "keep running" });
    const session = host.sessions.get(first.sessionId)!;
    session.events.push({ seq: session.events.length, type: "assistant/message", data: { role: "assistant", content: [{ type: "text", text: "NATIVE_OK" }] } });
    session.events.push({ seq: session.events.length, type: "turn/end", data: { reason: { kind: "stop" } } });
    session.running = false;
    expect((await m.get(first.runId)).assistantText).toBe("NATIVE_OK");
    const next = await m.start({ workspace, sessionId: first.sessionId, task: "keep running" });
    session.events.push({ seq: session.events.length, type: "turn/end", data: { reason: { kind: "error", error: { code: "AUTH", status: 401, message: "PRIVATE_CREDENTIAL_FRAGMENT" } } } });
    session.running = false;
    const failed = await m.get(next.runId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("HTTP 401");
    expect(JSON.stringify(failed)).not.toContain("PRIVATE_CREDENTIAL_FRAGMENT");
  });
  it("keeps sessionId, requestId and GUI entry across MCP restarts without storing prompts, results or secrets", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "private synthetic task keep running" });
    await m.close(); expect(host.sessions.get(run.sessionId)!.running).toBe(true);
    const stored = (await readdir(join(data, "desktop-runs"))).filter(p => p.endsWith(".json"));
    const serialized = await readFile(join(data, "desktop-runs", stored[0]!), "utf8");
    expect(serialized).toContain(run.sessionId); expect(serialized).toContain("dsh://open");
    expect(serialized).not.toMatch(/synthetic-test-secret|synthetic_peer|private synthetic task|completed:/);
    const restarted = make(); await restarted.connectDesktop({ connectionFile });
    expect((await restarted.get(run.runId)).sessionId).toBe(run.sessionId);
    expect((await restarted.cancel(run.runId)).status).toBe("cancelled");
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(1);
  });
  it("prevents two MCP clients from concurrently controlling a session", async () => {
    const a = make(); const b = make(); await a.connectDesktop({ connectionFile }); await b.connectDesktop({ connectionFile });
    const run = await a.start({ workspace, task: "first" }); await a.wait(run.runId, 1000);
    const overlap = await Promise.allSettled([a.start({ workspace, sessionId: run.sessionId, task: "keep running one" }), b.start({ workspace, sessionId: run.sessionId, task: "keep running two" })]);
    expect(overlap.filter(x => x.status === "fulfilled")).toHaveLength(1);
    expect(overlap.filter(x => x.status === "rejected")).toHaveLength(1);
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(2);
  });
  it("rejects an out-of-root workspace and a session owned by another cwd", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    await expect(m.start({ workspace: root, task: "outside" })).rejects.toThrow("outside");
    const run = await m.start({ workspace, task: "first" }); await m.wait(run.runId, 1000);
    host.sessions.get(run.sessionId)!.cwd = root;
    await expect(m.start({ workspace, task: "wrong cwd", sessionId: run.sessionId })).rejects.toThrow("another workspace");
  });
  it("requires workspace-write to be selected in GUI before dispatch", async () => {
    host.setPermission("danger-full-access"); const m = make(); await m.connectDesktop({ connectionFile });
    await expect(m.start({ workspace, task: "must not run" })).rejects.toThrow("workspace-write");
    expect(host.requests.some(x => x.body.method === "session/prompt")).toBe(false);
  });
  it("reads scoped status/history and live frames without resending a prompt", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "first" }); await m.wait(run.runId, 1000);
    expect((await m.readSession({ workspace, sessionId: run.sessionId })).records.length).toBeGreaterThan(0);
    expect((await m.runEvents(run.runId, 0)).frames[0]).toMatchObject({ type: "snapshot" });
    expect((await m.runControl(run.runId)).guiUrl).toBe("dsh://open");
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(1);
  });
  it("exposes model selection only as an explicit operation on a known idle session", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "first" }); await m.wait(run.runId, 1000);
    expect(await m.modelCatalog()).toMatchObject({ routableProviders: ["synthetic"] });
    expect(await m.selectModel({ workspace, sessionId: run.sessionId, provider: "synthetic", model: "test-model" })).toEqual({ selected: { provider: "synthetic", model: "test-model" } });
  });
  it("preserves an uncertain submission without automatically retrying a paid prompt", async () => {
    host.dropPromptAcknowledgement(); const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "keep running" });
    expect(run.submissionState).toBe("uncertain"); expect(run.error).toContain("not resend");
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(1);
    const recovered = await m.get(run.runId); expect(recovered.submissionState).toBe("accepted");
  });
  it("disconnects its own peer on stop_service without canceling or stopping Desktop", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "keep running" }); await m.stopService(run.serviceId);
    expect(host.sessions.get(run.sessionId)!.running).toBe(true);
    expect(host.requests.some(x => x.body.method === "session/cancel")).toBe(false);
  });
  it("rejects another caller's read/cancel/continuation and changed per-call scope", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "first" }); await m.wait(run.runId, 1000);
    const foreign = { threadId: "another-agent", sessionId: "synthetic-codex-session", "codex/sandbox-state": { permissionProfile: { testFixture: true }, sandboxCwd: "file:///synthetic" } };
    await expect(m.get(run.runId, foreign)).rejects.toThrow("another caller");
    await expect(m.cancel(run.runId, foreign)).rejects.toThrow("another caller");
    expect(await m.list(foreign)).toEqual([]);
    await expect(m.readSession({ workspace, sessionId: run.sessionId }, foreign)).rejects.toThrow("another caller");
    await expect(m.start({ workspace, sessionId: run.sessionId, task: "must not run", accessScope: { readRoots: [workspace], writeRoots: [] } })).rejects.toThrow("scope changed");
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(1);
  });
  it("rechecks current workspace roots before canceling a recovered run", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "keep running" }); await m.close();
    const other = join(root, "other"); await mkdir(other);
    const narrowed = new DesktopAttachManager({ dataDirectory: data, allowedRoots: [other], scopePolicy: syntheticScope(workspace) }); managers.push(narrowed);
    await narrowed.connectDesktop({ connectionFile });
    await expect(narrowed.cancel(run.runId)).rejects.toThrow("outside");
    expect(host.requests.some(x => x.body.method === "session/cancel")).toBe(false);
  });
  it("does not start a follow-up while a recovered submission is unresolved", async () => {
    const m = make(); await m.connectDesktop({ connectionFile });
    const run = await m.start({ workspace, task: "keep running" });
    // A prepared/accepted prompt can be queued but not yet appear in cold history.
    host.sessions.get(run.sessionId)!.events = []; host.sessions.get(run.sessionId)!.running = false;
    await m.close(); const restarted = make(); await restarted.connectDesktop({ connectionFile });
    await expect(restarted.start({ workspace, sessionId: run.sessionId, task: "must not replay" })).rejects.toThrow("unresolved");
    expect(host.requests.filter(x => x.body.method === "session/prompt")).toHaveLength(1);
  });
});
