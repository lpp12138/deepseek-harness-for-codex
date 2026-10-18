import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const DEFAULT_HARNESS_PACKAGE = "@deepseek-ai/dsh@0.1.0-rc.6";

export function resolveMode(env: NodeJS.ProcessEnv = process.env): "desktop-attach" | "managed-web" {
  const mode = env.DSH_MCP_MODE?.trim() || "desktop-attach";
  if (mode !== "desktop-attach" && mode !== "managed-web") throw new Error("DSH_MCP_MODE must be desktop-attach or managed-web. No fallback is performed.");
  return mode;
}

/** A shell-free command specification for one local Harness process. */
export interface HarnessCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** Values required to construct a local Harness Web command. */
export interface HarnessWebCommandInput {
  workspace: string;
  serviceHome: string;
}

/** Resolves the persistent data directory used for local Web service state. */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_MCP_DATA_DIR?.trim() || env.PLUGIN_DATA?.trim();
  return configured || join(homedir(), ".deep-seek-harness-mcp");
}

/** Resolves optional workspace roots that the MCP server may modify. */
export function resolveAllowedRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DSH_MCP_WORKSPACE_ROOTS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Builds the argv and environment for the published Harness Web UI. */
export function buildHarnessWebCommand(
  input: HarnessWebCommandInput,
  env: NodeJS.ProcessEnv = process.env,
): HarnessCommand {
  const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
  const harnessPackage = env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE;
  if (harnessPackage.startsWith("-")) {
    throw new Error("DSH_MCP_HARNESS_PACKAGE must be an npm package specifier, not an option.");
  }

  return {
    command,
    args: ["--yes", `--package=${harnessPackage}`, "--", "dsh", "web", "--port", "0"],
    cwd: input.workspace,
    env: {
      ...env,
      DSH_CWD: input.workspace,
      DSH_HOME: input.serviceHome,
      DSH_PERMISSION_MODE: env.DSH_PERMISSION_MODE?.trim() || "workspace-write",
      DSH_TELEMETRY_DISABLED: env.DSH_TELEMETRY_DISABLED?.trim() || "1",
      NO_COLOR: "1",
      npm_config_yes: "true",
    },
  };
}

/** Returns local prerequisites without making a network request. */
export function inspectRuntime(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const mode = resolveMode(env);
  if (mode === "desktop-attach") {
    const supported = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22;
    return { ready: false, mode, nodeVersion: process.versions.node, nodeSupported: supported, platform: process.platform, architecture: process.arch, dataDirectory: resolveDataDirectory(env), directoryScope: "per-call proposal plus trusted Codex transport metadata", globalRootsAreAuthority: false, desktopPolicyEnforcement: "requires per-call native bridge preflight", surface: "desktop", authentication: "explicit connect_desktop; memory-only API Cookie", interactions: "none", permissionMode: "workspace-write", managedFallback: false };
  }
  const command = env.DSH_MCP_NPX_COMMAND?.trim() || (process.platform === "win32" ? "npx.cmd" : "npx");
  const probe = spawnSync(command, ["--version"], { encoding: "utf8", shell: false, timeout: 5_000 });
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

  return {
    ready: nodeMajor >= 22 && probe.status === 0,
    mode,
    nodeVersion: process.versions.node,
    nodeSupported: nodeMajor >= 22,
    platform: process.platform,
    architecture: process.arch,
    npxCommand: command,
    npxAvailable: probe.status === 0,
    npxVersion: probe.status === 0 ? probe.stdout.trim() : null,
    harnessPackage: env.DSH_MCP_HARNESS_PACKAGE?.trim() || DEFAULT_HARNESS_PACKAGE,
    apiKeyInEnvironment: Boolean(env.DEEPSEEK_API_KEY?.trim()),
    dataDirectory: resolveDataDirectory(env),
    allowedWorkspaceRoots: resolveAllowedRoots(env),
    surface: "web",
  };
}
