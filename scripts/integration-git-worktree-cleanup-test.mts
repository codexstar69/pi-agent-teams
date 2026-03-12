import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import {
	cleanupManagedWorktrees,
	inspectGitWorktree,
	removeGitWorktree,
} from "../extensions/teams/worktree.js";

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`git ${args.join(" ")} failed\nstdout=${stdout}\nstderr=${stderr}\nerror=${err.message}`));
				return;
			}
			resolve({ stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-teams-git-worktree-cleanup-"));
const repoRoot = path.join(tmpRoot, "repo");
const teamDir = path.join(tmpRoot, "teams", "team-a");
const worktreePath = path.join(teamDir, "worktrees", "alice");

await fs.promises.mkdir(repoRoot, { recursive: true });
await execGit(["init", "-b", "main"], repoRoot);
await execGit(["config", "user.name", "Pi Teams Test"], repoRoot);
await execGit(["config", "user.email", "pi-teams-test@example.com"], repoRoot);
await fs.promises.writeFile(path.join(repoRoot, "README.md"), "hello\n", "utf8");
await execGit(["add", "README.md"], repoRoot);
await execGit(["commit", "-m", "init"], repoRoot);
await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
await execGit(["worktree", "add", "-b", "pi-teams/test/alice", worktreePath, "HEAD"], repoRoot);

const inspected = await inspectGitWorktree(worktreePath);
assert(inspected !== null, "inspectGitWorktree returns data for an existing worktree path");
assert(inspected?.registered === true, `expected worktree to be registered, got ${JSON.stringify(inspected)}`);
assert(inspected?.exists === true, `expected worktree path to exist, got ${JSON.stringify(inspected)}`);

const removal = await removeGitWorktree(worktreePath);
assert(removal.action === "git_remove", `expected git-aware removal, got ${JSON.stringify(removal)}`);
assert(removal.removed === true, `expected git-aware removal to report removed=true, got ${JSON.stringify(removal)}`);
assert(!fs.existsSync(worktreePath), "git worktree removal deletes worktree path");

await execGit(["worktree", "add", "-b", "pi-teams/test/bob", worktreePath, "HEAD"], repoRoot);
const cleanupResult = await cleanupManagedWorktrees(teamDir);
assert(cleanupResult.results.length === 1, `expected one managed worktree cleanup result, got ${JSON.stringify(cleanupResult)}`);
assert(cleanupResult.results[0]?.removed === true, `expected managed worktree cleanup to remove worktree, got ${JSON.stringify(cleanupResult)}`);
assert(!fs.existsSync(worktreePath), "cleanupManagedWorktrees removes managed git worktrees");

console.log("PASS: integration git worktree cleanup test passed");
