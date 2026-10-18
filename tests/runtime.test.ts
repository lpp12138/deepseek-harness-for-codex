import { describe, expect, it } from "vitest";
import { buildHarnessWebCommand, inspectRuntime, resolveMode } from "../src/runtime.js";

describe("Harness Web command", () => {
  it("defaults to Desktop attachment without probing npx or ambient API credentials", () => {
    expect(resolveMode({})).toBe("desktop-attach");
    expect(inspectRuntime({ DSH_MCP_NPX_COMMAND: "must-not-run", DEEPSEEK_API_KEY: "synthetic-unrelated-key" })).toMatchObject({ mode: "desktop-attach", ready: false, managedFallback: false });
    expect(inspectRuntime({})).not.toHaveProperty("apiKeyInEnvironment");
    expect(resolveMode({ DSH_MCP_MODE: "managed-web" })).toBe("managed-web");
    expect(() => resolveMode({ DSH_MCP_MODE: "auto" })).toThrow("No fallback");
  });
  it("installs the Harness package explicitly before invoking its dsh executable", () => {
    const command = buildHarnessWebCommand(
      { workspace: "/workspace", serviceHome: "/data/service" },
      {
        DSH_MCP_NPX_COMMAND: "test-npx",
        DSH_MCP_HARNESS_PACKAGE: "@deepseek-ai/dsh@test-version",
      },
    );

    expect(command.command).toBe("test-npx");
    expect(command.args).toEqual([
      "--yes",
      "--package=@deepseek-ai/dsh@test-version",
      "--",
      "dsh",
      "web",
      "--port",
      "0",
    ]);
  });
});
