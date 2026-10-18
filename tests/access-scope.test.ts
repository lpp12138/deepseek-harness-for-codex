import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopScopePolicy, assertScopeSubset, callerIdentity, normalizeScope } from "../src/access-scope.js";

describe("Per-call directory scope", () => {
  let root: string;
  let workspace: string;
  let outside: string;
  const meta = { threadId: "synthetic-agent-a", sessionId: "synthetic-session-a", "codex/sandbox-state": { permissionProfile: { opaque: "synthetic" }, sandboxCwd: "file:///synthetic", futureField: { retained: true } } };
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "caller-scope-"))); workspace = join(root, "work"); outside = join(root, "other"); await mkdir(workspace); await mkdir(outside); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("does not accept a model declaration or MCP roots as a permission grant", async () => {
    const policy = new DesktopScopePolicy();
    const input = { workspace, accessScope: { readRoots: [root], writeRoots: [workspace] } };
    await expect(policy.authorize(input, undefined)).rejects.toThrow("trusted caller");
    await expect(policy.authorize(input, { threadId: "fake", sessionId: "fake", allowedRoots: ["/"] })).rejects.toThrow("trusted caller");
  });
  it("recognizes host policy but blocks before dispatch when Desktop cannot apply it", async () => {
    const policy = new DesktopScopePolicy();
    const input = { workspace, accessScope: { readRoots: [root], writeRoots: [workspace] } };
    const result = await policy.inspect(input, meta);
    expect(result).toMatchObject({ callerContextReceived: true, canDispatch: false, desktopPolicyEnforcement: "unavailable", globalRootsAreAuthority: false });
    await expect(policy.authorize(input, meta)).rejects.toThrow("Desktop cannot apply");
  });
  it("keeps the opaque policy intact and binds identity, policy and per-call scope separately", async () => {
    const policy = new DesktopScopePolicy();
    const a = await policy.prepare({ workspace, accessScope: { readRoots: [root], writeRoots: [workspace] } }, meta);
    const b = await policy.prepare({ workspace, accessScope: { readRoots: [workspace], writeRoots: [] } }, meta);
    expect(a.callerFingerprint).toBe(b.callerFingerprint); expect(a.scopeFingerprint).not.toBe(b.scopeFingerprint);
    expect(meta["codex/sandbox-state"].futureField).toEqual({ retained: true });
    expect(JSON.stringify(a)).not.toContain("permissionProfile");
    await expect(policy.verifyStored(a, { ...meta, threadId: "synthetic-agent-b" })).rejects.toThrow("another caller");
    await expect(policy.verifyStored(a, { ...meta, "codex/sandbox-state": { ...meta["codex/sandbox-state"], futureField: { retained: false } } })).rejects.toThrow("policy changed");
  });
  it("rejects conflicting metadata aliases rather than selecting the broader one", () => {
    expect(() => callerIdentity({ ...meta, "codex/sandbox-state-meta": { permissionProfile: { other: true } } })).toThrow("conflicting");
  });
  it("canonicalizes symlinks and distinguishes read-only paths from writable grants", async () => {
    await symlink(outside, join(workspace, "escape"));
    const proposed = await normalizeScope({ workspace, accessScope: { readRoots: [root], writeRoots: [join(workspace, "escape")] } });
    const grant = await normalizeScope({ workspace, accessScope: { readRoots: [root], writeRoots: [workspace] } });
    expect(proposed.writeRoots).toEqual([outside]);
    expect(() => assertScopeSubset(proposed, grant)).toThrow("write scope");
    const readOnly = await normalizeScope({ workspace, accessScope: { readRoots: [root], writeRoots: [] } });
    expect(() => assertScopeSubset(grant, readOnly)).toThrow("write scope");
  });
  it("rechecks canonical directory identities on every restored run", async () => {
    const alias = join(root, "alias"); await symlink(workspace, alias);
    const policy = new DesktopScopePolicy();
    const binding = await policy.prepare({ workspace: alias, accessScope: { readRoots: [root], writeRoots: [alias] } }, meta);
    await rm(alias); await symlink(outside, alias);
    await expect(policy.verifyStored(binding, meta)).rejects.toThrow("directory identity changed");
  });
  it("does not silently adopt legacy unbound sessions", async () => {
    await expect(new DesktopScopePolicy().verifyStored(undefined, meta)).rejects.toThrow("no caller scope binding");
  });
});
