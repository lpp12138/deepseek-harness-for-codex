import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";

//#region src/access-scope.ts
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
function stable(value) {
	if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
	if (object(value)) return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
	return JSON.stringify(value) ?? "null";
}
const fingerprint = (value) => createHash("sha256").update(stable(value)).digest("hex");
/** Transport _meta only. Model arguments and roots/list never establish authority. */
function callerIdentity(meta) {
	const state = meta?.["codex/sandbox-state"] ?? meta?.["codex/sandbox-state-meta"];
	if (meta?.["codex/sandbox-state"] !== void 0 && meta["codex/sandbox-state-meta"] !== void 0 && stable(meta["codex/sandbox-state"]) !== stable(meta["codex/sandbox-state-meta"])) throw new Error("Codex supplied conflicting sandbox metadata aliases.");
	if (!meta || typeof meta.threadId !== "string" || !meta.threadId || typeof meta.sessionId !== "string" || !meta.sessionId || !object(state) || !object(state.permissionProfile)) throw new Error("Missing trusted caller context: Codex must supply threadId, sessionId and opaque sandbox policy in tool-call _meta. Model-declared paths and MCP roots are not permission grants.");
	return {
		callerFingerprint: fingerprint([meta.threadId, meta.sessionId]),
		policyFingerprint: fingerprint(state)
	};
}
async function directory(value) {
	if (typeof value !== "string" || !isAbsolute(value)) throw new Error("Scope paths and workspace must be absolute directories.");
	const canonical = await realpath(value);
	if (!(await stat(canonical)).isDirectory()) throw new Error("Scope paths and workspace must be directories.");
	return canonical;
}
function contains(root, path) {
	const child = relative(root, path);
	return child === "" || child !== ".." && !child.startsWith("../") && !isAbsolute(child);
}
async function normalizeScope(input) {
	const scope = input.accessScope;
	if (!scope || !Array.isArray(scope.readRoots) || !Array.isArray(scope.writeRoots) || scope.readRoots.length + scope.writeRoots.length > 128) throw new Error("Provide per-call accessScope.readRoots and accessScope.writeRoots (at most 128 directories). These are requested bounds, not authorization.");
	const [workspace, reads, writes] = await Promise.all([
		directory(input.workspace),
		Promise.all(scope.readRoots.map(directory)),
		Promise.all(scope.writeRoots.map(directory))
	]);
	const readRoots = [...new Set(reads)].sort();
	const writeRoots = [...new Set(writes)].sort();
	if (![...readRoots, ...writeRoots].some((root) => contains(root, workspace))) throw new Error("workspace is outside the requested directory scope.");
	return {
		workspace,
		readRoots,
		writeRoots
	};
}
/** No implementation claims enforcement by an already-running Desktop Host. */
var DesktopScopePolicy = class {
	async prepare(input, meta) {
		const identity = callerIdentity(meta);
		const canonical = await normalizeScope(input);
		return {
			...identity,
			scopeFingerprint: fingerprint(canonical),
			canonical,
			requested: {
				workspace: input.workspace,
				accessScope: {
					readRoots: [...input.accessScope.readRoots],
					writeRoots: [...input.accessScope.writeRoots]
				}
			}
		};
	}
	async inspect(input, meta) {
		return {
			callerContextReceived: true,
			canDispatch: false,
			desktopPolicyEnforcement: "unavailable",
			globalRootsAreAuthority: false,
			requestedScope: (await this.prepare(input, meta)).canonical,
			missing: "DSH execution-side support for the current caller's opaque Codex sandbox policy. Desktop 0.2.1-rc.2 session/create only accepts cwd, not per-caller read/write policy."
		};
	}
	async authorize(input, meta) {
		await this.prepare(input, meta);
		throw new Error("Desktop cannot apply the current caller's opaque Codex sandbox policy. No DSH session or task was submitted. Per-call paths, cwd, a prompt and global workspace roots cannot replace execution-side policy enforcement.");
	}
	owns(binding, meta) {
		if (!binding) return false;
		const identity = callerIdentity(meta);
		return identity.callerFingerprint === binding.callerFingerprint && identity.policyFingerprint === binding.policyFingerprint;
	}
	async verifyStored(binding, meta) {
		if (!binding) throw new Error("Session has no caller scope binding; legacy or foreign sessions cannot be adopted automatically.");
		const identity = callerIdentity(meta);
		if (identity.callerFingerprint !== binding.callerFingerprint) throw new Error("Session belongs to another caller.");
		if (identity.policyFingerprint !== binding.policyFingerprint) throw new Error("Caller policy changed; use a new scoped session after native enforcement is available.");
		if (fingerprint(await normalizeScope(binding.requested)) !== binding.scopeFingerprint) throw new Error("Scoped directory identity changed; do not reuse this session.");
	}
};

