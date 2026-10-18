// Packaging check: run only the built file in a directory without node_modules.
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const directory = await mkdtemp(join(tmpdir(), "desktop-bundle-"));
const binary = join(directory, "bundle.mjs");
await copyFile(new URL("../plugins/deepseek-harness/dist/bin.mjs", import.meta.url), binary);
const child = spawn(process.execPath, [binary], { cwd: directory, env: { ...process.env, DSH_MCP_MODE: "desktop-attach", DSH_MCP_WORKSPACE_ROOTS: "/synthetic/workspace" }, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk; });
const lines = createInterface({ input: child.stdout });
lines.on("line", line => { const value = JSON.parse(line); const waiter = pending.get(value.id); if (waiter) { pending.delete(value.id); waiter.resolve(value); } });
child.on("exit", code => { for (const waiter of pending.values()) waiter.reject(new Error(`bundle exited ${code}: ${stderr}`)); });
let nextId = 1;
async function rpc(method, params) {
  const id = nextId++;
  const result = new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  let timer;
  try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("bundle MCP timeout")), 10_000); })]); }
  finally { clearTimeout(timer); pending.delete(id); }
}
try {
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "synthetic-bundle-check", version: "1" } });
  assert.equal(initialized.result.serverInfo.version, "0.5.0-desktop.1");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const tools = await rpc("tools/list", {}); assert.equal(tools.result.tools.length, 17);
  const doctor = await rpc("tools/call", { name: "doctor", arguments: {} });
  assert.equal(doctor.result.structuredContent.mode, "desktop-attach");
  assert.equal(doctor.result.structuredContent.desktop.connected, false);
  assert.equal(doctor.result.structuredContent.managedFallback, false);
  console.log("Self-contained bundle MCP initialize, 17 tools, and unauthenticated doctor: passed. No Host or model contacted.");
} finally {
  child.kill("SIGTERM");
  await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref(); });
  lines.close(); await rm(directory, { recursive: true, force: true });
}
