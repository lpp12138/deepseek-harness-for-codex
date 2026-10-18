import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export interface DirectoryScope { readRoots: string[]; writeRoots: string[] }
export interface ScopeInput { workspace: string; accessScope?: DirectoryScope | undefined }
export type CallerMetadata = Record<string, unknown> | undefined;
export interface CanonicalScope extends DirectoryScope { workspace: string }
export interface CallerScopeBinding {
  callerFingerprint: string;
  policyFingerprint: string;
  scopeFingerprint: string;
  canonical: CanonicalScope;
  requested: ScopeInput & { accessScope: DirectoryScope };
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (object(value)) return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
/** Transport _meta only. Model arguments and roots/list never establish authority. */
export function callerIdentity(meta: CallerMetadata) {
  const state = meta?.["codex/sandbox-state"] ?? meta?.["codex/sandbox-state-meta"];
  if (meta?.["codex/sandbox-state"] !== undefined && meta["codex/sandbox-state-meta"] !== undefined && stable(meta["codex/sandbox-state"]) !== stable(meta["codex/sandbox-state-meta"])) throw new Error("Codex supplied conflicting sandbox metadata aliases.");
  if (!meta || typeof meta.threadId !== "string" || !meta.threadId || typeof meta.sessionId !== "string" || !meta.sessionId || !object(state) || !object(state.permissionProfile)) throw new Error("Missing trusted caller context: Codex must supply threadId, sessionId and opaque sandbox policy in tool-call _meta. Model-declared paths and MCP roots are not permission grants.");
  // Keep the complete opaque object: unknown fields must affect the policy binding.
  return { callerFingerprint: fingerprint([meta.threadId, meta.sessionId]), policyFingerprint: fingerprint(state) };
}
async function directory(value: string): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error("Scope paths and workspace must be absolute directories.");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) throw new Error("Scope paths and workspace must be directories.");
  return canonical;
}
function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
}
export async function normalizeScope(input: ScopeInput): Promise<CanonicalScope> {
  const scope = input.accessScope;
  if (!scope || !Array.isArray(scope.readRoots) || !Array.isArray(scope.writeRoots) || scope.readRoots.length + scope.writeRoots.length > 128) throw new Error("Provide per-call accessScope.readRoots and accessScope.writeRoots (at most 128 directories). These are requested bounds, not authorization.");
  const [workspace, reads, writes] = await Promise.all([directory(input.workspace), Promise.all(scope.readRoots.map(directory)), Promise.all(scope.writeRoots.map(directory))]);
  const readRoots = [...new Set(reads)].sort(); const writeRoots = [...new Set(writes)].sort();
  if (![...readRoots, ...writeRoots].some(root => contains(root, workspace))) throw new Error("workspace is outside the requested directory scope.");
  return { workspace, readRoots, writeRoots };
}
/** Used by synthetic authority fixtures. Real Codex policy is opaque, never flattened here. */
export function assertScopeSubset(proposed: CanonicalScope, grant: CanonicalScope): void {
  if (!proposed.readRoots.every(path => [...grant.readRoots, ...grant.writeRoots].some(root => contains(root, path)))) throw new Error("Requested read scope is outside the caller grant.");
  if (!proposed.writeRoots.every(path => grant.writeRoots.some(root => contains(root, path)))) throw new Error("Requested write scope is outside the caller grant.");
}
/** No implementation claims enforcement by an already-running Desktop Host. */
export class DesktopScopePolicy {
  async prepare(input: ScopeInput, meta: CallerMetadata): Promise<CallerScopeBinding> {
    const identity = callerIdentity(meta);
    const canonical = await normalizeScope(input);
    return { ...identity, scopeFingerprint: fingerprint(canonical), canonical, requested: { workspace: input.workspace, accessScope: { readRoots: [...input.accessScope!.readRoots], writeRoots: [...input.accessScope!.writeRoots] } } };
  }
  async inspect(input: ScopeInput, meta: CallerMetadata) {
    const binding = await this.prepare(input, meta);
    return { callerContextReceived: true, canDispatch: false, desktopPolicyEnforcement: "unavailable", globalRootsAreAuthority: false, requestedScope: binding.canonical, missing: "DSH execution-side support for the current caller's opaque Codex sandbox policy. Desktop 0.2.1-rc.2 session/create only accepts cwd, not per-caller read/write policy." };
  }
  async authorize(input: ScopeInput, meta: CallerMetadata): Promise<CallerScopeBinding> {
    await this.prepare(input, meta);
    throw new Error("Desktop cannot apply the current caller's opaque Codex sandbox policy. No DSH session or task was submitted. Per-call paths, cwd, a prompt and global workspace roots cannot replace execution-side policy enforcement.");
  }
  owns(binding: CallerScopeBinding | undefined, meta: CallerMetadata): boolean {
    if (!binding) return false;
    const identity = callerIdentity(meta);
    return identity.callerFingerprint === binding.callerFingerprint && identity.policyFingerprint === binding.policyFingerprint;
  }
  async verifyStored(binding: CallerScopeBinding | undefined, meta: CallerMetadata): Promise<void> {
    if (!binding) throw new Error("Session has no caller scope binding; legacy or foreign sessions cannot be adopted automatically.");
    const identity = callerIdentity(meta);
    if (identity.callerFingerprint !== binding.callerFingerprint) throw new Error("Session belongs to another caller.");
    if (identity.policyFingerprint !== binding.policyFingerprint) throw new Error("Caller policy changed; use a new scoped session after native enforcement is available.");
    if (fingerprint(await normalizeScope(binding.requested)) !== binding.scopeFingerprint) throw new Error("Scoped directory identity changed; do not reuse this session.");
  }
}
