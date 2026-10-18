import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inspectRuntime } from "./runtime.js";
import { RunManager } from "./run-manager.js";
import { DesktopAttachManager } from "./desktop-manager.js";
import { createRunManager } from "./manager.js";

const runIdSchema = z.string().uuid().describe("Run identifier returned by start_run.");
const serviceIdSchema = z.string().uuid().describe("Service identifier returned by start_service or start_run.");

function result(value: object) {
  const structuredContent: Record<string, unknown> = { ...value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

/** Creates the MCP tool surface over a local run manager. */
export function createMcpServer(manager: RunManager | DesktopAttachManager = createRunManager()): McpServer {
  const server = new McpServer(
    { name: "deepseek-harness-for-codex", version: "0.4.0-desktop.1" },
    {
      instructions:
        "Default desktop-attach mode connects only to an existing user-authorized Desktop Host. Show dsh://open and sessionId; that link focuses Desktop and does not select a session. Keep approvals in Desktop GUI. Never discover a private token, persist credentials, automatically replay a prompt, or fall back to launching DSH. managed-web is a separate explicit mode. Independently review changes. Only open a GUI on user request.",
    },
  );

  server.registerTool(
    "start_service",
    {
      title: "Start the local DeepSeek Harness Web UI",
      description: "In desktop-attach, verify the authorized existing Host and workspace without starting DSH. In explicit managed-web mode, start or reuse a local Web process.",
      inputSchema: {
        workspace: z.string().min(1).describe("Absolute repository path served by DeepSeek Harness."),
        openBrowser: z.boolean().default(false).describe("Open the Harness page after readiness. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.startService(input)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "open_service",
    {
      title: "Open the DeepSeek Harness page",
      description: "Open an already running Harness Web service in the user's default browser.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try { return result(await manager.openService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "list_services",
    {
      title: "List local DeepSeek Harness Web services",
      description: "List Web services started by the current MCP server and their visible URLs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ services: manager.listServices() }),
  );

  server.registerTool(
    "stop_service",
    {
      title: "Stop a DeepSeek Harness Web service",
      description: "Stop a managed Web process. In desktop-attach, disconnect only this MCP's API Peer; leave Desktop and its tasks running.",
      inputSchema: { serviceId: serviceIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try { return result(await manager.stopService(input.serviceId)); } catch (error) { return failure(error); }
    },
  );

  server.registerTool(
    "doctor",
    {
      title: "Check local DeepSeek Harness prerequisites",
      description: "Check Node, npx, runtime package, credentials visibility, data location, and workspace restrictions without downloading anything.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const runtime = inspectRuntime();
      if (manager instanceof DesktopAttachManager) {
        const connection = manager.connectionStatus();
        const roots = runtime.allowedWorkspaceRoots as string[];
        return result({ ...runtime, ready: Boolean(runtime.nodeSupported && connection.connected && roots.length), desktop: connection, missing: [...(connection.connected ? [] : ["user-approved connection file; call connect_desktop"]), ...(roots.length ? [] : ["DSH_MCP_WORKSPACE_ROOTS"])] });
      }
      return result(runtime);
    },
  );

  server.registerTool(
    "start_run",
    {
      title: "Start a local DeepSeek Harness run",
      description: "Start or reuse the Harness Web UI, then create a new session or continue a completed session selected by Codex. Returns runId, sessionId, sessionReused, and webUrl.",
      inputSchema: {
        task: z.string().min(1).max(100_000).describe("Complete implementation task, constraints, and acceptance checks for DeepSeek Harness."),
        workspace: z.string().min(1).describe("Absolute path of the repository DeepSeek Harness may inspect and modify."),
        sessionId: z.string().min(1).optional().describe("Completed Harness session to continue. Pass a sessionId returned by an earlier run in this workspace, or omit it to create a new session."),
        openBrowser: z.boolean().default(false).describe("Open the live Harness Web page. Keep false unless the user explicitly requested it."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return result(await manager.start(input));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_run",
    {
      title: "Read a DeepSeek Harness run",
      description: "Read the current state and assistant response from the same Harness Web session shown to the user.",
      inputSchema: {
        runId: runIdSchema,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.get(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "wait_run",
    {
      title: "Wait for DeepSeek Harness output",
      description: "Poll the visible Harness Web session for up to 30 seconds and return its current status and assistant response.",
      inputSchema: {
        runId: runIdSchema,
        timeoutMs: z.number().int().min(0).max(30_000).default(30_000),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.wait(input.runId, input.timeoutMs));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "list_runs",
    {
      title: "List local DeepSeek Harness runs",
      description: "List runs started by the current MCP server process, including session IDs Codex may choose to continue in a later start_run call.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => result({ runs: await manager.list() }),
  );

  server.registerTool(
    "cancel_run",
    {
      title: "Cancel a local DeepSeek Harness run",
      description: "Cancel the agent turn in its visible Web session while keeping the Harness Web UI running.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return result(await manager.cancel(input.runId));
      } catch (error) {
        return failure(error);
      }
    },
  );

  if (manager instanceof DesktopAttachManager) {
    server.registerTool("connect_desktop", {
      title: "Connect to an authorized existing Desktop Host",
      description: "Read one connection file explicitly provided and approved by the human user. Exchange its loopback /connect URL for a memory-only passive API Peer. Never search IPC, logs, environment, credentials, sessions, or databases for a token. This does not submit a model task.",
      inputSchema: { connectionFile: z.string().min(1).describe("Absolute path explicitly supplied by the user; contains one authorized /connect?token=... URL. Do not put the URL or token in chat or tool arguments.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async input => { try { return result(await manager.connectDesktop(input)); } catch (error) { return failure(error); } });
    const sessionInput = { workspace: z.string().min(1), sessionId: z.string().min(1) };
    server.registerTool("read_session", {
      title: "Read scoped Desktop history and status",
      description: "Read status and cold-safe paginated history for a delegated session in its authorized workspace. Does not send a prompt, resume a cold agent, or change a model.",
      inputSchema: sessionInput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => { try { return result(await manager.readSession(input)); } catch (error) { return failure(error); } });
    server.registerTool("get_run_events", {
      title: "Follow this Desktop run's live session",
      description: "Read a bounded snapshot and live frames from this run's /api/remote.mux session/follow stream. The Host may materialize its delegated session; no prompt is submitted and no approval is answered.",
      inputSchema: { runId: runIdSchema, timeoutMs: z.number().int().min(0).max(30_000).default(0) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => { try { return result(await manager.runEvents(input.runId, input.timeoutMs)); } catch (error) { return failure(error); } });
    server.registerTool("get_run_control", {
      title: "Read this run's live Desktop projections",
      description: "Read the control baseline over the authenticated mux and return only this delegated session's projection.",
      inputSchema: { runId: runIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => { try { return result(await manager.runControl(input.runId)); } catch (error) { return failure(error); } });
    server.registerTool("list_models", {
      title: "List models already available in Desktop",
      description: "Read Desktop's configured routable model catalog; providers may refresh their catalog. Does not copy credentials or submit a generation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => { try { return result({ catalog: await manager.modelCatalog() }); } catch (error) { return failure(error); } });
    server.registerTool("select_model", {
      title: "Explicitly select a Desktop session model",
      description: "Only on user request: select a model for an idle delegated session. Desktop also saves this selection as its new-session default. Never call this merely to attach or inspect a run.",
      inputSchema: { ...sessionInput, provider: z.string().min(1), model: z.string().min(1), reasoningEffort: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => { try { return result({ value: await manager.selectModel(input) }); } catch (error) { return failure(error); } });
  }
  return server;
}
