import { mkdtemp, mkdir, realpath, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopScopePolicy } from "../src/access-scope.js";
import { nativeAuthority, nativeFileOperation } from "../src/dsh-bridge/native.js";
import { fixtureMetadata, launcher } from "./fixtures/native-policy.js";
describe.skipIf(process.platform !== "darwin" || !existsSync(launcher))("Native Codex execution on synthetic files", () => {
  let root: string; let work: string; let denied: string; let reference: string;
  beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), "native-bridge-"))); work = join(root, "work"); denied = join(root, "denied"); reference = join(root, "reference"); for (const path of [work, denied, reference]) await mkdir(path); await writeFile(join(denied, "canary"), "DENIED_SYNTHETIC"); await writeFile(join(reference, "canary"), "READ_ONLY_SYNTHETIC"); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("applies opaque native read/write limits and preserves unknown fields", async () => {
    const meta = fixtureMetadata(work, denied); const input = { workspace: work, accessScope: { readRoots: [root], writeRoots: [root] } };
    const binding = await new DesktopScopePolicy().prepare(input, meta); const authority = await nativeAuthority(meta);
    await nativeFileOperation(authority, binding, { kind: "write", path: "allowed.txt", text: "OK" });
    expect(await readFile(join(work, "allowed.txt"), "utf8")).toBe("OK");
    expect(await nativeFileOperation(authority, binding, { kind: "read", path: join(reference, "canary") })).toBe("READ_ONLY_SYNTHETIC");
    await expect(nativeFileOperation(authority, binding, { kind: "write", path: join(reference, "cannot-write"), text: "NO" })).rejects.toThrow("EPERM");
    await expect(nativeFileOperation(authority, binding, { kind: "read", path: join(denied, "canary") })).rejects.toThrow("EPERM");
    await expect(nativeFileOperation(authority, binding, { kind: "write", path: join(denied, "cannot-write"), text: "NO" })).rejects.toThrow("EPERM");
    expect(authority.state).toBe(meta["codex/sandbox-state"]); expect(meta["codex/sandbox-state"].futureField).toEqual({ preserved: true });
  });
  it("narrows proposals and refuses a symlink into a native-denied directory", async () => {
    const meta = fixtureMetadata(work, denied); const policy = new DesktopScopePolicy(); const authority = await nativeAuthority(meta);
    const narrowed = await policy.prepare({ workspace: work, accessScope: { readRoots: [work], writeRoots: [] } }, meta);
    await expect(nativeFileOperation(authority, narrowed, { kind: "read", path: join(reference, "canary") })).rejects.toThrow("REQUESTED_SCOPE_DENIED");
    await expect(nativeFileOperation(authority, narrowed, { kind: "write", path: "no", text: "NO" })).rejects.toThrow("REQUESTED_SCOPE_DENIED");
    await symlink(denied, join(work, "escape"));
    const broad = await policy.prepare({ workspace: work, accessScope: { readRoots: [root], writeRoots: [work] } }, meta);
    await expect(nativeFileOperation(authority, broad, { kind: "read", path: "escape/canary" })).rejects.toThrow("EPERM");
  });
  it("keeps trusted runtime code read-only even inside an otherwise writable request", async () => {
    const meta = fixtureMetadata(work, denied);
    const binding = await new DesktopScopePolicy().prepare({ workspace: work, accessScope: { readRoots: [work], writeRoots: [work] } }, meta);
    const protectedDirectory = join(work, "trusted-runtime"); await mkdir(protectedDirectory);
    await expect(nativeFileOperation(await nativeAuthority(meta), binding, { kind: "write", path: join(protectedDirectory, "module.mjs"), text: "NO" }, undefined, [protectedDirectory])).rejects.toThrow("RUNTIME_CODE_PROTECTED");
  });
  it("rejects missing launch authority, unconfined modes and cancellation", async () => {
    const meta = fixtureMetadata(work, denied);
    await expect(nativeAuthority({ ...meta, "codex/sandbox-launcher": {} })).rejects.toThrow("launcher");
    await expect(nativeAuthority({ ...meta, "codex/sandbox-state": { permissionProfile: { type: "disabled" } } })).rejects.toThrow("managed/restricted");
    const binding = await new DesktopScopePolicy().prepare({ workspace: work, accessScope: { readRoots: [work], writeRoots: [work] } }, meta);
    await expect(nativeFileOperation(await nativeAuthority(meta), binding, { kind: "ping" }, AbortSignal.abort())).rejects.toThrow();
  });
});
