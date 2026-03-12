import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectTeamDoctorReport, formatTeamDoctorReport } from "../extensions/teams/doctor.js";
import type { TeamConfig } from "../extensions/teams/team-config.js";

function assert(condition: boolean, label: string): void {
	if (!condition) throw new Error(`Assertion failed: ${label}`);
	console.log(`✓ ${label}`);
}

function assertEq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`Assertion failed: ${label} (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`);
	}
	console.log(`✓ ${label}`);
}

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-teams-doctor-"));
const teamDir = path.join(tmpRoot, "team-a");
const worktreesDir = path.join(teamDir, "worktrees");
await fs.promises.mkdir(path.join(worktreesDir, "alice"), { recursive: true });
await fs.promises.mkdir(path.join(worktreesDir, "ghost"), { recursive: true });
await fs.promises.mkdir(path.join(teamDir, "mailboxes", "team", "inboxes"), { recursive: true });

const staleLockPath = path.join(teamDir, "tasks", "default", "1.json.lock");
await fs.promises.mkdir(path.dirname(staleLockPath), { recursive: true });
await fs.promises.writeFile(
	staleLockPath,
	JSON.stringify({
		pid: 2147483647,
		hostname: os.hostname(),
		createdAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(),
		label: "tasks:update:1",
	}),
	"utf8",
);
const old = new Date(Date.UTC(2026, 2, 12, 8, 0, 0));
fs.utimesSync(staleLockPath, old, old);

const config: TeamConfig = {
	version: 1,
	teamId: "team-a",
	taskListId: "default",
	leadName: "team-lead",
	createdAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(),
	updatedAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(),
	members: [
		{ name: "team-lead", role: "lead", status: "online", addedAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(), lastSeenAt: new Date(Date.UTC(2026, 2, 12, 8, 5, 0)).toISOString() },
		{ name: "alice", role: "worker", status: "online", addedAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(), lastSeenAt: new Date(Date.UTC(2026, 2, 12, 8, 4, 50)).toISOString() },
		{ name: "bob", role: "worker", status: "online", addedAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString(), lastSeenAt: new Date(Date.UTC(2026, 2, 12, 8, 0, 0)).toISOString() },
	],
};

const report = await collectTeamDoctorReport({
	teamDir,
	teamConfig: config,
	nowMs: Date.UTC(2026, 2, 12, 8, 5, 0),
	heartbeatStaleMs: 30_000,
	lockStaleMs: 60_000,
});

assertEq(report.teamDir, path.resolve(teamDir), "doctor report resolves team dir");
assertEq(report.staleWorkers.length, 1, "doctor report finds one stale worker");
assertEq(report.staleWorkers[0]?.name, "bob", "doctor report identifies stale worker by name");
assertEq(report.managedWorktrees.length, 2, "doctor report lists managed worktree directories");
assertEq(path.basename(report.managedWorktrees[0]?.worktreePath ?? ""), "alice", "doctor report sorts managed worktrees");
assertEq(report.staleLocks.length, 1, "doctor report finds stale lock file");
assertEq(report.staleLocks[0]?.reason, "dead_owner", "doctor report classifies dead-owner lock as stale");
assertEq(report.staleLocks[0]?.label, "tasks:update:1", "doctor report surfaces lock label");
assert(report.summary.includes("1 stale worker"), "doctor summary mentions stale workers");
assert(report.summary.includes("1 stale lock"), "doctor summary mentions stale locks");

const rendered = formatTeamDoctorReport(report);
assert(rendered.includes("Stale workers (1):"), "formatted doctor report includes stale worker section");
assert(rendered.includes("bob"), "formatted doctor report includes stale worker name");
assert(rendered.includes("Managed worktrees (2):"), "formatted doctor report includes managed worktree section");
assert(rendered.includes("tasks:update:1"), "formatted doctor report includes stale lock label");

console.log("PASS: team doctor helper test passed");
