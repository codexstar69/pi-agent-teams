import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { inspectGitWorktreePath, planGitWorktreeCleanupAction } from "../extensions/teams/worktree.js";

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

async function execGit(args: string[], cwd: string): Promise<string> {
	return await new Promise((resolve, reject) => {
		execFile("git", args, { cwd, timeout: 30_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args.join(" ")} failed\nstdout=${stdout}\nstderr=${stderr}\nerror=${err.message}`));
				return;
			}
			resolve(String(stdout));
		});
	});
}

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-teams-git-worktree-"));
const repoRoot = path.join(tmpRoot, "repo");
const teamDir = path.join(tmpRoot, "team");
const worktreePath = path.join(teamDir, "worktrees", "alice");
const roguePath = path.join(teamDir, "worktrees", "rogue");
const missingPath = path.join(teamDir, "worktrees", "missing");

await fs.promises.mkdir(repoRoot, { recursive: true });
await execGit(["init"], repoRoot);
await execGit(["config", "user.name", "Pi Teams Test"], repoRoot);
await execGit(["config", "user.email", "pi-teams@example.com"], repoRoot);
await fs.promises.writeFile(path.join(repoRoot, "README.md"), "root\n", "utf8");
await execGit(["add", "README.md"], repoRoot);
await execGit(["commit", "-m", "init"], repoRoot);

await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
await execGit(["worktree", "add", "-b", "pi-teams/test/alice", worktreePath, "HEAD"], repoRoot);

const registered = await inspectGitWorktreePath({ repoRoot, worktreePath });
assert(registered.exists, "registered worktree exists");
assert(registered.registered, "registered worktree is recognized by git");
assertEq(registered.branch, "refs/heads/pi-teams/test/alice", "registered worktree branch is detected");
assertEq(registered.dirty, false, "clean worktree is reported clean");
assertEq(planGitWorktreeCleanupAction(registered), "git_remove", "registered worktree plans git removal");

await fs.promises.writeFile(path.join(worktreePath, "README.md"), "modified\n", "utf8");
const dirty = await inspectGitWorktreePath({ repoRoot, worktreePath });
assertEq(dirty.dirty, true, "dirty worktree is detected");

await fs.promises.mkdir(roguePath, { recursive: true });
const rogue = await inspectGitWorktreePath({ repoRoot, worktreePath: roguePath });
assert(rogue.exists, "rogue directory exists");
assertEq(rogue.registered, false, "rogue directory is not treated as a git worktree");
assertEq(rogue.dirty, null, "rogue directory skips git status detection");
assertEq(planGitWorktreeCleanupAction(rogue), "fs_remove_only", "rogue directory plans filesystem-only cleanup");

const missing = await inspectGitWorktreePath({ repoRoot, worktreePath: missingPath });
assertEq(missing.exists, false, "missing worktree path is reported missing");
assertEq(missing.registered, false, "missing worktree path is not registered");
assertEq(planGitWorktreeCleanupAction(missing), "skip_missing", "missing path plans skip_missing action");

console.log("PASS: git worktree cleanup helper test passed");
