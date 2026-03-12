import { randomUUID } from "node:crypto";

export interface WorkerHeartbeatConfig {
	intervalMs: number;
	staleMs: number;
	leaseDurationMs: number;
}

export type WorkerHeartbeatPhase = "idle" | "streaming" | "planning" | "shutdown";

export interface TaskLease {
	owner: string;
	token: string;
	acquiredAt: string;
	heartbeatAt: string;
	expiresAt: string;
}

export interface WorkerHeartbeatMeta {
	heartbeatAt: string;
	heartbeatPhase: WorkerHeartbeatPhase;
	currentTaskId?: string;
	leaseToken?: string;
	leaseExpiresAt?: string;
}

export interface HeartbeatFreshness {
	isStale: boolean;
	reason: "fresh" | "stale" | "missing" | "invalid";
	ageMs: number | null;
	lastSeenMs: number | null;
}

export interface TaskLeaseRecoveryDecision {
	recover: boolean;
	reason:
		| "no_lease"
		| "lease_active"
		| "lease_expired_owner_unknown"
		| "lease_expired_owner_fresh"
		| "lease_expired_and_owner_stale"
		| "lease_expired_invalid_owner_heartbeat";
}

export interface HeartbeatTrackedMember {
	name: string;
	role: "lead" | "worker";
	status: "online" | "offline";
	lastSeenAt?: string;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIsoMs(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function getWorkerHeartbeatConfig(env: NodeJS.ProcessEnv = process.env): WorkerHeartbeatConfig {
	const intervalMs = parsePositiveInt(env.PI_TEAMS_HEARTBEAT_INTERVAL_MS, 5_000);
	const staleMs = parsePositiveInt(env.PI_TEAMS_HEARTBEAT_STALE_MS, 30_000);
	const defaultLeaseDurationMs = Math.max(intervalMs * 3, 15_000);
	const leaseDurationMs = parsePositiveInt(env.PI_TEAMS_TASK_LEASE_DURATION_MS, defaultLeaseDurationMs);
	return { intervalMs, staleMs, leaseDurationMs };
}

export function assessWorkerHeartbeatFreshness(
	lastSeenAt: string | undefined,
	nowMs = Date.now(),
	staleMs = 30_000,
): HeartbeatFreshness {
	if (!lastSeenAt) {
		return { isStale: true, reason: "missing", ageMs: null, lastSeenMs: null };
	}

	const lastSeenMs = parseIsoMs(lastSeenAt);
	if (lastSeenMs === null) {
		return { isStale: true, reason: "invalid", ageMs: null, lastSeenMs: null };
	}

	const ageMs = Math.max(0, nowMs - lastSeenMs);
	return {
		isStale: ageMs > staleMs,
		reason: ageMs > staleMs ? "stale" : "fresh",
		ageMs,
		lastSeenMs,
	};
}

export function createTaskLease(
	owner: string,
	opts: { nowMs?: number; leaseDurationMs?: number; token?: string } = {},
): TaskLease {
	const nowMs = opts.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const leaseDurationMs = Math.max(1, opts.leaseDurationMs ?? 15_000);
	return {
		owner,
		token: opts.token ?? randomUUID(),
		acquiredAt: nowIso,
		heartbeatAt: nowIso,
		expiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
	};
}

export function refreshTaskLease(
	lease: TaskLease,
	owner: string,
	opts: { nowMs?: number; leaseDurationMs?: number } = {},
): TaskLease | null {
	if (lease.owner !== owner) return null;
	const nowMs = opts.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const leaseDurationMs = Math.max(1, opts.leaseDurationMs ?? 15_000);
	return {
		...lease,
		heartbeatAt: nowIso,
		expiresAt: new Date(nowMs + leaseDurationMs).toISOString(),
	};
}

export function buildWorkerHeartbeatMeta(opts: {
	phase: WorkerHeartbeatPhase;
	currentTaskId?: string;
	nowMs?: number;
	leaseToken?: string;
	leaseExpiresAt?: string;
}): WorkerHeartbeatMeta {
	const heartbeatAt = new Date(opts.nowMs ?? Date.now()).toISOString();
	return {
		heartbeatAt,
		heartbeatPhase: opts.phase,
		...(opts.currentTaskId ? { currentTaskId: opts.currentTaskId } : {}),
		...(opts.leaseToken ? { leaseToken: opts.leaseToken } : {}),
		...(opts.leaseExpiresAt ? { leaseExpiresAt: opts.leaseExpiresAt } : {}),
	};
}

export function applyTaskLeaseMetadata(
	metadata: Record<string, unknown> | undefined,
	lease: TaskLease,
): Record<string, unknown> {
	return {
		...(metadata ?? {}),
		taskLease: {
			owner: lease.owner,
			token: lease.token,
			acquiredAt: lease.acquiredAt,
			heartbeatAt: lease.heartbeatAt,
			expiresAt: lease.expiresAt,
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readTaskLeaseMetadata(metadata: Record<string, unknown> | undefined): TaskLease | null {
	const raw = metadata?.taskLease;
	if (!isRecord(raw)) return null;
	if (typeof raw.owner !== "string") return null;
	if (typeof raw.token !== "string") return null;
	if (typeof raw.acquiredAt !== "string") return null;
	if (typeof raw.heartbeatAt !== "string") return null;
	if (typeof raw.expiresAt !== "string") return null;
	return {
		owner: raw.owner,
		token: raw.token,
		acquiredAt: raw.acquiredAt,
		heartbeatAt: raw.heartbeatAt,
		expiresAt: raw.expiresAt,
	};
}

export function listStaleWorkerNames(
	members: ReadonlyArray<HeartbeatTrackedMember>,
	opts: { nowMs?: number; staleMs?: number } = {},
): string[] {
	const nowMs = opts.nowMs ?? Date.now();
	const staleMs = Math.max(1, opts.staleMs ?? 30_000);
	return members
		.filter((member) => member.role === "worker" && member.status === "online")
		.filter((member) => assessWorkerHeartbeatFreshness(member.lastSeenAt, nowMs, staleMs).isStale)
		.map((member) => member.name);
}

export function shouldRecoverLeasedTask(opts: {
	taskMetadata: Record<string, unknown> | undefined;
	ownerLastSeenAt?: string;
	nowMs?: number;
	heartbeatStaleMs?: number;
}): TaskLeaseRecoveryDecision {
	const lease = readTaskLeaseMetadata(opts.taskMetadata);
	if (!lease) return { recover: false, reason: "no_lease" };

	const nowMs = opts.nowMs ?? Date.now();
	const heartbeatStaleMs = Math.max(1, opts.heartbeatStaleMs ?? 30_000);
	const expiresAtMs = parseIsoMs(lease.expiresAt);
	if (expiresAtMs !== null && expiresAtMs > nowMs) {
		return { recover: false, reason: "lease_active" };
	}

	const freshness = assessWorkerHeartbeatFreshness(opts.ownerLastSeenAt, nowMs, heartbeatStaleMs);
	if (freshness.reason === "missing") {
		return { recover: true, reason: "lease_expired_owner_unknown" };
	}
	if (freshness.reason === "invalid") {
		return { recover: true, reason: "lease_expired_invalid_owner_heartbeat" };
	}
	if (!freshness.isStale) {
		return { recover: false, reason: "lease_expired_owner_fresh" };
	}
	return { recover: true, reason: "lease_expired_and_owner_stale" };
}
