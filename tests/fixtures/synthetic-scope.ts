import { DesktopScopePolicy, assertScopeSubset, type ScopeInput } from "../../src/access-scope.js";

/** A synthetic Host enforcer for lifecycle tests; production has no such Desktop bridge. */
export function syntheticScope(workspace: string, agent = "synthetic-agent-a") {
  const metadata = { threadId: agent, sessionId: "synthetic-codex-session", "codex/sandbox-state": { permissionProfile: { testFixture: true }, sandboxCwd: "file:///synthetic" } };
  return new class extends DesktopScopePolicy {
    private input(input: ScopeInput): ScopeInput { return { ...input, accessScope: input.accessScope ?? { readRoots: [workspace], writeRoots: [workspace] } }; }
    override async authorize(input: ScopeInput, meta?: Record<string, unknown>) {
      const proposed = await this.prepare(this.input(input), meta ?? metadata);
      const grant = await this.prepare({ workspace, accessScope: { readRoots: [workspace], writeRoots: [workspace] } }, meta ?? metadata);
      assertScopeSubset(proposed.canonical, grant.canonical);
      return proposed;
    }
    override async verifyStored(binding: Parameters<DesktopScopePolicy["verifyStored"]>[0], meta?: Record<string, unknown>) { return super.verifyStored(binding, meta ?? metadata); }
    override owns(binding: Parameters<DesktopScopePolicy["owns"]>[0], meta?: Record<string, unknown>) { return super.owns(binding, meta ?? metadata); }
  }();
}
