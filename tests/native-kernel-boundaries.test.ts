import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureMetadata, launcher } from "./fixtures/native-policy.js";

describe.skipIf(process.platform !== "darwin" || !existsSync(launcher))("Native kernel child and network boundaries", () => {
  it("keeps denied file access in a spawned child and refuses direct loopback network", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "native-kernel-"))); const work = join(root, "work"); const denied = join(root, "denied");
    await mkdir(work); await mkdir(denied); await writeFile(join(denied, "canary"), "SYNTHETIC_PRIVATE_CANARY");
    let connections = 0; const server = createServer(socket => { connections++; socket.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const port = (server.address() as { port: number }).port;
    try {
      const state = fixtureMetadata(work, denied)["codex/sandbox-state"];
      const code = `const {spawnSync}=require('node:child_process');const net=require('node:net');const [file,port]=process.argv.slice(1);const child=spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(5)}catch(e){console.log(e.code)}",file],{encoding:'utf8'});const result={childDenied:child.stdout.trim()==='EPERM',networkDenied:false};const socket=net.connect({host:'127.0.0.1',port:Number(port)});socket.on('error',e=>{result.networkDenied=e.code==='EPERM'||e.code==='EACCES';console.log(JSON.stringify(result));});socket.on('connect',()=>{socket.destroy();console.log(JSON.stringify(result));});socket.setTimeout(2000,()=>{socket.destroy();console.log(JSON.stringify(result));});`;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(launcher, ["sandbox", "--sandbox-state-json", JSON.stringify(state), "--", process.execPath, "-e", code, join(denied, "canary"), String(port)], { cwd: work, stdio: ["ignore", "pipe", "ignore"] });
        let stdout = ""; const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Synthetic kernel test timeout")); }, 10_000);
        child.stdout.on("data", c => { stdout += String(c); }); child.once("error", reject); child.once("close", exit => { clearTimeout(timer); exit === 0 ? resolve(stdout) : reject(new Error("Native kernel fixture failed")); });
      });
      expect(JSON.parse(output)).toEqual({ childDenied: true, networkDenied: true }); expect(connections).toBe(0);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
});
