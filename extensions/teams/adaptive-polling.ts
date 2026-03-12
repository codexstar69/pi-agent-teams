function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function areAdaptivePollingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_TEAMS_ADAPTIVE_POLLING === "1";
}

export function getWorkerPollDelayMs(opts: {
	env?: NodeJS.ProcessEnv;
	idleStreak: number;
	hasInboxActivity: boolean;
	hasPendingWork: boolean;
	hasRunningWork: boolean;
}): number {
	const env = opts.env ?? process.env;
	const activeDelayMs = parsePositiveInt(env.PI_TEAMS_WORKER_ACTIVE_POLL_MS, 450);
	if (!areAdaptivePollingEnabled(env)) return activeDelayMs;
	if (opts.hasInboxActivity || opts.hasPendingWork || opts.hasRunningWork) return activeDelayMs;

	const idleMaxMs = parsePositiveInt(env.PI_TEAMS_WORKER_IDLE_POLL_MAX_MS, 4_000);
	const streak = Math.max(1, opts.idleStreak);
	return Math.min(idleMaxMs, activeDelayMs * streak);
}

export function getLeaderRefreshPollDelayMs(opts: {
	env?: NodeJS.ProcessEnv;
	idleStreak: number;
	hasActiveTeamWork: boolean;
}): number {
	const env = opts.env ?? process.env;
	const activeDelayMs = parsePositiveInt(env.PI_TEAMS_LEADER_REFRESH_POLL_MS, 1_000);
	if (!areAdaptivePollingEnabled(env)) return activeDelayMs;
	if (opts.hasActiveTeamWork) return activeDelayMs;

	const idleBaseMs = parsePositiveInt(env.PI_TEAMS_LEADER_REFRESH_IDLE_STEP_MS, 500);
	const idleMaxMs = parsePositiveInt(env.PI_TEAMS_LEADER_REFRESH_IDLE_POLL_MAX_MS, 2_500);
	const streak = Math.max(1, opts.idleStreak);
	return Math.min(idleMaxMs, idleBaseMs * streak);
}

export function getLeaderInboxPollDelayMs(opts: {
	env?: NodeJS.ProcessEnv;
	idleStreak: number;
	hasActiveTeamWork: boolean;
}): number {
	const env = opts.env ?? process.env;
	const activeDelayMs = parsePositiveInt(env.PI_TEAMS_LEADER_INBOX_POLL_MS, 700);
	if (!areAdaptivePollingEnabled(env)) return activeDelayMs;
	if (opts.hasActiveTeamWork) return activeDelayMs;

	const idleBaseMs = parsePositiveInt(env.PI_TEAMS_LEADER_INBOX_IDLE_BASE_MS, 400);
	const idleStepMs = parsePositiveInt(env.PI_TEAMS_LEADER_INBOX_IDLE_STEP_MS, 200);
	const idleMaxMs = parsePositiveInt(env.PI_TEAMS_LEADER_INBOX_IDLE_POLL_MAX_MS, 1_600);
	const streak = Math.max(1, opts.idleStreak);
	return Math.min(idleMaxMs, idleBaseMs + idleStepMs * streak);
}
