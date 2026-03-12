import { spawn } from "node:child_process";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import { scheduleProcessTermination } from "./process-control.js";

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TeammateStatus = "starting" | "idle" | "streaming" | "stopped" | "error";

type RpcCommand =
	| { id: string; type: "prompt"; message: string }
	| { id: string; type: "steer"; message: string }
	| { id: string; type: "follow_up"; message: string }
	| { id: string; type: "abort" }
	| { id: string; type: "get_state" }
	| { id: string; type: "set_session_name"; name: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type RpcCommandWithoutId = DistributiveOmit<RpcCommand, "id">;

type RpcResponse = {
	id?: string;
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function safeParseJsonLine(line: string): unknown | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function isRpcResponse(v: unknown): v is RpcResponse {
	if (!isRecord(v)) return false;
	if (v.type !== "response") return false;
	if (typeof v.command !== "string") return false;
	if (typeof v.success !== "boolean") return false;
	if (v.id !== undefined && typeof v.id !== "string") return false;
	if (v.error !== undefined && typeof v.error !== "string") return false;
	return true;
}

function isAgentEvent(v: unknown): v is AgentEvent {
	if (!isRecord(v)) return false;
	if (typeof v.type !== "string") return false;

	// Validate the minimal shapes we actually dereference below.
	if (v.type === "message_update") {
		const ame = v.assistantMessageEvent;
		if (!isRecord(ame)) return false;
		if (typeof ame.type !== "string") return false;
		if (ame.type === "text_delta" && typeof ame.delta !== "string") return false;
		return true;
	}

	if (v.type === "tool_execution_start" || v.type === "tool_execution_update" || v.type === "tool_execution_end") {
		if (typeof v.toolCallId !== "string") return false;
		if (typeof v.toolName !== "string") return false;
		return true;
	}

	return (
		v.type === "agent_start" ||
		v.type === "agent_end" ||
		v.type === "turn_start" ||
		v.type === "turn_end" ||
		v.type === "message_start" ||
		v.type === "message_end"
	);
}

export class TeammateRpc {
	readonly name: string;
	readonly sessionFile?: string;

	status: TeammateStatus = "starting";
	lastAssistantText = "";
	lastError: string | null = null;

	/** Task currently assigned by the team lead (if any). */
	currentTaskId: string | null = null;

	private proc: ReturnType<typeof spawn> | null = null;
	private pending = new Map<string, { resolve: (v: RpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 0;
	private buffer = "";
	private stderr = "";
	private eventListeners: Array<(ev: AgentEvent) => void> = [];
	private closeListeners: Array<(code: number | null) => void> = [];

	constructor(name: string, sessionFile?: string) {
		this.name = name;
		this.sessionFile = sessionFile;
	}

	onEvent(listener: (ev: AgentEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			const idx = this.eventListeners.indexOf(listener);
			if (idx >= 0) this.eventListeners.splice(idx, 1);
		};
	}

	onClose(listener: (code: number | null) => void): () => void {
		this.closeListeners.push(listener);
		return () => {
			const idx = this.closeListeners.indexOf(listener);
			if (idx >= 0) this.closeListeners.splice(idx, 1);
		};
	}

	getStderr(): string {
		return this.stderr;
	}

	async start(opts: { cwd: string; env: Record<string, string>; args: string[] }): Promise<void> {
		if (this.proc) throw new Error("Teammate already started");
		const startupTimeoutMs = parsePositiveInt(opts.env.PI_TEAMS_RPC_START_TIMEOUT_MS, 10_000);

		this.proc = spawn("pi", ["--mode", "rpc", ...opts.args], {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.on("error", (err) => {
			this.status = "error";
			this.lastError = String(err);
			for (const [id, p] of this.pending.entries()) {
				p.reject(new Error(`Process error before response (id=${id}): ${String(err)}`));
			}
			this.pending.clear();
		});

		this.proc.stderr?.on("data", (d) => {
			this.stderr += d.toString();
		});

		this.proc.stdout?.on("data", (d) => {
			this.buffer += d.toString();
			let idx: number;
			while ((idx = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, idx);
				this.buffer = this.buffer.slice(idx + 1);
				this.handleLine(line);
			}
		});

		this.proc.on("close", (code) => {
			this.status = code === 0 ? "stopped" : "error";
			if (code !== 0) this.lastError = `Teammate process exited with code ${code}`;
			for (const [id, p] of this.pending.entries()) {
				p.reject(new Error(`Process exited before response (id=${id})`));
			}
			this.pending.clear();
			for (const l of this.closeListeners) l(code);
		});

		try {
			await this.send({ type: "get_state" }, startupTimeoutMs);
			this.status = "idle";
		} catch (err) {
			this.status = "error";
			this.lastError = err instanceof Error ? err.message : String(err);
			const proc = this.proc;
			if (proc) scheduleProcessTermination(proc);
			this.proc = null;
			throw new Error(`Teammate RPC ready handshake failed for ${this.name}: ${this.lastError}`);
		}
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;

		// Best-effort cooperative abort, but do not let an unresponsive RPC child delay
		// process termination for the full request timeout.
		try {
			await Promise.race([this.abort().catch(() => undefined), sleep(500)]);
		} catch {
			// ignore
		}

		scheduleProcessTermination(proc);
		this.proc = null;
		this.status = "stopped";
	}

	async prompt(message: string): Promise<void> {
		await this.send({ type: "prompt", message });
	}

	async steer(message: string): Promise<void> {
		await this.send({ type: "steer", message });
	}

	async followUp(message: string): Promise<void> {
		await this.send({ type: "follow_up", message });
	}

	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	async getState(): Promise<unknown> {
		const resp = await this.send({ type: "get_state" });
		return resp.data;
	}

	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	private handleLine(line: string) {
		if (!line.trim()) return;
		const obj = safeParseJsonLine(line);
		if (obj === null) return;

		// Response
		if (isRpcResponse(obj)) {
			if (typeof obj.id !== "string") return;
			const pending = this.pending.get(obj.id);
			if (!pending) return;
			this.pending.delete(obj.id);
			pending.resolve(obj);
			return;
		}

		// Agent event
		if (!isAgentEvent(obj)) return;
		const ev = obj;
		if (ev.type === "agent_start") {
			this.status = "streaming";
			this.lastAssistantText = "";
		}
		if (ev.type === "agent_end") {
			this.status = "idle";
		}
		if (ev.type === "message_update") {
			const ame = ev.assistantMessageEvent;
			if (ame.type === "text_delta") {
				this.lastAssistantText += ame.delta;
			}
		}

		for (const l of this.eventListeners) l(ev);
	}

	private async send(cmd: RpcCommandWithoutId, timeoutMs = 60_000): Promise<RpcResponse> {
		if (!this.proc || !this.proc.stdin) throw new Error("Teammate is not running");
		const id = `req-${this.name}-${this.nextId++}`;
		const full = { id, ...cmd } satisfies RpcCommand;

		const payload = JSON.stringify(full) + "\n";
		this.proc.stdin.write(payload);

		return await new Promise<RpcResponse>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			setTimeout(() => {
				if (!this.pending.has(id)) return;
				this.pending.delete(id);
				reject(new Error(`Timeout waiting for response (id=${id}, cmd=${full.type})`));
			}, timeoutMs);
		});
	}
}
