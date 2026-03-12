/**
 * Smoke test for pi-agent-teams extension primitives.
 *
 * Tests: fs-lock, mailbox, task-store, team-config, protocol parsers, names.
 * Does NOT require a running Pi session — exercises the library code directly.
 *
 * Usage:  npx tsx scripts/smoke-test.mts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// We import from .ts source (tsx handles it)
import { withLock } from "../extensions/teams/fs-lock.js";
import {
	writeToMailbox,
	popUnreadMessages,
	getInboxPath,
	compactMailboxMessages,
	getMailboxPruningConfig,
} from "../extensions/teams/mailbox.js";
import {
	createTask,
	listTasks,
	getTask,
	updateTask,
	completeTask,
	clearTasks,
	startAssignedTask,
	claimTask,
	claimNextAvailableTask,
	unassignTasksForAgent,
	formatTaskLine,
	addTaskDependency,
	removeTaskDependency,
	isTaskBlocked,
	markTaskRetryableFailure,
	isTaskCoolingDown,
	refreshTaskLeaseHeartbeat,
	recoverLeasedTaskIfStale,
	clearTaskStoreCache,
	getTaskPriority,
	getTaskPriorityRank,
	getTaskStoreCacheStats,
	getTaskListDir,
} from "../extensions/teams/task-store.js";
import { ensureTeamConfig, loadTeamConfig, upsertMember, setMemberStatus, updateTeamHooksPolicy } from "../extensions/teams/team-config.js";
import { sanitizeName } from "../extensions/teams/names.js";
import { appendTeamEvent, getTeamEventsLogPath, readRecentTeamEvents } from "../extensions/teams/event-log.js";
import { formatProviderModel, isDeprecatedTeammateModelId, resolveTeammateModelSelection } from "../extensions/teams/model-policy.js";
import { evaluateMaxWorkersPolicy, getMaxWorkersLimit, getOnlineWorkerNames } from "../extensions/teams/max-workers-policy.js";
import {
	areAdaptivePollingEnabled,
	getLeaderInboxPollDelayMs,
	getLeaderRefreshPollDelayMs,
	getWorkerPollDelayMs,
} from "../extensions/teams/adaptive-polling.js";
import { createDebouncedTrigger } from "../extensions/teams/debounce.js";
import { readTaskLeaseMetadata } from "../extensions/teams/heartbeat-lease.js";
import { getTeamsNamingRules, getTeamsStrings } from "../extensions/teams/teams-style.js";
import {
	getTeamsHookFailureAction,
	getTeamsHookFollowupOwnerPolicy,
	getTeamsHookMaxReopensPerTask,
	resolveTeamsHookFollowupOwner,
	runTeamsHook,
	shouldCreateHookFollowupTask,
	shouldReopenTaskOnHookFailure,
	resolveHookCommand,
	resolvePowerShellCommand,
} from "../extensions/teams/hooks.js";
import { listDiscoveredTeams } from "../extensions/teams/team-discovery.js";
import {
	acquireTeamAttachClaim,
	assessAttachClaimFreshness,
	heartbeatTeamAttachClaim,
	releaseTeamAttachClaim,
} from "../extensions/teams/team-attach-claim.js";
import { getTeamHelpText } from "../extensions/teams/leader-team-command.js";
import { buildTaskShowLines } from "../extensions/teams/leader-task-commands.js";
import { buildTeamEnvOutput } from "../extensions/teams/leader-info-commands.js";
import { createProcessTerminationPlan } from "../extensions/teams/process-control.js";
import {
	TEAM_MAILBOX_NS,
	isIdleNotification,
	isShutdownApproved,
	isShutdownRejected,
	isTaskAssignmentMessage,
	isShutdownRequestMessage,
	isSetSessionNameMessage,
	isPlanApprovalRequest,
	isPeerDmSent,
	isAbortRequestMessage,
	isPlanApprovedMessage,
	isPlanRejectedMessage,
} from "../extensions/teams/protocol.js";

// ── helpers ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
	if (condition) {
		passed++;
		console.log(`  ✓ ${label}`);
	} else {
		failed++;
		console.error(`  ✗ ${label}`);
	}
}

function assertEq(actual: unknown, expected: unknown, label: string) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		console.error(`    actual:   ${JSON.stringify(actual)}`);
		console.error(`    expected: ${JSON.stringify(expected)}`);
	}
	assert(ok, label);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-teams-smoke-"));
const teamDir = path.join(tmpRoot, "team-test");
const taskListId = "smoke-tl";

console.log(`\nSmoke test root: ${tmpRoot}\n`);

// ── 1. names ─────────────────────────────────────────────────────────
console.log("1. names.sanitizeName");
// sanitizeName replaces non-alnum/underscore/hyphen with hyphens, preserves case
assertEq(sanitizeName("Hello World!"), "Hello-World-", "non-alnum → hyphens");
assertEq(sanitizeName("agent_1"), "agent_1", "underscores kept");
assertEq(sanitizeName(""), "", "empty stays empty");
assertEq(sanitizeName("UPPER"), "UPPER", "case preserved");

// ── 1b. model policy ────────────────────────────────────────────────
console.log("\n1b. model-policy");
assert(isDeprecatedTeammateModelId("claude-sonnet-4"), "marks sonnet-4 alias as deprecated");
assert(
	isDeprecatedTeammateModelId("anthropic.claude-sonnet-4-20250514-v1:0"),
	"marks sonnet-4 dated/bedrock variants as deprecated",
);
assert(!isDeprecatedTeammateModelId("claude-sonnet-4-5"), "does not block sonnet-4-5");
assert(!isDeprecatedTeammateModelId("claude-sonnet-4.5"), "does not block sonnet-4.5");
assert(!isDeprecatedTeammateModelId("gpt-5.1-codex-mini"), "keeps current models allowed");

const modelResolvedExplicit = resolveTeammateModelSelection({
	modelOverride: "openai-codex/gpt-5.1-codex-mini",
	leaderProvider: "anthropic",
	leaderModelId: "claude-sonnet-4-5",
});
assert(modelResolvedExplicit.ok, "resolveTeammateModelSelection accepts provider/model override");
if (modelResolvedExplicit.ok) {
	assertEq(modelResolvedExplicit.value.source, "override", "explicit override source");
	assertEq(formatProviderModel(modelResolvedExplicit.value.provider, modelResolvedExplicit.value.modelId), "openai-codex/gpt-5.1-codex-mini", "explicit override keeps provider/model");
}

const modelResolvedModelOnly = resolveTeammateModelSelection({
	modelOverride: "gpt-5.1-codex-mini",
	leaderProvider: "openai-codex",
	leaderModelId: "gpt-5.1-codex-mini",
});
assert(modelResolvedModelOnly.ok, "resolveTeammateModelSelection accepts model-only override");
if (modelResolvedModelOnly.ok) {
	assertEq(formatProviderModel(modelResolvedModelOnly.value.provider, modelResolvedModelOnly.value.modelId), "openai-codex/gpt-5.1-codex-mini", "model-only override inherits leader provider");
}

const modelResolvedInvalid = resolveTeammateModelSelection({ modelOverride: "openai-codex/" });
assert(!modelResolvedInvalid.ok, "resolveTeammateModelSelection rejects invalid provider/model override");
if (!modelResolvedInvalid.ok) {
	assertEq(modelResolvedInvalid.reason, "invalid_override", "invalid override reason");
}

const modelResolvedDeprecated = resolveTeammateModelSelection({ modelOverride: "claude-sonnet-4" });
assert(!modelResolvedDeprecated.ok, "resolveTeammateModelSelection rejects deprecated override");
if (!modelResolvedDeprecated.ok) {
	assertEq(modelResolvedDeprecated.reason, "deprecated_override", "deprecated override reason");
}

const modelResolvedDeprecatedLeader = resolveTeammateModelSelection({
	leaderProvider: "anthropic",
	leaderModelId: "claude-sonnet-4-20250514",
});
assert(modelResolvedDeprecatedLeader.ok, "resolveTeammateModelSelection handles deprecated leader model fallback");
if (modelResolvedDeprecatedLeader.ok) {
	assertEq(modelResolvedDeprecatedLeader.value.source, "default", "deprecated leader model is not inherited");
	assertEq(formatProviderModel(modelResolvedDeprecatedLeader.value.provider, modelResolvedDeprecatedLeader.value.modelId), null, "deprecated leader fallback has no explicit model");
}

console.log("\n1c. max-workers-policy");
assertEq(getMaxWorkersLimit({}), null, "unset worker limit is disabled");
assertEq(getMaxWorkersLimit({ PI_TEAMS_MAX_WORKERS: "0" }), null, "zero worker limit disables policy");
assertEq(getMaxWorkersLimit({ PI_TEAMS_MAX_WORKERS: "-1" }), null, "negative worker limit disables policy");
assertEq(getMaxWorkersLimit({ PI_TEAMS_MAX_WORKERS: "2" }), 2, "positive worker limit parsed");

const workerNames = getOnlineWorkerNames({
	teammates: new Map([
		["alice", {}],
		["bob", {}],
	]),
	teamConfig: {
		version: 1,
		teamId: "team",
		taskListId: "task-list",
		leadName: "team-lead",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		members: [
			{ name: "team-lead", role: "lead", status: "online", addedAt: new Date().toISOString() },
			{ name: "alice", role: "worker", status: "online", addedAt: new Date().toISOString() },
			{ name: "carol", role: "worker", status: "online", addedAt: new Date().toISOString() },
			{ name: "dave", role: "worker", status: "offline", addedAt: new Date().toISOString() },
		],
	},
});
assertEq(workerNames.join(","), "alice,bob,carol", "online worker names union rpc and config workers");

const blockedSpawn = evaluateMaxWorkersPolicy({
	name: "zoe",
	teammates: new Map([
		["alice", {}],
		["bob", {}],
	]),
	teamConfig: null,
	env: { PI_TEAMS_MAX_WORKERS: "2" },
});
assertEq(blockedSpawn.limit, 2, "policy exposes configured limit");
assertEq(blockedSpawn.activeWorkers.length, 2, "policy reports active worker count");
assert(!blockedSpawn.ok, "policy blocks spawn once limit is reached");
if (!blockedSpawn.ok) {
	assert((blockedSpawn.error ?? "").includes("2/2"), "blocked policy error includes utilization");
	assert((blockedSpawn.error ?? "").includes("PI_TEAMS_MAX_WORKERS"), "blocked policy error explains override");
}

const allowedSpawn = evaluateMaxWorkersPolicy({
	name: "zoe",
	teammates: new Map([["alice", {}]]),
	teamConfig: null,
	env: { PI_TEAMS_MAX_WORKERS: "2" },
});
assert(allowedSpawn.ok, "policy allows spawn when below limit");

console.log("\n1d. adaptive-polling");
assert(!areAdaptivePollingEnabled({}), "adaptive polling disabled by default");
assert(areAdaptivePollingEnabled({ PI_TEAMS_ADAPTIVE_POLLING: "1" }), "adaptive polling opt-in env enables feature");
assertEq(
	getWorkerPollDelayMs({ env: {}, idleStreak: 9, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	450,
	"worker poll delay stays at legacy fast cadence when feature disabled",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 0, hasInboxActivity: true, hasPendingWork: false, hasRunningWork: false }),
	450,
	"worker poll delay stays fast after inbox activity",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 4, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	1800,
	"worker poll delay backs off after sustained idle",
);
assertEq(
	getWorkerPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 12, hasInboxActivity: false, hasPendingWork: false, hasRunningWork: false }),
	4000,
	"worker poll delay caps at configured idle ceiling",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: {}, idleStreak: 10, hasActiveTeamWork: false }),
	1000,
	"leader refresh delay stays legacy when feature disabled",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 0, hasActiveTeamWork: true }),
	1000,
	"leader refresh delay stays fast while team is active",
);
assertEq(
	getLeaderRefreshPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 5, hasActiveTeamWork: false }),
	2500,
	"leader refresh delay backs off while idle",
);
assertEq(
	getLeaderInboxPollDelayMs({ env: { PI_TEAMS_ADAPTIVE_POLLING: "1" }, idleStreak: 6, hasActiveTeamWork: false }),
	1600,
	"leader inbox delay backs off while idle",
);

console.log("\n1e. windows portability helpers");
{
	const envOutput = buildTeamEnvOutput({
		teamId: "team-123",
		taskListId: "tasks-123",
		leadName: "team-lead",
		style: "normal",
		teamsRoot: "/tmp/pi teams",
		teamDir: "/tmp/pi teams/team-123",
		agentName: "alice",
		autoClaim: "1",
		teamsEntry: "/repo/extensions/teams/index.ts",
		shellQuote: (value) => `'${value}'`,
	});
	assert(envOutput.includes("PowerShell (Windows):"), "team env output includes PowerShell instructions");
	assert(envOutput.includes("$env:PI_TEAMS_TEAM_ID = 'team-123'"), "team env output formats PowerShell env assignment");
	assert(envOutput.includes("POSIX shell (macOS/Linux):"), "team env output keeps POSIX instructions");

	assertEq(resolvePowerShellCommand({ platform: "win32" }), "powershell.exe", "Windows hook resolution uses powershell.exe by default");
	assertEq(resolvePowerShellCommand({ platform: "darwin" }), "pwsh", "non-Windows hook resolution prefers pwsh");
	assertEq(resolvePowerShellCommand({ platform: "win32", env: { PI_TEAMS_POWERSHELL: "C:/pwsh.exe" } }), "C:/pwsh.exe", "PowerShell command honors explicit override");

	const psHooksDir = path.join(tmpRoot, "ps-hooks");
	fs.mkdirSync(psHooksDir, { recursive: true });
	const psHookPath = path.join(psHooksDir, "on_task_completed.ps1");
	fs.writeFileSync(psHookPath, "Write-Output 'ok'\n", "utf8");
	const psHook = resolveHookCommand(psHooksDir, "task_completed", { platform: "win32" });
	assert(psHook !== null, "PowerShell hook resolves on Windows");
	assertEq(psHook?.cmd, "powershell.exe", "PowerShell hook uses powershell.exe command");
	assertEq(psHook?.args.at(-1), psHookPath, "PowerShell hook targets the .ps1 file");

	const winPlan = createProcessTerminationPlan({ platform: "win32", pid: 4242 });
	assertEq(winPlan.graceful?.kind, "exec", "Windows process termination uses taskkill for graceful step");
	assertEq(winPlan.force?.kind, "exec", "Windows process termination uses taskkill for force step");
	if (winPlan.force?.kind === "exec") {
		assertEq(winPlan.force.args.join(" "), "/pid 4242 /T /F", "Windows force termination kills process tree");
	}

	const posixPlan = createProcessTerminationPlan({ platform: "darwin", pid: 4242 });
	assertEq(posixPlan.graceful?.kind, "signal", "POSIX process termination uses signals for graceful step");
	if (posixPlan.graceful?.kind === "signal") {
		assertEq(posixPlan.graceful.signal, "SIGTERM", "POSIX graceful termination uses SIGTERM");
	}
	if (posixPlan.force?.kind === "signal") {
		assertEq(posixPlan.force.signal, "SIGKILL", "POSIX force termination uses SIGKILL");
	}
}

console.log("\n1f. debounce");
{
	let fireCount = 0;
	const trigger = createDebouncedTrigger(() => {
		fireCount += 1;
	}, 15);
	trigger();
	trigger();
	trigger();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assertEq(fireCount, 1, "debounced trigger coalesces multiple calls into one callback");

	trigger();
	trigger.cancel();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assertEq(fireCount, 1, "debounced trigger cancel prevents pending callback");
}

console.log("\n1f. event-log");
{
	const eventsLogPath = getTeamEventsLogPath(teamDir);
	assertEq(path.basename(eventsLogPath), "events.jsonl", "event log path uses events.jsonl filename");
	assert(eventsLogPath.includes(`${path.sep}logs${path.sep}`), "event log path is nested under team logs directory");

	await appendTeamEvent(teamDir, {
		ts: "2026-03-12T00:00:00.000Z",
		kind: "task_created",
		teamId: "team-a",
		taskId: "1",
		data: { subject: "first" },
	});
	await appendTeamEvent(teamDir, {
		ts: "2026-03-12T00:00:01.000Z",
		kind: "task_claimed",
		teamId: "team-a",
		member: "agent1",
		taskId: "1",
		data: { owner: "agent1" },
	});
	const allEvents = await readRecentTeamEvents(teamDir);
	assertEq(allEvents.length, 2, "event log reads appended events");
	assertEq(allEvents[0]?.kind, "task_created", "event log preserves append order");
	assertEq(allEvents[1]?.member, "agent1", "event log preserves event payload fields");

	const limitedEvents = await readRecentTeamEvents(teamDir, { limit: 1 });
	assertEq(limitedEvents.length, 1, "event log limit returns last N events");
	assertEq(limitedEvents[0]?.kind, "task_claimed", "event log limit keeps newest event");

	fs.appendFileSync(eventsLogPath, '{"ts":"2026-03-12T00:00:02.000Z","kind":"bad"}\nnot-json\n');
	const eventsAfterMalformed = await readRecentTeamEvents(teamDir);
	assertEq(eventsAfterMalformed.length, 3, "event log ignores malformed jsonl lines");
	assertEq(eventsAfterMalformed.at(-1)?.kind, "bad", "event log still reads valid lines after malformed data");
}

// ── 2. fs-lock ───────────────────────────────────────────────────────
console.log("\n2. fs-lock.withLock");
{
	const lockFile = path.join(tmpRoot, "test.lock");
	const result = await withLock(lockFile, async () => 42, { label: "smoke" });
	assertEq(result, 42, "withLock returns fn result");
	assert(!fs.existsSync(lockFile), "lock file cleaned up after");
}

{
	// Stale lock is removed.
	const lockFile = path.join(tmpRoot, "stale.lock");
	fs.writeFileSync(lockFile, "stale");
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lockFile, old, old);

	const result = await withLock(lockFile, async () => "ok", { staleMs: 1, timeoutMs: 500 });
	assertEq(result, "ok", "withLock removes stale lock file");
	assert(!fs.existsSync(lockFile), "stale lock cleaned up after");
}

{
	// Dead-owner lock is reclaimed even before stale timeout elapses.
	const lockFile = path.join(tmpRoot, "dead-owner.lock");
	fs.writeFileSync(
		lockFile,
		JSON.stringify({
			pid: 2147483647,
			hostname: os.hostname(),
			createdAt: new Date().toISOString(),
			label: "dead-owner",
		}),
	);

	const result = await withLock(lockFile, async () => "reclaimed", { staleMs: 60_000, timeoutMs: 500 });
	assertEq(result, "reclaimed", "withLock reclaims dead-owner lock before stale timeout");
	assert(!fs.existsSync(lockFile), "dead-owner lock cleaned up after reclaim");
}

{
	// Live-owner lock is not reclaimed just because it looks stale.
	const lockFile = path.join(tmpRoot, "live-owner.lock");
	fs.writeFileSync(
		lockFile,
		JSON.stringify({
			pid: process.pid,
			hostname: os.hostname(),
			createdAt: new Date().toISOString(),
			label: "live-owner",
		}),
	);
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lockFile, old, old);

	let message = "";
	try {
		await withLock(lockFile, async () => "unexpected", { staleMs: 1, timeoutMs: 120, pollMs: 10 });
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	}

	assert(message.includes("Timeout acquiring lock:"), "withLock times out when live owner still holds lock file");
	assert(message.includes("live-owner"), "withLock timeout includes lock label diagnostics");
	assert(message.includes(String(process.pid)), "withLock timeout includes owner pid diagnostics");
	fs.unlinkSync(lockFile);
}

{
	// Contention: many concurrent callers should serialize without throwing.
	const lockFile = path.join(tmpRoot, "contended.lock");
	const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
	let counter = 0;

	const runners = Array.from({ length: 20 }, () =>
		withLock(
			lockFile,
			async () => {
				counter += 1;
				await sleep(5);
				return counter;
			},
			{ timeoutMs: 5_000, pollMs: 2 },
		),
	);

	await Promise.all(runners);
	assertEq(counter, 20, "withLock serializes contended callers");
	assert(!fs.existsSync(lockFile), "contended lock cleaned up after");
}

// ── 3. mailbox ───────────────────────────────────────────────────────
console.log("\n3. mailbox");
{
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "hello agent1",
		timestamp: "2025-01-01T00:00:00Z",
	});
	const inboxPath = getInboxPath(teamDir, TEAM_MAILBOX_NS, "agent1");
	assert(fs.existsSync(inboxPath), "inbox file created");

	const raw: unknown = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
	assert(Array.isArray(raw), "inbox json is array");
	assertEq(Array.isArray(raw) ? raw.length : 0, 1, "one message in inbox");
	const first = Array.isArray(raw) ? raw.at(0) : undefined;
	assert(isRecord(first) && typeof first.read === "boolean", "message has boolean read");
	if (isRecord(first) && typeof first.read === "boolean") {
		assertEq(first.read, false, "message initially unread");
	}

	// pop
	const msgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs.length, 1, "popUnreadMessages returns 1");
	const m0 = msgs.at(0);
	assert(m0 !== undefined, "pop returned first message");
	if (m0) assertEq(m0.text, "hello agent1", "message text correct");

	// re-pop should be empty
	const msgs2 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs2.length, 0, "second pop returns 0 (already read)");

	// multiple messages
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "team-lead",
		text: "msg2",
		timestamp: "2025-01-01T00:01:00Z",
	});
	await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent1", {
		from: "peer",
		text: "msg3",
		timestamp: "2025-01-01T00:02:00Z",
	});
	const msgs3 = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent1");
	assertEq(msgs3.length, 2, "pop returns 2 new unread messages");

	const pruneCfg = getMailboxPruningConfig({
		PI_TEAMS_MAILBOX_PRUNING: "1",
		PI_TEAMS_MAILBOX_MAX_READ_MESSAGES: "2",
		PI_TEAMS_MAILBOX_MAX_TOTAL_MESSAGES: "3",
	});
	assert(pruneCfg.enabled, "mailbox pruning config enabled by env flag");
	assertEq(pruneCfg.maxReadMessages, 2, "mailbox pruning config parses read retention override");
	assertEq(pruneCfg.maxTotalMessages, 3, "mailbox pruning config parses total retention override");
	const compactedHelper = compactMailboxMessages(
		[
			{ from: "lead", text: "r1", timestamp: "2026-01-01T00:00:00Z", read: true },
			{ from: "lead", text: "r2", timestamp: "2026-01-01T00:00:01Z", read: true },
			{ from: "lead", text: "r3", timestamp: "2026-01-01T00:00:02Z", read: true },
			{ from: "lead", text: "u1", timestamp: "2026-01-01T00:00:03Z", read: false },
		],
		pruneCfg,
	);
	assertEq(compactedHelper.map((m) => m.text).join(","), "r2,r3,u1", "mailbox compaction keeps unread plus newest read history");

	for (let i = 0; i < 80; i++) {
		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, "agent-prune", {
			from: i % 2 === 0 ? "team-lead" : "peer",
			text: `bulk-${i}`,
			timestamp: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
		});
	}
	const prunedMsgs = await popUnreadMessages(teamDir, TEAM_MAILBOX_NS, "agent-prune");
	assertEq(prunedMsgs.length, 80, "pop returns all unread messages before compaction");
	const prunedInboxRaw: unknown = JSON.parse(
		fs.readFileSync(getInboxPath(teamDir, TEAM_MAILBOX_NS, "agent-prune"), "utf8"),
	);
	assert(Array.isArray(prunedInboxRaw), "compacted inbox remains a json array");
	assert((Array.isArray(prunedInboxRaw) ? prunedInboxRaw.length : 0) <= 50, "mailbox compaction bounds retained messages");
	const lastPruned = Array.isArray(prunedInboxRaw) ? prunedInboxRaw.at(-1) : undefined;
	assert(isRecord(lastPruned) && lastPruned.text === "bulk-79", "mailbox compaction retains newest message");
}

// ── 4. task-store ────────────────────────────────────────────────────
console.log("\n4. task-store");
{
	const t1 = await createTask(teamDir, taskListId, {
		subject: "Write tests",
		description: "Write unit tests for the extension",
		owner: "agent1",
	});
	assert(typeof t1.id === "string" && t1.id.length > 0, "task created with id");
	assertEq(t1.status, "pending", "new task is pending");
	assertEq(t1.owner, "agent1", "owner set");

	const t2 = await createTask(teamDir, taskListId, {
		subject: "Fix lint",
		description: "Fix all lint errors",
	});

	const all = await listTasks(teamDir, taskListId);
	assertEq(all.length, 2, "listTasks returns 2");

	const fetched = await getTask(teamDir, taskListId, t1.id);
	assertEq(fetched?.subject, "Write tests", "getTask returns correct task");

	const cacheTaskListId = `${taskListId}-cache`;
	const cachedA = await createTask(teamDir, cacheTaskListId, {
		subject: "Cache A",
		description: "Used to verify task-store memoization",
	});
	await createTask(teamDir, cacheTaskListId, {
		subject: "Cache B",
		description: "Used to verify task-store memoization",
	});
	const originalReadFile = fs.promises.readFile.bind(fs.promises);
	let readFileCount = 0;
	(fs.promises as typeof fs.promises & { readFile: typeof fs.promises.readFile }).readFile = (async (...args) => {
		readFileCount += 1;
		return await originalReadFile(...args);
	}) as typeof fs.promises.readFile;
	try {
		const cachedTask1 = await getTask(teamDir, cacheTaskListId, cachedA.id);
		const readsAfterFirstGet = readFileCount;
		const cachedTask2 = await getTask(teamDir, cacheTaskListId, cachedA.id);
		assertEq(cachedTask1?.subject, "Cache A", "cached getTask first read returns task");
		assertEq(cachedTask2?.subject, "Cache A", "cached getTask second read returns task");
		assertEq(readFileCount, readsAfterFirstGet, "getTask reuses cached task file reads when unchanged");
		assertEq(getTaskPriority(cachedTask1 ?? cachedA), "normal", "task priority defaults to normal when metadata missing");
		assertEq(getTaskPriorityRank("urgent"), 3, "urgent task priority rank is highest");
		assertEq(getTaskPriorityRank("low"), 0, "low task priority rank is lowest");

		const cachedList1 = await listTasks(teamDir, cacheTaskListId);
		const readsAfterFirstList = readFileCount;
		const cachedList2 = await listTasks(teamDir, cacheTaskListId);
		assertEq(cachedList1.length, 2, "cached listTasks first read returns both tasks");
		assertEq(cachedList2.length, 2, "cached listTasks second read returns both tasks");
		assertEq(readFileCount, readsAfterFirstList, "listTasks reuses cached task reads when unchanged");

		await updateTask(teamDir, cacheTaskListId, cachedA.id, (cur) => ({ ...cur, subject: "Cache A updated" }));
		const refreshed1 = await getTask(teamDir, cacheTaskListId, cachedA.id);
		const readsAfterRefresh = readFileCount;
		const refreshed2 = await getTask(teamDir, cacheTaskListId, cachedA.id);
		assertEq(refreshed1?.subject, "Cache A updated", "cache invalidation surfaces updated task data");
		assertEq(readFileCount, readsAfterRefresh, "task cache is repopulated after invalidation");
		assertEq(refreshed2?.subject, "Cache A updated", "repopulated cache returns updated task data");
	} finally {
		(fs.promises as typeof fs.promises & { readFile: typeof fs.promises.readFile }).readFile = originalReadFile;
	}

	// update
	const updated = await updateTask(teamDir, taskListId, t1.id, (cur) => ({
		...cur,
		status: "in_progress",
	}));
	assertEq(updated?.status, "in_progress", "updateTask changes status");

	const taskEventTeamDir = path.join(tmpRoot, "task-event-team");
	const taskEventListId = "task-events";
	const loggedTask = await createTask(taskEventTeamDir, taskEventListId, {
		subject: "Logged task",
		description: "used to verify task-store event logging",
	});
	const claimedLoggedTask = await claimTask(taskEventTeamDir, taskEventListId, loggedTask.id, "logger", {
		leaseDurationMs: 10_000,
		nowMs: Date.UTC(2026, 2, 12, 12, 0, 0),
	});
	await completeTask(taskEventTeamDir, taskEventListId, loggedTask.id, "logger", "logged result");
	const taskEvents = await readRecentTeamEvents(taskEventTeamDir);
	assert(taskEvents.some((event) => event.kind === "task_created" && event.taskId === loggedTask.id), "createTask appends task_created event");
	assert(taskEvents.some((event) => event.kind === "task_claimed" && event.taskId === loggedTask.id), "claimTask appends task_claimed event");
	assert(taskEvents.some((event) => event.kind === "task_completed" && event.taskId === loggedTask.id), "completeTask appends task_completed event");
	assertEq(claimedLoggedTask?.owner, "logger", "logged task claim still succeeds while event logging is enabled");
	const taskShowLines = buildTaskShowLines(
		{
			id: "show-1",
			subject: "Visible task",
			description: "Inspect visibility",
			owner: "agent-show",
			status: "in_progress",
			blocks: [],
			blockedBy: ["dep-1"],
			createdAt: "2026-03-12T12:00:00.000Z",
			updatedAt: "2026-03-12T12:05:00.000Z",
			metadata: {
				priority: "urgent",
				retryCount: 2,
				retryLimit: 3,
				cooldownUntil: "2026-03-12T12:10:00.000Z",
				leaseRecoveryReason: "lease_expired_and_owner_stale",
				taskLease: {
					owner: "agent-show",
					token: "abcdef1234567890",
					acquiredAt: "2026-03-12T12:00:00.000Z",
					heartbeatAt: "2026-03-12T12:05:00.000Z",
					expiresAt: "2026-03-12T12:15:00.000Z",
				},
				qualityGateStatus: "failed",
				qualityGateSummary: "tests failed",
			},
		},
		{
			blocked: true,
			recentEvents: [
				{ ts: "2026-03-12T12:01:00.000Z", kind: "task_claimed", taskId: "show-1", member: "agent-show" },
				{ ts: "2026-03-12T12:06:00.000Z", kind: "task_recovered", taskId: "show-1", data: { reason: "lease_expired_and_owner_stale" } },
			],
		},
	);
	assert(taskShowLines.some((line) => line.includes("priority: urgent")), "task show lines include priority");
	assert(taskShowLines.some((line) => line.includes("retry: 2/3")), "task show lines include retry summary");
	assert(taskShowLines.some((line) => line.includes("cooldownUntil: 2026-03-12T12:10:00.000Z")), "task show lines include cooldown metadata");
	assert(taskShowLines.some((line) => line.includes("lease: owner=agent-show expiresAt=2026-03-12T12:15:00.000Z token=abcdef12")), "task show lines include lease summary");
	assert(taskShowLines.some((line) => line.includes("leaseRecoveryReason: lease_expired_and_owner_stale")), "task show lines include lease recovery reason");
	assert(taskShowLines.some((line) => line.includes("quality gate: failed • tests failed")), "task show lines include quality gate summary");
	assert(taskShowLines.some((line) => line.includes("task_recovered • lease_expired_and_owner_stale")), "task show lines include recent task events");

	// startAssignedTask — requires task.owner === agentName && status === pending
	// First assign t2 to agent2, then start it
	await updateTask(teamDir, taskListId, t2.id, (cur) => ({ ...cur, owner: "agent2" }));
	await startAssignedTask(teamDir, taskListId, t2.id, "agent2");
	const t2after = await getTask(teamDir, taskListId, t2.id);
	assertEq(t2after?.status, "in_progress", "startAssignedTask sets in_progress");
	assertEq(t2after?.owner, "agent2", "startAssignedTask preserves owner");
	const t2lease = readTaskLeaseMetadata(t2after?.metadata);
	assertEq(t2lease?.owner, "agent2", "startAssignedTask attaches lease owner metadata");
	assert(typeof t2lease?.token === "string" && t2lease.token.length > 0, "startAssignedTask attaches lease token metadata");
	const refreshedLeaseTask = await refreshTaskLeaseHeartbeat(teamDir, taskListId, t2.id, "agent2", {
		nowMs: Date.UTC(2026, 2, 12, 10, 0, 0),
		leaseDurationMs: 15_000,
	});
	const refreshedLease = readTaskLeaseMetadata(refreshedLeaseTask?.metadata);
	assertEq(refreshedLease?.owner, "agent2", "refreshTaskLeaseHeartbeat preserves lease owner");
	assertEq(refreshedLease?.token, t2lease?.token, "refreshTaskLeaseHeartbeat preserves lease token");
	assertEq(refreshedLease?.heartbeatAt, new Date(Date.UTC(2026, 2, 12, 10, 0, 0)).toISOString(), "refreshTaskLeaseHeartbeat updates heartbeat time");
	assertEq(refreshedLease?.expiresAt, new Date(Date.UTC(2026, 2, 12, 10, 0, 15)).toISOString(), "refreshTaskLeaseHeartbeat extends lease expiration");

	// completeTask
	await completeTask(teamDir, taskListId, t1.id, "agent1", "All tests passing");
	const t1done = await getTask(teamDir, taskListId, t1.id);
	assertEq(t1done?.status, "completed", "completeTask sets completed");

	const leaseCompleteTask = await createTask(teamDir, taskListId, {
		subject: "Lease complete",
		description: "used to verify lease cleanup on completion",
		owner: "agent-complete",
	});
	await startAssignedTask(teamDir, taskListId, leaseCompleteTask.id, "agent-complete");
	await completeTask(teamDir, taskListId, leaseCompleteTask.id, "agent-complete", "done");
	const leaseCompleteDone = await getTask(teamDir, taskListId, leaseCompleteTask.id);
	assertEq(readTaskLeaseMetadata(leaseCompleteDone?.metadata), null, "completeTask clears lease metadata");

	// formatTaskLine
	assert(t1done !== null, "completed task can be re-fetched");
	if (t1done) {
		const line = formatTaskLine(t1done);
		assert(line.includes("completed"), "formatTaskLine includes status");
		assert(line.includes("Write tests"), "formatTaskLine includes subject");
	}

	const priorityTaskListId = `${taskListId}-priority`;
	const lowPriorityTask = await createTask(teamDir, priorityTaskListId, {
		subject: "Low priority",
		description: "should not be claimed first when higher-priority claimable work exists",
	});
	const urgentPriorityTask = await createTask(teamDir, priorityTaskListId, {
		subject: "Urgent priority",
		description: "should be claimed first among claimable tasks",
	});
	const blockerTask = await createTask(teamDir, priorityTaskListId, {
		subject: "Blocker",
		description: "keeps blocked urgent task from being claimable",
	});
	const blockedUrgentTask = await createTask(teamDir, priorityTaskListId, {
		subject: "Blocked urgent",
		description: "should stay blocked despite higher priority",
	});
	await updateTask(teamDir, priorityTaskListId, lowPriorityTask.id, (cur) => ({
		...cur,
		metadata: { ...(cur.metadata ?? {}), priority: "low" },
	}));
	await updateTask(teamDir, priorityTaskListId, urgentPriorityTask.id, (cur) => ({
		...cur,
		metadata: { ...(cur.metadata ?? {}), priority: "urgent" },
	}));
	await updateTask(teamDir, priorityTaskListId, blockedUrgentTask.id, (cur) => ({
		...cur,
		metadata: { ...(cur.metadata ?? {}), priority: "urgent" },
	}));
	const urgentTaskFetched = await getTask(teamDir, priorityTaskListId, urgentPriorityTask.id);
	assertEq(getTaskPriority(lowPriorityTask), "normal", "getTaskPriority defaults missing metadata to normal");
	assertEq(getTaskPriority(urgentTaskFetched ?? urgentPriorityTask), "urgent", "getTaskPriority reads metadata priority");
	assertEq(getTaskPriorityRank("urgent"), 3, "getTaskPriorityRank maps urgent to highest rank");
	assertEq(getTaskPriorityRank("low"), 0, "getTaskPriorityRank maps low to lowest rank");
	const depResPriority = await addTaskDependency(teamDir, priorityTaskListId, blockedUrgentTask.id, blockerTask.id);
	assert(depResPriority.ok, "priority test dependency edge ok");

	// claimNextAvailableTask
	const t3 = await createTask(teamDir, taskListId, {
		subject: "Unclaimed task",
		description: "nobody owns this",
	});
	const priorityClaim = await claimNextAvailableTask(teamDir, priorityTaskListId, "priority-agent", {
		nowMs: Date.UTC(2026, 2, 12, 7, 0, 0),
	});
	assertEq(priorityClaim?.id, urgentPriorityTask.id, "claimNextAvailableTask prefers highest-priority claimable task");
	const blockedUrgentAfterPriorityClaim = await getTask(teamDir, priorityTaskListId, blockedUrgentTask.id);
	assertEq(blockedUrgentAfterPriorityClaim?.owner, undefined, "blocked urgent task remains unclaimed despite higher priority");

	const claimNowMs = Date.UTC(2026, 2, 12, 8, 0, 0);
	const claimed = await claimNextAvailableTask(teamDir, taskListId, "agent3", { nowMs: claimNowMs, leaseDurationMs: 20_000 });
	assert(claimed !== null, "claimNextAvailableTask finds a task");
	assertEq(claimed?.owner, "agent3", "claimed task now owned by agent3");
	const claimedLease = readTaskLeaseMetadata(claimed?.metadata);
	assertEq(claimedLease?.owner, "agent3", "claimNextAvailableTask attaches lease owner metadata");
	assertEq(claimedLease?.acquiredAt, new Date(claimNowMs).toISOString(), "claimNextAvailableTask lease records acquisition time");
	assertEq(claimedLease?.expiresAt, new Date(claimNowMs + 20_000).toISOString(), "claimNextAvailableTask lease records expiry time");

	// unassignTasksForAgent — unassigns all non-completed tasks for agent
	// agent3 claimed a task above, unassign it
	await unassignTasksForAgent(teamDir, taskListId, "agent3", "agent3 left");
	const t3unassigned = await getTask(teamDir, taskListId, t3.id);
	assertEq(t3unassigned?.owner, undefined, "unassignTasksForAgent clears owner");
	assertEq(readTaskLeaseMetadata(t3unassigned?.metadata), null, "unassignTasksForAgent clears lease metadata");

	// dependencies
	const depRes = await addTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(depRes.ok, "addTaskDependency ok");
	const t3fetched = await getTask(teamDir, taskListId, t3.id);
	assert(t3fetched !== null, "getTask returns dependency task");
	const blocked = t3fetched ? await isTaskBlocked(teamDir, taskListId, t3fetched) : false;
	assert(blocked, "task is blocked by dependency");

	const t4 = await createTask(teamDir, taskListId, {
		subject: "Indirect dependency",
		description: "used to verify cycle detection walks dependency chains",
	});
	const depRes2 = await addTaskDependency(teamDir, taskListId, t4.id, t3.id);
	assert(depRes2.ok, "second dependency edge ok");

	const cycleRes = await addTaskDependency(teamDir, taskListId, t2.id, t4.id);
	assert(!cycleRes.ok, "cyclic dependencies are rejected");
	if (!cycleRes.ok) {
		assert(cycleRes.error.toLowerCase().includes("cycle"), "cycle rejection mentions cycle");
		assert(cycleRes.error.includes(t2.id), "cycle rejection mentions task id");
		assert(cycleRes.error.includes(t4.id), "cycle rejection mentions dependency id");
		assert(cycleRes.error.includes(t3.id), "cycle rejection mentions intermediate dependency path");
	}

	const t2AfterCycle = await getTask(teamDir, taskListId, t2.id);
	assertEq(t2AfterCycle?.blockedBy.length ?? 0, 0, "rejected cycle does not mutate task dependencies");

	const rmDep = await removeTaskDependency(teamDir, taskListId, t3.id, t2.id);
	assert(rmDep.ok, "removeTaskDependency ok");

	const retryTaskListId = `${taskListId}-retry`;
	const retryTask = await createTask(teamDir, retryTaskListId, {
		subject: "Retry me later",
		description: "used to verify retry metadata and cooldown gating",
		owner: "agent4",
	});
	await startAssignedTask(teamDir, retryTaskListId, retryTask.id, "agent4");
	const failureAt = Date.UTC(2026, 2, 12, 0, 0, 0);
	const retryMarked = await markTaskRetryableFailure(teamDir, retryTaskListId, retryTask.id, "agent4", {
		reason: "abort requested",
		partialResult: "partial work",
		nowMs: failureAt,
		baseDelayMs: 1_000,
		maxAttempts: 2,
	});
	assertEq(retryMarked?.status, "pending", "retryable failure resets task to pending");
	assertEq(retryMarked?.owner, undefined, "retryable failure clears owner for later reclaim");
	assertEq(retryMarked?.metadata?.retryCount, 1, "retryable failure increments retryCount");
	assertEq(retryMarked?.metadata?.retryExhausted, false, "first retry is not exhausted");
	assertEq(readTaskLeaseMetadata(retryMarked?.metadata), null, "retryable failure clears lease metadata");
	assertEq(
		retryMarked?.metadata?.cooldownUntil,
		new Date(failureAt + 1_000).toISOString(),
		"retryable failure records cooldownUntil",
	);
	assert(isTaskCoolingDown(retryMarked ?? retryTask, failureAt + 500), "cooldown is active before cooldownUntil");

	const readyTask = await createTask(teamDir, retryTaskListId, {
		subject: "Ready now",
		description: "should be claimable while retry task cools down",
	});
	const claimedReady = await claimNextAvailableTask(teamDir, retryTaskListId, "agent5", { nowMs: failureAt + 500 });
	assertEq(claimedReady?.id, readyTask.id, "claimNextAvailableTask skips cooled-down retry tasks");

	await updateTask(teamDir, retryTaskListId, retryTask.id, (cur) => ({ ...cur, owner: "agent4", status: "in_progress" }));
	const exhausted = await markTaskRetryableFailure(teamDir, retryTaskListId, retryTask.id, "agent4", {
		reason: "abort requested again",
		nowMs: failureAt + 10_000,
		baseDelayMs: 1_000,
		maxAttempts: 2,
	});
	assertEq(exhausted?.metadata?.retryCount, 2, "second retryable failure increments retryCount again");
	assertEq(exhausted?.metadata?.retryExhausted, true, "retry policy marks task exhausted at max attempts");
	assert(!isTaskCoolingDown(exhausted ?? retryTask, failureAt + 10_500), "exhausted task no longer depends on cooldown window");

	const recoverTask = await createTask(teamDir, retryTaskListId, {
		subject: "Recover me",
		description: "used to verify stale lease recovery",
		owner: "agent-stale",
	});
	await startAssignedTask(teamDir, retryTaskListId, recoverTask.id, "agent-stale", {
		nowMs: Date.UTC(2026, 2, 12, 11, 0, 0),
		leaseDurationMs: 10_000,
	});
	const recoveredTask = await recoverLeasedTaskIfStale(teamDir, retryTaskListId, recoverTask.id, {
		ownerLastSeenAt: new Date(Date.UTC(2026, 2, 12, 11, 0, 0)).toISOString(),
		nowMs: Date.UTC(2026, 2, 12, 11, 0, 20),
		heartbeatStaleMs: 5_000,
	});
	assertEq(recoveredTask?.status, "pending", "stale leased task is reset to pending during recovery");
	assertEq(recoveredTask?.owner, undefined, "stale leased task recovery clears owner");
	assertEq(readTaskLeaseMetadata(recoveredTask?.metadata), null, "stale leased task recovery clears lease metadata");
	assertEq(recoveredTask?.metadata?.leaseRecoveryReason, "lease_expired_and_owner_stale", "stale leased task recovery records reason metadata");
	const recoveryEvents = await readRecentTeamEvents(teamDir, { limit: 20 });
	assert(recoveryEvents.some((event) => event.kind === "task_recovered" && event.taskId === recoverTask.id), "recoverLeasedTaskIfStale appends task_recovered event");

	clearTaskStoreCache();
	const cacheStats0 = getTaskStoreCacheStats();
	assertEq(cacheStats0.fileCacheHits, 0, "task cache stats start with zero file hits after reset");
	assertEq(cacheStats0.listCacheHits, 0, "task cache stats start with zero list hits after reset");

	await getTask(teamDir, taskListId, retryTask.id);
	const cacheStatsAfterRead = getTaskStoreCacheStats();
	assertEq(cacheStatsAfterRead.fileReads, 1, "first cached getTask records one file read");
	await getTask(teamDir, taskListId, retryTask.id);
	const cacheStatsAfterHit = getTaskStoreCacheStats();
	assertEq(cacheStatsAfterHit.fileCacheHits, 1, "second cached getTask records a cache hit");

	await listTasks(teamDir, taskListId);
	const cacheStatsAfterListRead = getTaskStoreCacheStats();
	assertEq(cacheStatsAfterListRead.listReads, 1, "first cached listTasks records one list read");
	await listTasks(teamDir, taskListId);
	const cacheStatsAfterListHit = getTaskStoreCacheStats();
	assertEq(cacheStatsAfterListHit.listCacheHits, 1, "second cached listTasks records a list cache hit");

	const retryTaskFile = path.join(getTaskListDir(teamDir, taskListId), `${retryTask.id}.json`);
	const retryTaskRaw = JSON.parse(fs.readFileSync(retryTaskFile, "utf8")) as { subject: string };
	retryTaskRaw.subject = "Retry me later (external change)";
	fs.writeFileSync(retryTaskFile, JSON.stringify(retryTaskRaw, null, 2) + "\n", "utf8");
	const future = new Date(Date.now() + 2_000);
	fs.utimesSync(retryTaskFile, future, future);
	const refreshedRetryTask = await getTask(teamDir, taskListId, retryTask.id);
	assertEq(refreshedRetryTask?.subject, "Retry me later (external change)", "task cache invalidates after external file mutation");

	// clearTasks (completed only)
	const clearResult = await clearTasks(teamDir, taskListId, "completed");
	assert(clearResult.deletedTaskIds.length >= 1, "clearTasks deleted completed tasks");
	assert(clearResult.skippedTaskIds.length >= 1, "clearTasks skipped non-completed");
}

// ── 5. team-config ───────────────────────────────────────────────────
console.log("\n5. team-config");
{
	const cfg = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg.version, 1, "config version 1");
	assertEq(cfg.teamId, "smoke-team", "teamId set");
	assert(cfg.members.length >= 1, "has at least lead member");
	const firstMember = cfg.members.at(0);
	assert(firstMember !== undefined, "first member exists");
	if (firstMember) assertEq(firstMember.role, "lead", "first member is lead");

	// idempotent
	const cfg2 = await ensureTeamConfig(teamDir, {
		teamId: "smoke-team",
		taskListId: "smoke-tl",
		leadName: "team-lead",
		style: "normal",
	});
	assertEq(cfg2.teamId, cfg.teamId, "ensureTeamConfig idempotent");

	// upsertMember
	const cfg3 = await upsertMember(teamDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});
	assert(cfg3.members.some((m) => m.name === "agent1" && m.role === "worker"), "upsertMember adds worker");

	// setMemberStatus
	const cfg4 = await setMemberStatus(teamDir, "agent1", "offline");
	assert(cfg4 !== null, "setMemberStatus returns config");
	if (cfg4) {
		assert(
			cfg4.members.some((m) => m.name === "agent1" && m.status === "offline"),
			"setMemberStatus changes status",
		);
	}

	// loadTeamConfig
	const loaded = await loadTeamConfig(teamDir);
	assert(loaded !== null, "loadTeamConfig returns config");
	assertEq(loaded?.teamId, "smoke-team", "loadTeamConfig correct teamId");

	// updateTeamHooksPolicy
	const withHooks = await updateTeamHooksPolicy(teamDir, () => ({
		failureAction: "reopen_followup",
		maxReopensPerTask: 2,
		followupOwner: "member",
	}));
	assert(withHooks !== null, "updateTeamHooksPolicy returns config");
	assertEq(withHooks?.hooks?.failureAction, "reopen_followup", "updateTeamHooksPolicy sets failure action");
	assertEq(withHooks?.hooks?.maxReopensPerTask, 2, "updateTeamHooksPolicy sets max reopens");
	assertEq(withHooks?.hooks?.followupOwner, "member", "updateTeamHooksPolicy sets followup owner");

	const clearedHooks = await updateTeamHooksPolicy(teamDir, () => undefined);
	assert(clearedHooks !== null, "updateTeamHooksPolicy can clear policy");
	assertEq(clearedHooks?.hooks, undefined, "updateTeamHooksPolicy clears hooks policy");
}

// ── 6. protocol parsers ──────────────────────────────────────────────
console.log("\n6. protocol parsers");
{
	// idle notification
	const idle = isIdleNotification(
		JSON.stringify({ type: "idle_notification", from: "agent1", timestamp: "2025-01-01T00:00:00Z" }),
	);
	assert(idle !== null, "isIdleNotification parses valid");
	assertEq(idle?.from, "agent1", "idle.from correct");

	assert(isIdleNotification("not json") === null, "isIdleNotification rejects garbage");
	assert(isIdleNotification(JSON.stringify({ type: "other" })) === null, "rejects wrong type");

	// task assignment
	const assign = isTaskAssignmentMessage(
		JSON.stringify({ type: "task_assignment", taskId: "42", subject: "Do stuff" }),
	);
	assert(assign !== null, "isTaskAssignmentMessage parses valid");
	assertEq(assign?.taskId, "42", "assign.taskId correct");

	// shutdown request
	const shutReq = isShutdownRequestMessage(
		JSON.stringify({ type: "shutdown_request", requestId: "r1", from: "lead", reason: "done" }),
	);
	assert(shutReq !== null, "isShutdownRequestMessage parses valid");
	assertEq(shutReq?.requestId, "r1", "shutReq.requestId correct");

	// shutdown approved / rejected
	const approved = isShutdownApproved(
		JSON.stringify({ type: "shutdown_approved", requestId: "r1", from: "agent1" }),
	);
	assert(approved !== null, "isShutdownApproved parses valid");

	const rejected = isShutdownRejected(
		JSON.stringify({ type: "shutdown_rejected", requestId: "r1", from: "agent1", reason: "busy" }),
	);
	assert(rejected !== null, "isShutdownRejected parses valid");

	// set session name
	const setName = isSetSessionNameMessage(JSON.stringify({ type: "set_session_name", name: "my session" }));
	assert(setName !== null, "isSetSessionNameMessage parses valid");
	assertEq(setName?.name, "my session", "setName.name correct");

	// plan approval request
	const planReq = isPlanApprovalRequest(
		JSON.stringify({ type: "plan_approval_request", requestId: "p1", from: "agent1", plan: "do X then Y" }),
	);
	assert(planReq !== null, "isPlanApprovalRequest parses valid");

	// plan approved / rejected
	const planOk = isPlanApprovedMessage(
		JSON.stringify({ type: "plan_approved", requestId: "p1", from: "lead", timestamp: "t" }),
	);
	assert(planOk !== null, "isPlanApprovedMessage parses valid");

	const planNo = isPlanRejectedMessage(
		JSON.stringify({ type: "plan_rejected", requestId: "p1", from: "lead", feedback: "redo" }),
	);
	assert(planNo !== null, "isPlanRejectedMessage parses valid");

	// peer DM
	const dm = isPeerDmSent(
		JSON.stringify({ type: "peer_dm_sent", from: "a1", to: "a2", summary: "hi" }),
	);
	assert(dm !== null, "isPeerDmSent parses valid");

	// abort
	const abort = isAbortRequestMessage(
		JSON.stringify({ type: "abort_request", requestId: "ab1", from: "lead", taskId: "5" }),
	);
	assert(abort !== null, "isAbortRequestMessage parses valid");
}

// ── 7. Pi CLI extension loading (non-interactive) ────────────────────
console.log("\n7. Pi extension loading");
{
	const { spawnSync } = await import("node:child_process");

	// `pi` is expected to be installed in local dev, but it's usually not available in CI.
	// Even locally, it may hang due to user-specific config, so treat this as a best-effort check.
	const res = spawnSync("pi", ["--version"], {
		cwd: process.cwd(),
		timeout: 3_000,
		encoding: "utf8",
	});

	const errCode = (() => {
		const e: unknown = res.error;
		if (!e || typeof e !== "object") return undefined;
		const c = (e as { code?: unknown }).code;
		return typeof c === "string" ? c : undefined;
	})();

	if (errCode === "ENOENT") {
		console.log("  (skipped) pi CLI not found on PATH");
	} else if (errCode === "ETIMEDOUT") {
		console.log("  (skipped) pi --version timed out");
	} else if (res.status !== 0) {
		console.log("  (skipped) pi --version returned non-zero exit code");
	} else {
		assert((res.stdout ?? "").trim().length > 0, "pi --version works");
	}
}

// ── 8. styles (custom + naming rules) ───────────────────────────────
console.log("\n8. teams-style (custom styles)");
{
	const prev = process.env.PI_TEAMS_ROOT_DIR;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;

	// Write a custom style under <teamsRoot>/_styles/
	const stylesDir = path.join(tmpRoot, "_styles");
	fs.mkdirSync(stylesDir, { recursive: true });
	fs.writeFileSync(
		path.join(stylesDir, "smoke-custom.json"),
		JSON.stringify(
			{
				extends: "pirate",
				strings: { memberTitle: "Deckhand", memberPrefix: "Deckhand " },
				naming: {
					requireExplicitSpawnName: false,
					autoNameStrategy: { kind: "pool", pool: ["pegleg"], fallbackBase: "deckhand" },
				},
			},
			null,
			2,
		) + "\n",
		"utf8",
	);

	const s = getTeamsStrings("smoke-custom");
	assertEq(s.memberTitle, "Deckhand", "custom style overrides strings");
	const naming = getTeamsNamingRules("smoke-custom");
	assert(naming.requireExplicitSpawnName === false, "custom style naming rules parsed");
	assert(naming.autoNameStrategy.kind === "pool", "custom style can use pool naming");
	if (naming.autoNameStrategy.kind === "pool") {
		assertEq(naming.autoNameStrategy.fallbackBase, "deckhand", "custom style fallbackBase parsed");
		assertEq(naming.autoNameStrategy.pool.at(0), "pegleg", "custom style pool parsed");
	}

	// restore env
	if (prev === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prev;
}

// ── 9. hooks (quality gates) ────────────────────────────────────────
console.log("\n9. teams-hooks (quality gates)");
{
	const prevRoot = process.env.PI_TEAMS_ROOT_DIR;
	const prevEnabled = process.env.PI_TEAMS_HOOKS_ENABLED;
	process.env.PI_TEAMS_ROOT_DIR = tmpRoot;
	process.env.PI_TEAMS_HOOKS_ENABLED = "1";

	const hooksDir = path.join(tmpRoot, "_hooks");
	fs.mkdirSync(hooksDir, { recursive: true });

	const outFile = path.join(tmpRoot, "hook-ran.txt");
	fs.writeFileSync(
		path.join(hooksDir, "on_task_completed.js"),
		"" +
			"const fs = require('node:fs');\n" +
			"const payload = {\n" +
			"  contextVersion: process.env.PI_TEAMS_HOOK_CONTEXT_VERSION || null,\n" +
			"  contextJson: process.env.PI_TEAMS_HOOK_CONTEXT_JSON || null,\n" +
			"  event: process.env.PI_TEAMS_HOOK_EVENT || null,\n" +
			"  taskId: process.env.PI_TEAMS_TASK_ID || null,\n" +
			"};\n" +
			`fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(payload) + '\\n', 'utf8');\n` +
			"process.exit(0);\n",
		"utf8",
	);

	const teamId = "smoke-team";
	const teamDir = path.join(tmpRoot, teamId);
	fs.mkdirSync(teamDir, { recursive: true });

	const res = await runTeamsHook({
		invocation: {
			event: "task_completed",
			teamId,
			teamDir,
			taskListId: teamId,
			style: "pirate",
			memberName: "agent1",
			timestamp: new Date().toISOString(),
			completedTask: {
				id: "1",
				subject: "Test task",
				description: "",
				owner: "agent1",
				status: "completed",
				blocks: [],
				blockedBy: [],
				metadata: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		},
		cwd: tmpRoot,
	});

	assert(res.ran === true, "runs on_task_completed hook");
	assert(res.exitCode === 0, "hook exit code is 0");
	assert(fs.existsSync(outFile), "hook wrote output file");
	const hookOutRaw = fs.readFileSync(outFile, "utf8").trim();
	const hookOut = JSON.parse(hookOutRaw) as {
		contextVersion: string | null;
		contextJson: string | null;
		event: string | null;
		taskId: string | null;
	};
	assertEq(hookOut.contextVersion, "1", "hook context version env is set");
	assertEq(hookOut.event, "task_completed", "hook event env is set");
	assertEq(hookOut.taskId, "1", "hook task id env is set");
	const hookContext = JSON.parse(hookOut.contextJson ?? "{}") as {
		version?: number;
		event?: string;
		task?: { id?: string; status?: string } | null;
	};
	assertEq(hookContext.version, 1, "hook context payload version is 1");
	assertEq(hookContext.event, "task_completed", "hook context payload includes event");
	assertEq(hookContext.task?.id, "1", "hook context payload includes task id");
	assertEq(hookContext.task?.status, "completed", "hook context payload includes task status");

	assertEq(getTeamsHookFailureAction({}), "warn", "hook failure action defaults to warn");
	assertEq(
		getTeamsHookFailureAction({ PI_TEAMS_HOOKS_FAILURE_ACTION: "reopen_followup" }),
		"reopen_followup",
		"hook failure action reads explicit env",
	);
	assertEq(
		getTeamsHookFailureAction({ PI_TEAMS_HOOKS_CREATE_TASK_ON_FAILURE: "1" }),
		"followup",
		"legacy hook followup env maps to followup action",
	);
	assert(shouldCreateHookFollowupTask("followup"), "followup action creates follow-up task");
	assert(shouldCreateHookFollowupTask("reopen_followup"), "reopen_followup action creates follow-up task");
	assert(shouldReopenTaskOnHookFailure("reopen"), "reopen action reopens completed task");
	assert(shouldReopenTaskOnHookFailure("reopen_followup"), "reopen_followup action reopens completed task");
	assertEq(getTeamsHookFollowupOwnerPolicy({}), "member", "hook follow-up owner policy defaults to member");
	assertEq(getTeamsHookFollowupOwnerPolicy({ PI_TEAMS_HOOKS_FOLLOWUP_OWNER: "lead" }), "lead", "hook follow-up owner policy reads env");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "member", memberName: "agent1", leadName: "team-lead" }), "agent1", "member policy resolves to member");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "member", leadName: "team-lead" }), "team-lead", "member policy falls back to lead");
	assertEq(resolveTeamsHookFollowupOwner({ policy: "none", memberName: "agent1", leadName: "team-lead" }), undefined, "none policy clears follow-up owner");
	assertEq(getTeamsHookMaxReopensPerTask({}), 3, "hook max reopens default is 3");
	assertEq(getTeamsHookMaxReopensPerTask({ PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK: "0" }), 0, "hook max reopens supports zero");

	// restore env
	if (prevRoot === undefined) delete process.env.PI_TEAMS_ROOT_DIR;
	else process.env.PI_TEAMS_ROOT_DIR = prevRoot;
	if (prevEnabled === undefined) delete process.env.PI_TEAMS_HOOKS_ENABLED;
	else process.env.PI_TEAMS_HOOKS_ENABLED = prevEnabled;
}

// ── 10. team discovery + attach claims ──────────────────────────────
console.log("\n10. team discovery + attach claims");
{
	const discoverRoot = path.join(tmpRoot, "discover-root");
	const aDir = path.join(discoverRoot, "team-a");
	const bDir = path.join(discoverRoot, "team-b");
	fs.mkdirSync(path.join(discoverRoot, "_styles"), { recursive: true });

	await ensureTeamConfig(aDir, {
		teamId: "team-a",
		taskListId: "tasks-a",
		leadName: "team-lead",
		style: "normal",
	});
	await ensureTeamConfig(bDir, {
		teamId: "team-b",
		taskListId: "tasks-b",
		leadName: "team-lead",
		style: "pirate",
	});
	await upsertMember(bDir, {
		name: "agent1",
		role: "worker",
		status: "online",
	});

	const claimA = await acquireTeamAttachClaim(aDir, "session-a");
	assert(claimA.ok, "acquireTeamAttachClaim succeeds for first claimant");
	const claimB = await acquireTeamAttachClaim(aDir, "session-b");
	assert(!claimB.ok, "acquireTeamAttachClaim blocks second claimant without force");
	const heartbeatA = await heartbeatTeamAttachClaim(aDir, "session-a");
	assertEq(heartbeatA, "updated", "heartbeat updates owner claim");
	const heartbeatB = await heartbeatTeamAttachClaim(aDir, "session-b");
	assertEq(heartbeatB, "not_owner", "heartbeat rejects non-owner");
	const releaseB = await releaseTeamAttachClaim(aDir, "session-b");
	assertEq(releaseB, "not_owner", "release rejects non-owner");
	const releaseA = await releaseTeamAttachClaim(aDir, "session-a");
	assertEq(releaseA, "released", "release succeeds for owner");

	const staleCheck = assessAttachClaimFreshness(
		{
			holderSessionId: "session-stale",
			claimedAt: new Date(Date.now() - 120_000).toISOString(),
			heartbeatAt: new Date(Date.now() - 90_000).toISOString(),
			pid: 123,
		},
	);
	assert(staleCheck.isStale, "assessAttachClaimFreshness marks old heartbeat as stale");

	await acquireTeamAttachClaim(bDir, "session-c");
	const discovered = await listDiscoveredTeams(discoverRoot);
	assert(discovered.some((t) => t.teamId === "team-a"), "discovers first team");
	assert(discovered.some((t) => t.teamId === "team-b"), "discovers second team");
	assert(!discovered.some((t) => t.teamId.startsWith("_")), "ignores internal directories");
	const b = discovered.find((t) => t.teamId === "team-b");
	assert(b !== undefined, "team-b discovered");
	if (b) {
		assertEq(b.taskListId, "tasks-b", "discovered taskListId");
		assertEq(b.style, "pirate", "discovered style");
		assertEq(b.onlineWorkerCount, 1, "discovered online worker count");
		assertEq(b.attachedBySessionId, "session-c", "discovered attach claim owner");
	}
}

// ── 11. docs/help drift guard ────────────────────────────────────────
console.log("\n11. docs/help drift guard");
{
	const help = getTeamHelpText();
	assert(help.includes("/team style list"), "help mentions /team style list");
	assert(help.includes("/team style init"), "help mentions /team style init");
	assert(help.includes("/team attach <teamId> [--claim]"), "help mentions /team attach claim mode");
	assert(help.includes("/team detach"), "help mentions /team detach");
	assert(help.includes("/team doctor"), "help mentions /team doctor");

	const readmePath = path.join(process.cwd(), "README.md");
	if (!fs.existsSync(readmePath)) {
		console.log("  (skipped) README.md not found");
	} else {
		const readme = fs.readFileSync(readmePath, "utf8");
		assert(readme.includes("/team style list"), "README mentions /team style list");
		assert(readme.includes("/team attach <teamId> [--claim]"), "README mentions /team attach claim mode");
		assert(readme.includes("/team detach"), "README mentions /team detach");
		assert(readme.includes("/team doctor"), "README mentions /team doctor");
		assert(readme.includes("\"action\": \"task_assign\""), "README mentions teams tool task_assign action");
		assert(readme.includes("\"action\": \"task_dep_add\""), "README mentions teams tool task_dep_add action");
		assert(readme.includes("\"action\": \"message_broadcast\""), "README mentions teams tool message_broadcast action");
		assert(readme.includes("\"action\": \"member_kill\""), "README mentions teams tool member_kill action");
		assert(readme.includes("\"action\": \"plan_approve\""), "README mentions teams tool plan_approve action");
		assert(readme.includes("\"action\": \"hooks_policy_get\""), "README mentions teams tool hooks_policy_get action");
		assert(readme.includes("\"action\": \"hooks_policy_set\""), "README mentions teams tool hooks_policy_set action");
		assert(readme.includes("\"action\": \"model_policy_get\""), "README mentions teams tool model_policy_get action");
		assert(readme.includes("\"action\": \"model_policy_check\""), "README mentions teams tool model_policy_check action");
		assert(readme.includes("PI_TEAMS_HOOKS_FAILURE_ACTION"), "README mentions hook failure action policy");
		assert(readme.includes("PI_TEAMS_HOOKS_MAX_REOPENS_PER_TASK"), "README mentions hook reopen cap policy");
		assert(readme.includes("PI_TEAMS_HOOK_CONTEXT_JSON"), "README mentions hook context json contract");
		assert(!readme.includes("claude-sonnet-4"), "README avoids deprecated leader model examples");
		assert(readme.includes("task-centric view"), "README mentions panel task-centric view");
		assert(readme.includes("`t` or `shift+t`"), "README mentions panel task toggle key");
		assert(readme.includes("task view: `c` complete"), "README mentions panel task mutations");
		assert(readme.includes("`r` reassign"), "README mentions panel task reassignment");
		assert(readme.includes("_styles"), "README mentions _styles directory");
		assert(readme.includes("PowerShell (Windows)"), "README documents PowerShell worker env instructions");
		assert(readme.includes("start-team-windows.ps1"), "README mentions Windows launcher script");
		assert(readme.includes("docs/ARCHITECTURE.md"), "README links architecture doc");
		assert(readme.includes("docs/COMPATIBILITY.md"), "README links compatibility doc");
		assert(readme.includes("SECURITY.md"), "README links security policy");
		assert(readme.includes("llms.txt"), "README links llms.txt");
	}

	const windowsLauncherPath = path.join(process.cwd(), "scripts", "start-team-windows.ps1");
	assert(fs.existsSync(windowsLauncherPath), "Windows launcher script exists");
	assert(fs.existsSync(path.join(process.cwd(), "SECURITY.md")), "SECURITY.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "SUPPORT.md")), "SUPPORT.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "CONTRIBUTING.md")), "CONTRIBUTING.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "CODE_OF_CONDUCT.md")), "CODE_OF_CONDUCT.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "GOVERNANCE.md")), "GOVERNANCE.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "MAINTAINERS.md")), "MAINTAINERS.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "CHANGELOG.md")), "CHANGELOG.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "llms.txt")), "llms.txt exists");
	assert(fs.existsSync(path.join(process.cwd(), "llms-full.txt")), "llms-full.txt exists");
	assert(fs.existsSync(path.join(process.cwd(), "docs", "ARCHITECTURE.md")), "ARCHITECTURE.md exists");
	assert(fs.existsSync(path.join(process.cwd(), "docs", "COMPATIBILITY.md")), "COMPATIBILITY.md exists");
	assert(fs.existsSync(path.join(process.cwd(), ".github", "CODEOWNERS")), "CODEOWNERS exists");
	assert(fs.existsSync(path.join(process.cwd(), ".github", "PULL_REQUEST_TEMPLATE.md")), "PR template exists");
	assert(fs.existsSync(path.join(process.cwd(), ".github", "ISSUE_TEMPLATE", "bug_report.yml")), "bug issue template exists");
	assert(fs.existsSync(path.join(process.cwd(), ".github", "ISSUE_TEMPLATE", "feature_request.yml")), "feature issue template exists");
	assert(fs.existsSync(path.join(process.cwd(), ".github", "dependabot.yml")), "Dependabot config exists");
}

// ── summary ──────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(50)}`);
console.log(`  PASSED: ${passed}  FAILED: ${failed}`);
console.log(`${"═".repeat(50)}\n`);

// cleanup
fs.rmSync(tmpRoot, { recursive: true, force: true });

process.exit(failed > 0 ? 1 : 0);
