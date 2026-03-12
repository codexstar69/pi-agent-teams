import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TeammateRpc } from "../extensions/teams/teammate-rpc.js";
import { getPiTestModelArgs } from "./lib/pi-workers.js";

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");

async function runHappyPath(): Promise<void> {
	const rpc = new TeammateRpc("handshake-test");
	try {
		await rpc.start({
			cwd: repoRoot,
			env: {
				PI_TEAMS_RPC_START_TIMEOUT_MS: "15000",
			},
			args: ["--no-session", "--no-tools", ...getPiTestModelArgs(), "--no-extensions", "-e", entryPath],
		});

		assert(rpc.status === "idle", `expected teammate status to be idle after ready handshake, got ${rpc.status}`);

		const state = await rpc.getState();
		assert(isRecord(state), `expected getState() to return an object, got ${JSON.stringify(state)}`);
		const sessionId = typeof state.sessionId === "string" ? state.sessionId : null;
		assert(
			typeof sessionId === "string" && sessionId.length > 0,
			`expected getState() payload to include sessionId, got ${JSON.stringify(state)}`,
		);
		const isStreaming = typeof state.isStreaming === "boolean" ? state.isStreaming : null;
		assert(isStreaming === false, `expected getState() payload to report isStreaming=false at ready time, got ${JSON.stringify(state)}`);
		const pendingMessageCount = typeof state.pendingMessageCount === "number" ? state.pendingMessageCount : null;
		assert(
			pendingMessageCount === 0,
			`expected getState() payload to report pendingMessageCount=0 at ready time, got ${JSON.stringify(state)}`,
		);

		await rpc.setSessionName("pi agent teams - handshake test");
	} finally {
		await rpc.stop();
	}
}

async function runFailurePath(): Promise<void> {
	const rpc = new TeammateRpc("handshake-fail");
	try {
		await rpc.start({
			cwd: process.cwd(),
			env: {
				PI_TEAMS_RPC_START_TIMEOUT_MS: "3000",
			},
			args: ["--help"],
		});
		throw new Error("expected ready handshake to fail when pi exits before responding");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		assert(message.includes("Teammate RPC ready handshake failed"), `expected handshake failure wrapper, got ${message}`);
		assert(
			message.includes("Process exited before response") || message.includes("Timeout waiting for response"),
			`expected failure detail to preserve the root startup failure, got ${message}`,
		);
		assert(rpc.status === "error", `expected teammate status to be error after handshake failure, got ${rpc.status}`);
		assert(
			typeof rpc.lastError === "string" &&
				(rpc.lastError.includes("Process exited before response") || rpc.lastError.includes("Timeout waiting for response")),
			`expected lastError to preserve the root startup failure, got ${JSON.stringify(rpc.lastError)}`,
		);
	} finally {
		await rpc.stop();
	}
}

await runHappyPath();
await runFailurePath();

console.log("PASS: integration rpc ready handshake test passed");
