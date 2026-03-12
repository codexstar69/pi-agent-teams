import {
	applyTaskLeaseMetadata,
	assessWorkerHeartbeatFreshness,
	buildWorkerHeartbeatMeta,
	createTaskLease,
	getWorkerHeartbeatConfig,
	listStaleWorkerNames,
	readTaskLeaseMetadata,
	refreshTaskLease,
	shouldRecoverLeasedTask,
} from "../extensions/teams/heartbeat-lease.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`✓ ${label}`);
		return;
	}
	failed++;
	console.error(`✗ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string) {
	assert(
		actual === expected,
		`${label}${actual === expected ? "" : ` (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`}`,
	);
}

const config = getWorkerHeartbeatConfig({
	PI_TEAMS_HEARTBEAT_INTERVAL_MS: "4000",
	PI_TEAMS_HEARTBEAT_STALE_MS: "25000",
	PI_TEAMS_TASK_LEASE_DURATION_MS: "18000",
});
assertEq(config.intervalMs, 4000, "heartbeat config reads interval override");
assertEq(config.staleMs, 25000, "heartbeat config reads stale override");
assertEq(config.leaseDurationMs, 18000, "heartbeat config reads lease duration override");

const fallbackConfig = getWorkerHeartbeatConfig({ PI_TEAMS_HEARTBEAT_INTERVAL_MS: "bad" });
assertEq(fallbackConfig.intervalMs, 5000, "heartbeat config falls back on invalid interval");
assertEq(fallbackConfig.staleMs, 30000, "heartbeat config uses default stale threshold");
assertEq(fallbackConfig.leaseDurationMs, 15000, "heartbeat config derives default lease duration");

const heartbeatMeta = buildWorkerHeartbeatMeta({
	phase: "streaming",
	currentTaskId: "12",
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 0),
	leaseToken: "lease-a",
	leaseExpiresAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 15)).toISOString(),
});
assertEq(heartbeatMeta.heartbeatPhase, "streaming", "heartbeat meta records phase");
assertEq(heartbeatMeta.currentTaskId, "12", "heartbeat meta records current task id");
assertEq(heartbeatMeta.leaseToken, "lease-a", "heartbeat meta records lease token");

const fresh = assessWorkerHeartbeatFreshness(new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString(), Date.UTC(2026, 2, 12, 9, 0, 10), 15000);
assertEq(fresh.reason, "fresh", "recent heartbeat is fresh");
assert(!fresh.isStale, "recent heartbeat does not go stale");

const stale = assessWorkerHeartbeatFreshness(new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString(), Date.UTC(2026, 2, 12, 9, 0, 40), 15000);
assertEq(stale.reason, "stale", "old heartbeat is stale");
assert(stale.isStale, "old heartbeat is marked stale");

const missing = assessWorkerHeartbeatFreshness(undefined, Date.UTC(2026, 2, 12, 9, 0, 40), 15000);
assertEq(missing.reason, "missing", "missing heartbeat reports missing reason");
assert(missing.isStale, "missing heartbeat is treated as stale for recovery decisions");

const staleWorkers = listStaleWorkerNames(
	[
		{ name: "alice", role: "worker", status: "online", lastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString() },
		{ name: "bob", role: "worker", status: "online", lastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 20)).toISOString() },
		{ name: "chair", role: "lead", status: "online", lastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString() },
		{ name: "carol", role: "worker", status: "offline", lastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString() },
	],
	{ nowMs: Date.UTC(2026, 2, 12, 9, 0, 30), staleMs: 15000 },
);
assertEq(staleWorkers.join(","), "alice", "stale worker listing only returns online workers past freshness threshold");

const lease = createTaskLease("alice", {
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 0),
	leaseDurationMs: 12000,
	token: "lease-1",
});
assertEq(lease.owner, "alice", "task lease stores owner");
assertEq(lease.token, "lease-1", "task lease stores token");

const refreshedLease = refreshTaskLease(lease, "alice", {
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 5),
	leaseDurationMs: 12000,
});
assert(refreshedLease !== null, "matching owner can refresh lease");
assertEq(refreshedLease?.owner, "alice", "refresh preserves lease owner");
assertEq(refreshedLease?.expiresAt, new Date(Date.UTC(2026, 2, 12, 9, 0, 17)).toISOString(), "refresh extends lease expiration");
assertEq(refreshTaskLease(lease, "bob", { nowMs: Date.UTC(2026, 2, 12, 9, 0, 5) }), null, "different owner cannot refresh lease");

const metadata = applyTaskLeaseMetadata({}, lease);
const parsedLease = readTaskLeaseMetadata(metadata);
assert(parsedLease !== null, "task lease metadata round-trips");
assertEq(parsedLease?.owner, "alice", "parsed lease owner matches");
assertEq(parsedLease?.token, "lease-1", "parsed lease token matches");

const recoverActiveLease = shouldRecoverLeasedTask({
	taskMetadata: metadata,
	ownerLastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 8)).toISOString(),
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 9),
	heartbeatStaleMs: 15000,
});
assert(!recoverActiveLease.recover, "active lease does not trigger recovery");
assertEq(recoverActiveLease.reason, "lease_active", "active lease reports lease_active");

const recoverFreshOwner = shouldRecoverLeasedTask({
	taskMetadata: metadata,
	ownerLastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 18)).toISOString(),
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 20),
	heartbeatStaleMs: 15000,
});
assert(!recoverFreshOwner.recover, "expired lease with fresh owner heartbeat does not recover");
assertEq(recoverFreshOwner.reason, "lease_expired_owner_fresh", "expired lease with fresh owner reports owner fresh");

const recoverExpired = shouldRecoverLeasedTask({
	taskMetadata: metadata,
	ownerLastSeenAt: new Date(Date.UTC(2026, 2, 12, 9, 0, 0)).toISOString(),
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 20),
	heartbeatStaleMs: 15000,
});
assert(recoverExpired.recover, "expired lease plus stale owner triggers recovery");
assertEq(recoverExpired.reason, "lease_expired_and_owner_stale", "recovery reason explains stale owner");

const recoverNoLease = shouldRecoverLeasedTask({
	taskMetadata: {},
	ownerLastSeenAt: undefined,
	nowMs: Date.UTC(2026, 2, 12, 9, 0, 20),
	heartbeatStaleMs: 15000,
});
assert(!recoverNoLease.recover, "tasks without lease metadata are not auto-recovered by scaffold helper");
assertEq(recoverNoLease.reason, "no_lease", "missing lease metadata reports no_lease");

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}

console.log(`PASSED: ${passed}`);
