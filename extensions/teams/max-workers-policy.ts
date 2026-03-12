import { sanitizeName } from "./names.js";
import type { TeamConfig } from "./team-config.js";

export interface MaxWorkersPolicyResult {
	ok: boolean;
	limit: number | null;
	activeWorkers: string[];
	error?: string;
}

export function getMaxWorkersLimit(env: NodeJS.ProcessEnv = process.env): number | null {
	const raw = env.PI_TEAMS_MAX_WORKERS?.trim();
	if (!raw) return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return Math.floor(parsed);
}

export function getOnlineWorkerNames(opts: {
	teammates: ReadonlyMap<string, unknown>;
	teamConfig: TeamConfig | null;
}): string[] {
	const names = new Set<string>();
	for (const name of opts.teammates.keys()) {
		const safeName = sanitizeName(name);
		if (safeName) names.add(safeName);
	}

	for (const member of opts.teamConfig?.members ?? []) {
		if (member.role !== "worker") continue;
		if (member.status !== "online") continue;
		const safeName = sanitizeName(member.name);
		if (safeName) names.add(safeName);
	}

	return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function evaluateMaxWorkersPolicy(opts: {
	name: string;
	teammates: ReadonlyMap<string, unknown>;
	teamConfig: TeamConfig | null;
	env?: NodeJS.ProcessEnv;
}): MaxWorkersPolicyResult {
	const limit = getMaxWorkersLimit(opts.env);
	const activeWorkers = getOnlineWorkerNames({ teammates: opts.teammates, teamConfig: opts.teamConfig });
	if (limit === null) return { ok: true, limit, activeWorkers };

	const safeName = sanitizeName(opts.name);
	if (!safeName) {
		return {
			ok: false,
			limit,
			activeWorkers,
			error: "Missing worker name",
		};
	}

	if (activeWorkers.includes(safeName)) {
		return { ok: true, limit, activeWorkers };
	}

	if (activeWorkers.length < limit) {
		return { ok: true, limit, activeWorkers };
	}

	return {
		ok: false,
		limit,
		activeWorkers,
		error: `Max workers limit reached (${activeWorkers.length}/${limit}). Set PI_TEAMS_MAX_WORKERS=0 to disable or raise the limit.`,
	};
}
