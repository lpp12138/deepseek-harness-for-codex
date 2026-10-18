import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopClient, validateConnectUrl } from "../src/desktop-client.js";
import { desktopHost } from "./fixtures/desktop-host.js";

describe("Desktop 0.2.1-rc.2 transport", () => {
  let host: Awaited<ReturnType<typeof desktopHost>>;
  let client: DesktopClient;
  let dir: string;
  let file: string;
  beforeEach(async () => {
    host = await desktopHost(); client = new DesktopClient();
    dir = await mkdtemp(join(tmpdir(), "desktop-transport-")); file = join(dir, "approved-connection.txt");
    await writeFile(file, host.connectUrl, { mode: 0o600 });
  });
  afterEach(async () => { await client.close(); await host.close(); await rm(dir, { recursive: true, force: true }); });

  it("exchanges only a user-selected file, forces passive interactions, and returns no secret", async () => {
    const status = await client.connectFile(file);
    expect(status).toEqual({ connected: true, origin: host.origin, interactions: "none", guiUrl: "dsh://open" });
    expect(host.connections[0]?.searchParams.get("interactions")).toBe("none");
    expect(JSON.stringify(status)).not.toContain("synthetic-test-secret");
    expect(await readFile(file, "utf8")).toBe(host.connectUrl);
  });
  it("uses slash endpoints, payload.args, cookies, and matched RPC envelopes", async () => {
    await client.connectFile(file);
    await client.rpc("session/list", { _request: {} });
    const call = host.requests[0]!;
    expect(call.path).toBe("/api/session/list");
    expect(call.body).toMatchObject({ type: "client-request", method: "session/list", payload: { args: { _request: {} } } });
    expect(call.cookie).toMatch(/^synthetic_peer=/); expect(call.authorization).toBeUndefined();
  });
  it("opens the authenticated mux and reads typed control and follow frames", async () => {
    await client.connectFile(file);
    await client.rpc("session/create", { request: { cwd: "/synthetic" } });
    expect(await client.first("session/control", {})).toEqual({ type: "baseline", value: { projections: {} } });
    expect(await client.first("session/follow", { request: { address: { kind: "session", sessionId: "synthetic-1" } } })).toMatchObject({ type: "snapshot", cursor: -1 });
  });
  it("redacts authentication failure and never falls back to another server", async () => {
    host.rejectAuthentication();
    await expect(client.connectFile(file)).rejects.toThrow("Desktop authorization failed (HTTP 401)");
    expect(client.status().connected).toBe(false);
  });
  it("requires an approved file instead of taking credentials from ambient environment", async () => {
    await expect(client.rpc("session/list", { _request: {} })).rejects.toThrow("connect_desktop");
    expect(host.connections).toHaveLength(0);
  });
  it("invalidates the in-memory credential when its owning socket closes", async () => {
    await client.connectFile(file); host.disconnect();
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(client.rpc("session/list", { _request: {} })).rejects.toThrow("connect_desktop");
    expect(host.connections).toHaveLength(1);
  });
  it.each(["https://example.com/connect?token=x", "http://127.0.0.1.example.com/connect?token=x", "http://user:pass@127.0.0.1/connect?token=x", "http://127.0.0.1:1234/?token=x", "http://127.0.0.1:1234/connect?token=x&token=y", "http://127.0.0.1:1234/connect?token=x&interactions=answer"])("rejects nonlocal, malformed or answering connection input: %s", url => {
    expect(() => validateConnectUrl(url)).toThrow();
  });
});
