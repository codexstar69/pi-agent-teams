import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

function trimOrUndefined(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function getPiTestModelArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	const modelSpec = trimOrUndefined(env.PI_TEAMS_TEST_MODEL);
	const providerOverride = trimOrUndefined(env.PI_TEAMS_TEST_PROVIDER);
	const thinkingOverride = trimOrUndefined(env.PI_TEAMS_TEST_THINKING);
	const args: string[] = [];

	if (modelSpec) {
		const slashIdx = modelSpec.indexOf("/");
		if (slashIdx >= 0) {
			const provider = trimOrUndefined(modelSpec.slice(0, slashIdx));
			const modelId = trimOrUndefined(modelSpec.slice(slashIdx + 1));
			if (provider && modelId) {
				args.push("--provider", provider, "--model", modelId);
			}
		} else {
			if (providerOverride) args.push("--provider", providerOverride);
			args.push("--model", modelSpec);
		}
	}

	if (thinkingOverride) args.push("--thinking", thinkingOverride);
	return args;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export async function terminateAll(children: readonly ChildProcess[]): Promise<void> {
	for (const c of children) {
		try {
			c.kill("SIGTERM");
		} catch {
			// ignore
		}
	}

	// Give them a moment to flush + exit.
	const deadline = Date.now() + 10_000;
	for (const c of children) {
		while (c.exitCode === null && Date.now() < deadline) {
			await sleep(100);
		}
		if (c.exitCode === null) {
			try {
				c.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
	}
}

export function spawnTeamsWorkerRpc(opts: {
	cwd: string;
	entryPath: string;
	sessionsDir: string;
	teamId: string;
	taskListId: string;
	agentName: string;
	leadName: string;
	style: string;
	autoClaim: boolean;
	planRequired: boolean;
	systemAppend: string;
	logDir: string;
	extraEnv?: Record<string, string>;
}): ChildProcess {
	const {
		cwd,
		entryPath,
		sessionsDir,
		teamId,
		taskListId,
		agentName,
		leadName,
		style,
		autoClaim,
		planRequired,
		systemAppend,
		logDir,
		extraEnv,
	} = opts;

	fs.mkdirSync(logDir, { recursive: true });
	fs.mkdirSync(sessionsDir, { recursive: true });

	const sessionFile = path.join(sessionsDir, `${agentName}.jsonl`);
	fs.closeSync(fs.openSync(sessionFile, "a"));

	const logPath = path.join(logDir, `${agentName}.log`);
	const out = fs.openSync(logPath, "a");
	const err = fs.openSync(logPath, "a");

	const mergedEnv = {
		...process.env,
		...(extraEnv ?? {}),
	};

	const args = [
		"--mode",
		"rpc",
		"--session",
		sessionFile,
		"--session-dir",
		sessionsDir,
		...getPiTestModelArgs(mergedEnv),
		"--no-extensions",
		"-e",
		entryPath,
		"--append-system-prompt",
		systemAppend,
	];

	return spawn("pi", args, {
		cwd,
		env: {
			...mergedEnv,
			PI_TEAMS_WORKER: "1",
			PI_TEAMS_TEAM_ID: teamId,
			PI_TEAMS_TASK_LIST_ID: taskListId,
			PI_TEAMS_AGENT_NAME: agentName,
			PI_TEAMS_LEAD_NAME: leadName,
			PI_TEAMS_STYLE: style,
			PI_TEAMS_AUTO_CLAIM: autoClaim ? "1" : "0",
			PI_TEAMS_PLAN_REQUIRED: planRequired ? "1" : "0",
		},
		stdio: ["ignore", out, err],
	});
}
