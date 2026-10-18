import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { DesktopAttachManager } from "../src/desktop-manager.js";
import { createMcpServer } from "../src/server.js";
import { desktopHost } from "./fixtures/desktop-host.js";

describe("Desktop MCP entry", () => {
  it("reports missing authorization, then accepts an explicitly supplied file without submitting a task", async () => {
    const host = await desktopHost();
    const root = await mkdtemp(join(tmpdir(), "desktop-mcp-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const file = join(root, "authorized.txt"); await writeFile(file, host.connectUrl, { mode: 0o600 });
    const manager = new DesktopAttachManager({ dataDirectory: join(root, "state"), allowedRoots: [workspace] });
    const server = createMcpServer(manager);
    const client = new Client({ name: "synthetic-desktop-client", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(right), client.connect(left)]);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["connect_desktop", "read_session", "get_run_events", "get_run_control", "list_models", "select_model"]));
      expect(client.getServerCapabilities()?.experimental).toMatchObject({ "codex/sandbox-state": {}, "codex/sandbox-state-meta": {} });
      const scope = { workspace, accessScope: { readRoots: [workspace], writeRoots: [workspace] } };
      const metadata = { threadId: "synthetic-agent", sessionId: "synthetic-session", "codex/sandbox-state": { permissionProfile: { opaqueSyntheticPolicy: true }, sandboxCwd: "file:///synthetic" } };
      const untrusted = await client.callTool({ name: "inspect_access_scope", arguments: { ...scope, _meta: metadata } });
      expect(untrusted.isError).toBe(true);
      const preflight = await client.callTool({ name: "inspect_access_scope", arguments: scope, _meta: metadata });
      expect(preflight.structuredContent).toMatchObject({ callerContextReceived: true, canDispatch: false, globalRootsAreAuthority: false });
      const blocked = await client.callTool({ name: "start_run", arguments: { ...scope, task: "must not dispatch" }, _meta: metadata });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain("Desktop cannot apply");
      expect(host.requests).toHaveLength(0);
      const doctor = await client.callTool({ name: "doctor", arguments: {} });
      expect(doctor.structuredContent).toMatchObject({ mode: "desktop-attach", ready: false, managedFallback: false, desktop: { connected: false, interactions: "none" } });
      expect(host.connections).toHaveLength(0);
      const connected = await client.callTool({ name: "connect_desktop", arguments: { connectionFile: file } });
      expect(connected.structuredContent).toMatchObject({ connected: true, interactions: "none", guiUrl: "dsh://open" });
      expect(JSON.stringify(connected)).not.toContain("synthetic-test-secret");
      expect(host.requests).toHaveLength(0);
      const connectedBlocked = await client.callTool({ name: "start_run", arguments: { ...scope, task: "must not dispatch while connected" }, _meta: metadata });
      expect(connectedBlocked.isError).toBe(true);
      expect(JSON.stringify(connectedBlocked)).toContain("Desktop cannot apply");
      expect(host.requests).toHaveLength(0);
    } finally { await client.close(); await server.close(); await manager.close(); await host.close(); await rm(root, { recursive: true, force: true }); }
  });
});
