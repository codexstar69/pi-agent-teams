import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertTeamDirWithinTeamsRoot,
	assertWorktreePathWithinTeamDir,
	buildTeamCleanupPlan,
	cleanupTeamDir,
	getTeamWorktreesDir,
	listManagedWorktreePaths,
} from "../extensions/teams/cleanup.js";

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

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-teams-cleanup-"));
const teamsRoot = path.join(tmpRoot, "teams");
const teamDir = path.join(teamsRoot, "team-a");
const worktreesDir = getTeamWorktreesDir(teamDir);
await fs.promises.mkdir(path.join(worktreesDir, "alice"), { recursive: true });
await fs.promises.mkdir(path.join(worktreesDir, "bob"), { recursive: true });
await fs.promises.writeFile(path.join(worktreesDir, "README.txt"), "ignore me\n", "utf8");

const teamPaths = assertTeamDirWithinTeamsRoot(teamsRoot, teamDir);
assertEq(teamPaths.teamDirAbs, path.resolve(teamDir), "team dir is resolved within teams root");

let outsideRejected = false;
try {
	assertTeamDirWithinTeamsRoot(teamsRoot, tmpRoot);
} catch {
	outsideRejected = true;
}
assert(outsideRejected, "cleanup refuses team dir outside teams root");

const listed = await listManagedWorktreePaths(teamDir);
assertEq(listed.length, 2, "listManagedWorktreePaths returns only directory entries");
assertEq(path.basename(listed[0] ?? ""), "alice", "listed worktrees are sorted");
assertEq(path.basename(listed[1] ?? ""), "bob", "listed second worktree path");

const worktreePath = assertWorktreePathWithinTeamDir(teamDir, path.join(worktreesDir, "alice"));
assertEq(worktreePath.worktreeAbs, path.resolve(path.join(worktreesDir, "alice")), "safe worktree path resolves under team worktrees dir");

let unsafeWorktreeRejected = false;
try {
	assertWorktreePathWithinTeamDir(teamDir, path.join(tmpRoot, "rogue"));
} catch {
	unsafeWorktreeRejected = true;
}
assert(unsafeWorktreeRejected, "cleanup refuses worktree path outside team worktrees dir");

const plan = buildTeamCleanupPlan(teamsRoot, teamDir, listed);
assertEq(plan.worktreePaths.length, 2, "cleanup plan includes managed worktrees");
assertEq(path.basename(plan.worktreePaths[0] ?? ""), "alice", "cleanup plan preserves sorted worktrees");

let unsafePlanRejected = false;
try {
	buildTeamCleanupPlan(teamsRoot, teamDir, [...listed, path.join(tmpRoot, "rogue")]);
} catch {
	unsafePlanRejected = true;
}
assert(unsafePlanRejected, "cleanup plan rejects unsafe worktree paths");

await cleanupTeamDir(teamsRoot, teamDir);
assert(!fs.existsSync(teamDir), "cleanupTeamDir removes the team directory tree");

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}

console.log(`PASSED: ${passed}`);
