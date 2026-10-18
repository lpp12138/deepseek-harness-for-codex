import { DesktopScopePolicy, callerIdentity, type CallerMetadata, type CallerScopeBinding, type ScopeInput } from "./access-scope.js";
import type { DesktopClient } from "./desktop-client.js";
import { nativeAuthority } from "./dsh-bridge/native.js";

/** Production admission requires the installed execution bridge, never an env bypass. */
export class DesktopBridgePolicy extends DesktopScopePolicy {
  constructor(private readonly client: DesktopClient) { super(); }
  override async inspect(input: ScopeInput, meta: CallerMetadata) {
    const binding = await this.prepare(input, meta);
    const base = { callerContextReceived: true, canDispatch: false, desktopPolicyEnforcement: "unavailable", globalRootsAreAuthority: false, requestedScope: binding.canonical, missing: "" };
    try {
      await nativeAuthority(meta);
      if (!this.client.status().connected) throw new Error("Connect the explicitly approved existing Desktop first.");
      const checked = await this.client.rpc<any>("codexBridge/preflight", { request: { input, metadata: meta } });
      if (checked.canDispatch !== true || checked.desktopPolicyEnforcement !== "native-codex-files") throw new Error("Native execution bridge did not confirm confinement.");
      return { ...base, ...checked, missing: "" };
    } catch (error) { return { ...base, missing: error instanceof Error ? error.message : "Native execution bridge unavailable." }; }
  }
  override async authorize(input: ScopeInput, meta: CallerMetadata): Promise<CallerScopeBinding> {
    const checked = await this.inspect(input, meta);
    if (!checked.canDispatch) throw new Error(`Desktop cannot apply the current caller policy: ${checked.missing} No DSH session or task was submitted.`);
    return this.prepare(input, meta);
  }
  override async verifyStored(binding: CallerScopeBinding | undefined, meta: CallerMetadata): Promise<void> {
    // A foreign caller cannot revoke another owner's live work.
    const identity = callerIdentity(meta);
    if (!binding || identity.callerFingerprint !== binding.callerFingerprint) return super.verifyStored(binding, meta);
    if (!binding.desktopSessionId) throw new Error("Session has no native bridge identity; legacy sessions cannot be adopted.");
    // Host sees same-owner policy changes and cancels the old authority before refusing.
    await this.client.rpc("codexBridge/verify", { request: { sessionId: binding.desktopSessionId, input: binding.requested, metadata: meta } });
    await super.verifyStored(binding, meta);
  }
}