//#endregion
//#region src/dsh-bridge/native.ts
/** Only host transport metadata reaches this function; never tool arguments. */
async function nativeAuthority(meta) {
	const authority = {
		state: meta?.["codex/sandbox-state"] ?? meta?.["codex/sandbox-state-meta"],
		launcher: (meta?.["codex/sandbox-launcher"])?.codexExecutable
	};
	await validateAuthority(authority);
	return authority;
}
async function validateAuthority(value) {
	const profile = (value?.state)?.permissionProfile;
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
async function nativeFileOperation(authority, binding, operation, signal, protectedRoots = []) {
	await validateAuthority(authority);
	signal?.throwIfAborted();
	const result = await new Promise((resolve, reject) => {
		const child = spawn(authority.launcher, [
			"sandbox",
			"--sandbox-state-json",
			JSON.stringify(authority.state),
			"--",
			process.execPath,
			"--input-type=module",
			"-e",
			WORKER
		], {
			cwd: binding.canonical.workspace,
			shell: false,
			detached: process.platform !== "win32",
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				HOME: homedir(),
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
				TMPDIR: tmpdir(),
				LANG: "en_US.UTF-8",
				...process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1" ? { ELECTRON_RUN_AS_NODE: "1" } : {}
			}
		});
		let output = "";
		let stderr = "";
		let rejected = false;
		const stop = () => {
			try {
				if (child.pid) process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid, "SIGKILL");
			} catch {}
		};
		const fail = (message) => {
			if (rejected) return;
			rejected = true;
			stop();
			reject(new Error(message));
		};
		const abort = () => fail("Codex native operation cancelled.");
		const timer = setTimeout(() => fail("Codex native operation timed out; no unconfined retry."), 15e3);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (data) => {
			output += String(data);
			if (output.length > 15e4) fail("Native operation exceeded output bound.");
		});
		child.stderr.on("data", (data) => {
			if (stderr.length < 4096) stderr += String(data).slice(0, 4096 - stderr.length);
		});
		child.stdin.on("error", () => void 0);
		child.once("error", () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			fail("Verified Codex sandbox launcher could not start.");
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			if (rejected) return;
			code === 0 ? resolve(output) : reject(Object.assign(/* @__PURE__ */ new Error("Native Codex sandbox rejected the operation or failed to initialize; no fallback."), { code: /invalid --sandbox-state-json/.test(stderr) ? "POLICY_PARSE_REJECTED" : /sandbox_apply/.test(stderr) ? "SANDBOX_APPLY_FAILED" : /dyld/.test(stderr) ? "RUNTIME_LOADER_FAILED" : "NATIVE_PROCESS_FAILED" }));
		});
		child.stdin.end(JSON.stringify({
			scope: binding.canonical,
			operation,
			protectedRoots
		}));
		if (signal?.aborted) abort();
	});
	let parsed;
	try {
		parsed = JSON.parse(result);
	} catch {
		throw new Error("Invalid native operation result.");
	}
	if (parsed.ok !== true) throw new Error(`Native file operation refused (${typeof parsed.code === "string" && /^[A-Z_0-9]+$/.test(parsed.code) ? parsed.code : "OPERATION_FAILED"}).`);
	return parsed.value;
}

