import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { CallerScopeBinding } from "./access-scope.js";
import type { RunSnapshot } from "./types.js";

export interface DesktopRun extends RunSnapshot {
  mode: "desktop-attach";
  guiUrl: string;
  requestId: string;
  submissionState: "prepared" | "accepted" | "uncertain";
  callerScope?: CallerScopeBinding;
  startEventSeq: number;
  endEventSeq?: number;
}

/** Each run is one small atomic metadata file. Prompts, results and credentials stay out. */
export class DesktopStore {
  constructor(private readonly directory: string) {}
  async load(): Promise<DesktopRun[]> {
    await mkdir(join(this.directory, "desktop-runs"), { recursive: true, mode: 0o700 });
    const names = await readdir(join(this.directory, "desktop-runs"));
    const runs: DesktopRun[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const item = JSON.parse(await readFile(join(this.directory, "desktop-runs", name), "utf8"));
      if (item.schemaVersion !== 1 || item.mode !== "desktop-attach" || item.runId + ".json" !== name || typeof item.sessionId !== "string" || typeof item.requestId !== "string" || typeof item.workspace !== "string" || !Number.isSafeInteger(item.startEventSeq)) throw new Error("A stored Desktop run has unsupported metadata; preserve it and inspect the local state directory.");
      const { schemaVersion: _, ...record } = item;
      runs.push({ ...record, task: "", assistantText: "", error: null } as DesktopRun);
    }
    return runs;
  }
  async save(run: DesktopRun): Promise<void> {
    const { task: _task, assistantText: _text, error: _error, ...metadata } = run;
    const dir = join(this.directory, "desktop-runs");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `${run.runId}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...metadata }) + "\n"); } finally { await handle.close(); }
    try { await rename(temporary, join(dir, `${run.runId}.json`)); } finally { await unlink(temporary).catch(() => undefined); }
  }
  async acquire(workspace: string, sessionId: string, runId: string): Promise<() => Promise<void>> {
    const dir = join(this.directory, "desktop-locks");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const key = createHash("sha256").update(`${workspace}\0${sessionId}`).digest("hex");
    const path = join(dir, key + ".lock");
    const nonce = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, runId, nonce })); } finally { await handle.close(); }
        return async () => {
          try { if (JSON.parse(await readFile(path, "utf8")).nonce === nonce) await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const recoveryPath = path + ".recovery";
        let recovery;
        try { recovery = await open(recoveryPath, "wx", 0o600); } catch { throw new Error("Another MCP client controls this session."); }
        try {
          let owner: { pid?: number };
          try { owner = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Another MCP client is acquiring this session."); }
          let dead = false;
          if (Number.isSafeInteger(owner.pid) && owner.pid! > 0) {
            try { process.kill(owner.pid!, 0); } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
          }
          if (!dead) throw new Error("Another MCP client controls this session.");
          await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
        } finally { await recovery.close(); await unlink(recoveryPath).catch(() => undefined); }
      }
    }
    throw new Error("Another MCP client controls this session.");
  }
}
