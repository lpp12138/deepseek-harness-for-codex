import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import type { CallerScopeBinding, CallerMetadata } from "../access-scope.js";

export interface NativeAuthority { state: Record<string, unknown>; launcher: string }
export type FileOperation = { kind: "ping" } | { kind: "read" | "list"; path: string } | { kind: "write"; path: string; text: string };
/** Only host transport metadata reaches this function; never tool arguments. */
export async function nativeAuthority(meta: CallerMetadata): Promise<NativeAuthority> {
  const state = meta?.["codex/sandbox-state"] ?? meta?.["codex/sandbox-state-meta"];
  const launcher = (meta?.["codex/sandbox-launcher"] as { codexExecutable?: unknown } | undefined)?.codexExecutable;
  const authority = { state, launcher } as NativeAuthority;
  await validateAuthority(authority);
  return authority;
}
export async function validateAuthority(value: NativeAuthority): Promise<void> {
  const state = value?.state;
  const profile = state?.permissionProfile as Record<string, any> | undefined;
  // Inspect enforcement discriminators only; never reconstruct the opaque policy.
  if (!profile || profile.type !== "managed" || profile.file_system?.type !== "restricted") throw new Error("Only native managed/restricted Codex policy is supported; disabled, external and unknown enforcement are refused.");
  if (typeof value.launcher !== "string" || !isAbsolute(value.launcher) || !(await stat(value.launcher)).isFile()) throw new Error("Missing host-verified absolute Codex sandbox launcher; no PATH lookup or unconfined fallback.");
}
const WORKER = String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
const chunks=[]; for await(const c of process.stdin) chunks.push(c);
const {scope,operation:op,protectedRoots=[]}=JSON.parse(Buffer.concat(chunks).toString());
const under=(root,target)=>{const r=path.relative(root,target); return r===''||(r!=='..'&&!r.startsWith('../')&&!path.isAbsolute(r));};
async function canonical(p){const abs=path.resolve(scope.workspace,p); try{return await fs.realpath(abs);}catch(e){if(e.code!=='ENOENT')throw e; const parent=path.dirname(abs); if(parent===abs)throw e; return path.join(await canonical(parent),path.basename(abs));}}
try{
 if(op.kind==='ping'){console.log(JSON.stringify({ok:true,value:{sandboxApplied:true}}));process.exit(0);}
 const target=await canonical(op.path);
 if(op.kind==='write'&&protectedRoots.some(root=>under(process.platform==='darwin'?root.toLowerCase():root,process.platform==='darwin'?target.toLowerCase():target)))throw Object.assign(new Error(),{code:'RUNTIME_CODE_PROTECTED'});
 const roots=op.kind==='write'?scope.writeRoots:[...scope.readRoots,...scope.writeRoots];
 if(!roots.some(root=>under(root,target)))throw Object.assign(new Error(),{code:'REQUESTED_SCOPE_DENIED'});
 let value;
 if(op.kind==='read'){const s=await fs.stat(target); if(!s.isFile()||s.size>65536)throw Object.assign(new Error(),{code:'FILE_SIZE_OR_TYPE'});value=await fs.readFile(target,'utf8');}
 else if(op.kind==='list'){value=(await fs.readdir(target,{withFileTypes:true})).slice(0,100).map(e=>({name:e.name,directory:e.isDirectory()}));}
 else if(op.kind==='write'){
  if(typeof op.text!=='string'||Buffer.byteLength(op.text)>65536)throw Object.assign(new Error(),{code:'FILE_SIZE_OR_TYPE'});
  const temporary=path.join(path.dirname(target),'.codex-bridge-'+process.pid+'-'+Date.now()+'.tmp');
  try{await fs.writeFile(temporary,op.text,{flag:'wx',mode:0o600});await fs.rename(temporary,target);}finally{await fs.unlink(temporary).catch(()=>{});}
  value={written:true};
 }else throw Object.assign(new Error(),{code:'UNSUPPORTED_OPERATION'});
 console.log(JSON.stringify({ok:true,value}));
}catch(e){console.log(JSON.stringify({ok:false,code:typeof e.code==='string'&&/^[A-Z_0-9]+$/.test(e.code)?e.code:'OPERATION_FAILED'}));}
`;
/** Every filesystem operation occurs in the native sandbox, including realpath/stat. */
export async function nativeFileOperation(authority: NativeAuthority, binding: CallerScopeBinding, operation: FileOperation, signal?: AbortSignal, protectedRoots: readonly string[] = []): Promise<unknown> {
  await validateAuthority(authority); signal?.throwIfAborted();
  const result = await new Promise<string>((resolve, reject) => {
    const child = spawn(authority.launcher, ["sandbox", "--sandbox-state-json", JSON.stringify(authority.state), "--", process.execPath, "--input-type=module", "-e", WORKER], {
      cwd: binding.canonical.workspace, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: homedir(), PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", TMPDIR: tmpdir(), LANG: "en_US.UTF-8", ...(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
    });
    let output = ""; let stderr = ""; let rejected = false;
    const stop = () => { try { if (child.pid) process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL"); } catch {} };
    const fail = (message: string) => { if (rejected) return; rejected = true; stop(); reject(new Error(message)); };
    const abort = () => fail("Codex native operation cancelled.");
    const timer = setTimeout(() => fail("Codex native operation timed out; no unconfined retry."), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", data => { output += String(data); if (output.length > 150_000) fail("Native operation exceeded output bound."); });
    // Never return launcher stderr: it can contain user-specific config diagnostics.
    child.stderr.on("data", data => { if (stderr.length < 4096) stderr += String(data).slice(0, 4096 - stderr.length); }); child.stdin.on("error", () => undefined);
    child.once("error", () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); fail("Verified Codex sandbox launcher could not start."); });
    child.once("close", code => { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (rejected) return; code === 0 ? resolve(output) : reject(Object.assign(new Error("Native Codex sandbox rejected the operation or failed to initialize; no fallback."), { code: /invalid --sandbox-state-json/.test(stderr) ? "POLICY_PARSE_REJECTED" : /sandbox_apply/.test(stderr) ? "SANDBOX_APPLY_FAILED" : /dyld/.test(stderr) ? "RUNTIME_LOADER_FAILED" : "NATIVE_PROCESS_FAILED" })); });
    child.stdin.end(JSON.stringify({ scope: binding.canonical, operation, protectedRoots }));
    if (signal?.aborted) abort();
  });
  let parsed: any;
  try { parsed = JSON.parse(result); } catch { throw new Error("Invalid native operation result."); }
  if (parsed.ok !== true) throw new Error(`Native file operation refused (${typeof parsed.code === "string" && /^[A-Z_0-9]+$/.test(parsed.code) ? parsed.code : "OPERATION_FAILED"}).`);
  return parsed.value;
}
