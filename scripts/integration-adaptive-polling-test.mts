import {
	areAdaptivePollingEnabled,
	getLeaderInboxPollDelayMs,
	getLeaderRefreshPollDelayMs,
	getWorkerPollDelayMs,
} from "../extensions/teams/adaptive-polling.js";

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

assert(!areAdaptivePollingEnabled({}), "adaptive polling remains opt-in by default");
assert(areAdaptivePollingEnabled({ PI_TEAMS_ADAPTIVE_POLLING: "1" }), "adaptive polling enables from env");

assertEq(
	getWorkerPollDelayMs({ env: {}, idleStreak: 6, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	450,
	"worker keeps legacy fast cadence when feature disabled",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 0, hasInboxActivity: true, hasPendingWork: false, hasRunningWork: false }),
	450,
	"worker stays fast when inbox activity is present",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 3, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	1350,
	"worker idle cadence backs off linearly from active delay",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1", PI_TEAMS_WORKER_IDLE_POLL_MAX_MS: "1200" }, idleStreak: 8, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	1200,
	"worker idle cadence respects configured ceiling",
);

assertEq(
	getLeaderRefreshPollDelayMs({ env: {}, idleStreak: 7, hasActiveTeamWork: false }),
	1000,
	"leader refresh stays legacy when feature disabled",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 0, hasActiveTeamWork: true }),
	1000,
	"leader refresh stays fast while team is active",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 4, hasActiveTeamWork: false }),
	2000,
	"leader refresh backs off while idle",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1", PI_TEAMS_LEADER_REFRESH_IDLE_POLL_MAX_MS: "1800" }, idleStreak: 9, hasActiveTeamWork: false }),
	1800,
	"leader refresh idle cadence respects configured max",
);

assertEq(
	getLeaderInboxPollDelayMs({ env: {}, idleStreak: 5, hasActiveTeamWork: false }),
	700,
	"leader inbox stays legacy when feature disabled",
);
assertEq(
	getLeaderInboxPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 0, hasActiveTeamWork: true }),
	700,
	"leader inbox stays fast while team is active",
);
assertEq(
	getLeaderInboxPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 3, hasActiveTeamWork: false }),
	1000,
	"leader inbox backs off while idle",
);
assertEq(
	getLeaderInboxPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1", PI_TEAMS_LEADER_INBOX_IDLE_POLL_MAX_MS: "900" }, idleStreak: 8, hasActiveTeamWork: false }),
	900,
	"leader inbox idle cadence respects configured max",
);

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}

console.log(`PASSED: ${passed}`);
