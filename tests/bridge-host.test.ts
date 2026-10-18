import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Service } from "@deepseek-ai/cordis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@deepseek-ai/dsh-tools", () => ({ defineTool: (value: unknown) => value }));
import { CodexPolicyBridge, PRESET } from "../src/dsh-bridge/plugin.js";
import { fixtureMetadata } from "./fixtures/native-policy.js";

describe("Host bridge lifecycle with SDK service binding and synthetic agents", () => {
  let root: string; let work: string; let denied: string; let bridge: CodexPolicyBridge; let dispose: () => Promise<void>;
  const agents = new Map<string, any>(); const guards: ((exec: any) => string | undefined)[] = [];
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bridge-host-"))); work = join(root, "work"); denied = join(root, "denied"); await mkdir(work); await mkdir(denied);
    const ctx = new Context();
    (ctx as any).reflect.provide("tools", { guard: (fn: any) => { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1); } });
    (ctx as any).reflect.provide("agentPresets", { register: async () => async () => undefined, mount: async () => undefined });
    (ctx as any).reflect.provide("agentDefaultModel", { currentSelection: () => ({ provider: "synthetic", model: "never-called" }) });
    (ctx as any).reflect.provide("workspaceRegistry", { create: vi.fn(async () => ({ attachSession: vi.fn(async () => undefined) })) });
    (ctx as any).reflect.provide("sessionTitle", { rename: vi.fn() });
    (ctx as any).reflect.provide("agents", { create: async (options: any) => {
      const tools = new Map<string, any>();
      const agent: any = { id: options.sessionId, session: { header: { agentPreset: PRESET } }, status: "idle", cancel: vi.fn() };
      agent.ctx = { tools: { schemas: () => [...tools.keys()].map(name => ({name})), restrict: vi.fn(), presentAs: vi.fn(), register: (tool: any) => tools.set(tool.name, tool), execute: async (exec: any) => {
        const denial = guards.map(g => g(exec)).find(Boolean); const tool = tools.get(exec.name);
        if (denial || !tool) return { isError: true, content: [{ type: "text", text: denial ?? "UNKNOWN_TOOL" }] };
        try { return { isError: false, content: [{ type: "text", text: JSON.stringify(await tool.execute(exec.arguments, exec)) }] }; } catch (error) { return { isError: true, content: [{ type: "text", text: String(error) }] }; }
      } } };
      await options.setup(agent.ctx, agent); agents.set(agent.id, agent);
      return { agent, dispose: async () => { agent.cancel(); agents.delete(agent.id); } };
    } });
    bridge = new CodexPolicyBridge(ctx);
    const lifecycle = bridge[Service.init](); dispose = (await lifecycle.next()).value as () => Promise<void>;
  });
  afterEach(async () => { await dispose(); agents.clear(); guards.length = 0; await rm(root, { recursive: true, force: true }); });
  it("binds a new agent, denies all unsupported tools and isolates callers", async () => {
    const request = { input: { workspace: work, accessScope: { readRoots: [work], writeRoots: [work] } }, metadata: fixtureMetadata(work, denied) };
    const { sessionId } = await bridge.create(request);
    expect((bridge as any).ctx.sessionTitle.rename).toHaveBeenCalledWith(agents.get(sessionId).session, `Codex task ${sessionId.slice(0, 8)}`);
    const workspace = await (bridge as any).ctx.workspaceRegistry.create.mock.results[0].value;
    expect(workspace.attachSession).toHaveBeenCalledWith(sessionId);
    expect(agents.get(sessionId).ctx.tools.restrict).toHaveBeenCalledWith({ allow: [] });
    expect(guards[0]!({ name: "bash", agent: agents.get(sessionId) })).toContain("not adapted");
    expect((await bridge.checkOperation({ ...request, sessionId, operation: { kind: "write", path: "allowed", text: "SYNTHETIC" } })).isError).toBe(false);
    await expect(bridge.verify({ ...request, sessionId, metadata: fixtureMetadata(work, denied, "other-caller") })).rejects.toThrow("another caller");
    expect(guards[0]!({ name: "bash", agent: { id: "ordinary", session: { header: {} } } })).toBeUndefined();
  });
  it("cancels old authority on policy change and denies a resumed unbound agent", async () => {
    const request = { input: { workspace: work, accessScope: { readRoots: [work], writeRoots: [] } }, metadata: fixtureMetadata(work, denied) };
    const { sessionId } = await bridge.create(request);
    const changed = { ...request.metadata, "codex/sandbox-state": { ...request.metadata["codex/sandbox-state"], futureField: { preserved: false } } };
    await expect(bridge.verify({ ...request, sessionId, metadata: changed })).rejects.toThrow("policy changed");
    expect(agents.get(sessionId).cancel).toHaveBeenCalled();
    await expect(bridge.verify({ ...request, sessionId })).rejects.toThrow("revoked");
    expect(guards[0]!({ name: "codex_read", agent: agents.get(sessionId) })).toContain("expired");
    expect(guards[0]!({ name: "codex_read", agent: { id: "cold", session: { header: { agentPreset: PRESET } } } })).toContain("missing");
  });
});
