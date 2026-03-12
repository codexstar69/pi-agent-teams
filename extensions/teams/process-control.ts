import { spawn, type ChildProcess } from "node:child_process";

export type ProcessTerminationStep =
	| { kind: "signal"; signal: NodeJS.Signals }
	| { kind: "exec"; cmd: string; args: string[] };

export interface ProcessTerminationPlan {
	graceful: ProcessTerminationStep | null;
	force: ProcessTerminationStep | null;
	forceAfterMs: number;
}

function isExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export function createProcessTerminationPlan(opts: {
	platform?: NodeJS.Platform;
	pid?: number | null;
	forceAfterMs?: number;
}): ProcessTerminationPlan {
	const platform = opts.platform ?? process.platform;
	const pid = opts.pid ?? null;
	const forceAfterMs = Math.max(1, opts.forceAfterMs ?? 1_000);

	if (pid === null || !Number.isInteger(pid) || pid <= 0) {
		return { graceful: null, force: null, forceAfterMs };
	}

	if (platform === "win32") {
		return {
			graceful: { kind: "exec", cmd: "taskkill", args: ["/pid", String(pid), "/T"] },
			force: { kind: "exec", cmd: "taskkill", args: ["/pid", String(pid), "/T", "/F"] },
			forceAfterMs,
		};
	}

	return {
		graceful: { kind: "signal", signal: "SIGTERM" },
		force: { kind: "signal", signal: "SIGKILL" },
		forceAfterMs,
	};
}

export function runProcessTerminationStep(child: ChildProcess, step: ProcessTerminationStep | null): void {
	if (!step || isExited(child)) return;

	if (step.kind === "signal") {
		try {
			child.kill(step.signal);
		} catch {
			// ignore
		}
		return;
	}

	const killer = spawn(step.cmd, step.args, {
		stdio: "ignore",
		windowsHide: true,
	});
	killer.once("error", () => {
		try {
			child.kill();
		} catch {
			// ignore
		}
	});
}

export function scheduleProcessTermination(
	child: ChildProcess,
	opts: { platform?: NodeJS.Platform; forceAfterMs?: number } = {},
): NodeJS.Timeout | null {
	const plan = createProcessTerminationPlan({
		platform: opts.platform,
		pid: child.pid ?? null,
		forceAfterMs: opts.forceAfterMs,
	});

	runProcessTerminationStep(child, plan.graceful);
	if (!plan.force) return null;

	const timer = setTimeout(() => {
		if (isExited(child)) return;
		runProcessTerminationStep(child, plan.force);
	}, plan.forceAfterMs);
	child.once("close", () => clearTimeout(timer));
	return timer;
}
