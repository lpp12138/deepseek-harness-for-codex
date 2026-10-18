export const launcher = process.env.CODEX_SANDBOX_TEST_LAUNCHER ?? "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
export function fixtureMetadata(workspace: string, denied: string, caller = "synthetic-agent") {
  return { threadId: caller, sessionId: "synthetic-session", "codex/sandbox-launcher": { codexExecutable: launcher }, "codex/sandbox-state": {
    permissionProfile: { type: "managed", file_system: { type: "restricted", entries: [
      { path: { type: "special", value: { kind: "root" } }, access: "read" },
      { path: { type: "path", path: workspace }, access: "write" },
      { path: { type: "path", path: denied }, access: "deny" },
    ] }, network: "restricted" }, codexLinuxSandboxExe: null, sandboxCwd: new URL("file://" + workspace).href, useLegacyLandlock: false, useMxc: false, futureField: { preserved: true },
  } };
}