//#endregion
//#region src/dsh-bridge/plugin.ts
const PRESET = "codex-native-files";
const TOOLS = /* @__PURE__ */ new Set([
	"codex_read",
	"codex_write",
	"codex_list"
]);
const LEASE_MS = 9e4;
/** Host plugin: existing owner-authenticated Gateway, no listener or new credential. */
var CodexPolicyBridge = class extends TypertRemoteService {
	static inject = [
		"typert",
		"tools",
		"agents",
		"agentPresets",
		"agentDefaultModel",
		"workspaceRegistry",
		"sessionTitle"
	];
	entries = /* @__PURE__ */ new Map();
	policy = new DesktopScopePolicy();
	stopping = false;
	lastDiagnostic = null;
	protectedRoots = [];
	constructor(ctx) {
		super(ctx, "codexBridge");
		for (const method of [
			"status",
			"preflight",
			"create",
			"verify",
			"checkOperation"
		]) {
			const receiver = this;
			Remote(this[method], {
				kind: "method",
				name: method,
				static: false,
				private: false,
				access: {
					has: (value) => method in value,
					get: (value) => value[method]
				},
				addInitializer(initializer) {
					initializer.call(receiver);
				},
				metadata: {}
			});
		}
	}
	async *[Service.init]() {
		this.protectedRoots = await Promise.all([fileURLToPath(new URL("../", import.meta.url)), join(homedir(), ".dsh")].map((path) => realpath(path)));
		const host = this.ctx;
		const unregisterPreset = await host.agentPresets.register({
			id: PRESET,
			name: "Codex native files",
			description: "Caller-bound Codex sandbox; adapted file tools only",
			order: 900,
			plugins: []
		});
		const removeGuard = host.root.tools.guard((exec) => {
			if (!exec.agent || exec.agent.session.header.agentPreset !== "codex-native-files" && !this.entries.has(exec.agent.id)) return;
			const entry = this.entries.get(exec.agent.id);
			if (this.stopping || !entry || entry.agent !== exec.agent || entry.expires <= Date.now()) return "Codex caller binding missing or expired; no tool may execute.";
			if (!TOOLS.has(exec.name)) return "Tool is not adapted to the caller's Codex sandbox and is refused.";
		});
		yield async () => {
			this.stopping = true;
			for (const entry of this.entries.values()) {
				if (entry.timer) clearTimeout(entry.timer);
				entry.agent.cancel({ kind: "user" });
			}
			await Promise.all([...this.entries.values()].map((entry) => entry.handle?.dispose()));
			this.entries.clear();
			await unregisterPreset();
			removeGuard();
		};
	}
	status() {
		return {
			bridgeVersion: "0.1.0",
			preset: PRESET,
			tools: [...TOOLS],
			enforcement: "native-codex",
			supported: "managed/restricted filesystem policy; adapted file operations only",
			leaseMs: LEASE_MS,
			workerRuntime: {
				nodeVersion: process.versions.node,
				electronNodeMode: Boolean(process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1")
			},
			lastDiagnostic: this.lastDiagnostic
		};
	}
	async preflight(request) {
		try {
			if (this.stopping) throw new Error("Bridge is stopping.");
			const binding = await this.policy.prepare(request.input, request.metadata);
			const authority = await nativeAuthority(request.metadata);
			await nativeFileOperation(authority, binding, { kind: "ping" });
			return {
				canDispatch: true,
				bridgeVersion: "0.1.0",
				desktopPolicyEnforcement: "native-codex-files",
				callerContextReceived: true,
				globalRootsAreAuthority: false,
				requestedScope: binding.canonical,
				supportedTools: [...TOOLS],
				unsupportedTools: "all others, including shell, PTC and subagents"
			};
		} catch (error) {
			throw this.diagnostic("preflight", error);
		}
	}
	async create(request) {
		await this.preflight(request);
		const binding = await this.policy.prepare(request.input, request.metadata);
		const authority = await nativeAuthority(request.metadata);
		const host = this.ctx;
		const maxTokens = request.input.maxOutputTokens;
		if (maxTokens !== void 0 && (!Number.isSafeInteger(maxTokens) || maxTokens < 32 || maxTokens > 8192)) throw new Error("Invalid per-session output-token cap.");
		const sessionId = randomUUID();
		let entry;
		let stage = "agent-factory";
		try {
			const handle = await host.agents.create({
				sessionId,
				meta: {
					cwd: binding.canonical.workspace,
					agentPreset: PRESET
				},
				agentOptions: {
					...host.agentDefaultModel.currentSelection(),
					...maxTokens === void 0 ? {} : { maxTokens }
				},
				setup: async (agentCtx, agent) => {
					stage = "preset-mount";
					await host.agentPresets.mount(agentCtx, PRESET);
					stage = "tool-registration";
					agentCtx.tools.restrict({ allow: [] });
					agentCtx.tools.presentAs("native");
					entry = {
						metadata: request.metadata,
						binding,
						authority,
						agent,
						expires: 0
					};
					this.entries.set(sessionId, entry);
					this.renew(entry);
					this.registerFiles(agentCtx, entry);
				}
			});
			entry.handle = handle;
			stage = "gui-publication";
			host.sessionTitle.rename(handle.agent.session, `Codex task ${sessionId.slice(0, 8)}`);
			await (await host.workspaceRegistry.create(binding.canonical.workspace)).attachSession(sessionId);
			return {
				sessionId,
				preset: PRESET,
				enforcement: "native-codex-files",
				supportedTools: [...TOOLS]
			};
		} catch (error) {
			if (entry?.timer) clearTimeout(entry.timer);
			await entry?.handle?.dispose();
			this.entries.delete(sessionId);
			throw this.diagnostic(stage, error);
		}
	}
	async verify(request) {
		const entry = this.entries.get(request.sessionId ?? "");
		if (!entry) throw new Error("No live caller binding for this session. Host restart recovery requires a new scoped session; no automatic adoption.");
		if (entry.revoked) throw new Error("Caller binding was revoked; use a new scoped session.");
		const incoming = callerIdentity(request.metadata);
		if (incoming.callerFingerprint !== entry.binding.callerFingerprint) throw new Error("Session belongs to another caller.");
		if (incoming.policyFingerprint !== entry.binding.policyFingerprint) {
			entry.revoked = true;
			entry.expires = 0;
			entry.agent.cancel({ kind: "user" });
			throw new Error("Caller policy changed; old task cancelled. Use a new scoped session.");
		}
		try {
			await this.policy.verifyStored(entry.binding, request.metadata);
		} catch (error) {
			entry.revoked = true;
			entry.expires = 0;
			entry.agent.cancel({ kind: "user" });
			throw error;
		}
		if ((await this.policy.prepare(request.input, request.metadata)).scopeFingerprint !== entry.binding.scopeFingerprint) throw new Error("Directory scope changed; use a new scoped session.");
		if ((await nativeAuthority(request.metadata)).launcher !== entry.authority.launcher) {
			entry.revoked = true;
			entry.expires = 0;
			entry.agent.cancel({ kind: "user" });
			throw new Error("Caller sandbox launcher changed; use a new scoped session.");
		}
		this.renew(entry);
		return {
			verified: true,
			sessionId: request.sessionId,
			enforcement: "native-codex-files"
		};
	}
	/** Explicit owner diagnostic through the same tool pipeline; no model or arbitrary code. */
	async checkOperation(request) {
		await this.verify(request);
		const entry = this.entries.get(request.sessionId);
		if (entry.agent.status === "running") throw new Error("Cannot run a diagnostic during a model turn.");
		const operation = request.operation;
		const name = operation.kind === "read" ? "codex_read" : operation.kind === "write" ? "codex_write" : operation.kind === "list" ? "codex_list" : "unsupported_probe";
		const args = operation.kind === "ping" ? {} : {
			path: operation.path,
			...operation.kind === "write" ? { text: operation.text } : {}
		};
		const result = await entry.agent.ctx.tools.execute({
			callId: randomUUID(),
			name,
			arguments: args,
			agent: entry.agent,
			signal: new AbortController().signal
		});
		return {
			isError: result.isError === true,
			content: result.content,
			visibleTools: entry.agent.ctx.tools.schemas(entry.agent).map((tool) => tool.name)
		};
	}
	diagnostic(stage, error) {
		const value = error;
		const frames = String(value?.stack ?? "").split("\n").slice(1, 9).map((line) => line.match(/^\s*at ([\w.$<> ]+?)(?: \(|$)/)?.[1]).filter(Boolean);
		this.lastDiagnostic = {
			stage,
			name: /^[\w]+$/.test(value?.name ?? "") ? value.name : "Error",
			code: /^[A-Z_0-9]+$/.test(value?.code ?? "") ? value.code : null,
			frames
		};
		return new RemoteError("codex-bridge/" + stage, "Scoped execution bridge failed; inspect its bounded status diagnostic.", {});
	}
	renew(entry) {
		if (entry.timer) clearTimeout(entry.timer);
		entry.expires = Date.now() + LEASE_MS;
		entry.timer = setTimeout(() => {
			entry.expires = 0;
			entry.agent.cancel({ kind: "user" });
		}, LEASE_MS);
		entry.timer.unref();
	}
	registerFiles(ctx, entry) {
		for (const [name, kind, description] of [
			[
				"codex_read",
				"read",
				"Read up to 64 KiB of a UTF-8 file under this caller's native Codex sandbox and requested read bounds."
			],
			[
				"codex_write",
				"write",
				"Atomically write up to 64 KiB under this caller's native Codex sandbox and requested write bounds."
			],
			[
				"codex_list",
				"list",
				"List up to 100 entries under this caller's native Codex sandbox and requested read bounds."
			]
		]) ctx.tools.register(defineTool({
			name,
			description,
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "File/directory path relative to this session workspace, or absolute."
				},
				...kind === "write" ? { text: {
					type: "string",
					required: true,
					description: "Exact file contents."
				} } : {}
			},
			output: {
				schema: { type: "json" },
				render: (_args, value) => [{
					type: "text",
					text: typeof value === "string" ? value : JSON.stringify(value)
				}]
			},
			execute: async (args, exec) => {
				if (this.stopping || entry.expires <= Date.now() || this.entries.get(entry.agent.id) !== entry) throw new Error("Caller binding expired.");
				await this.policy.verifyStored(entry.binding, entry.metadata);
				return await nativeFileOperation(entry.authority, entry.binding, {
					kind,
					path: args.path,
					...kind === "write" ? { text: args.text } : {}
				}, exec.signal, this.protectedRoots);
			}
		}));
	}
};

//#endregion
export { CodexPolicyBridge, CodexPolicyBridge as default, PRESET };