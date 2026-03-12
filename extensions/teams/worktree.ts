import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { sanitizeName } from "./names.js";

function normalizeFsPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

async function execGit(args: string[], opts: { cwd: string; timeoutMs?: number } ): Promise<{ stdout: string; stderr: string }> {
	return await new Promise((resolve, reject) => {
		execFile(
			"git",
			args,
			{ cwd: opts.cwd, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 10 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err) {
					const msg = [
						`git ${args.join(" ")} failed`,
						`cwd=${opts.cwd}`,
						stderr ? `stderr=${String(stderr).trim()}` : "",
						err instanceof Error ? `error=${err.message}` : `error=${String(err)}`,
					]
						.filter(Boolean)
						.join("\n");
					reject(new Error(msg));
					return;
				}
				resolve({ stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});
}

function parseGitWorktreeList(raw: string): GitWorktreeEntry[] {
	const entries: GitWorktreeEntry[] = [];
	let current: GitWorktreeEntry | null = null;

	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) {
			if (current) entries.push(current);
			current = null;
			continue;
		}

		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = {
				worktreePath: normalizeFsPath(line.slice("worktree ".length).trim()),
				detached: false,
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
			continue;
		}
		if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).trim();
			continue;
		}
		if (line === "detached") {
			current.detached = true;
			continue;
		}
		if (line.startsWith("prunable ")) {
			current.prunable = line.slice("prunable ".length).trim();
		}
	}

	if (current) entries.push(current);
	return entries;
}

export async function listGitWorktreeEntries(repoRoot: string): Promise<GitWorktreeEntry[]> {
	const raw = await execGit(["worktree", "list", "--porcelain"], { cwd: repoRoot, timeoutMs: 30_000 });
	return parseGitWorktreeList(raw.stdout);
}

export async function inspectGitWorktreePath(opts: {
	repoRoot: string;
	worktreePath: string;
}): Promise<GitWorktreeInspection> {
	const worktreePath = normalizeFsPath(opts.worktreePath);
	const repoRoot = normalizeFsPath(opts.repoRoot);
	const entries = await listGitWorktreeEntries(repoRoot);
	const entry = entries.find((candidate) => candidate.worktreePath === worktreePath) ?? null;
	const exists = fs.existsSync(worktreePath);
	let dirty: boolean | null = null;
	if (exists && entry) {
		const status = await execGit(["status", "--porcelain"], { cwd: worktreePath, timeoutMs: 30_000 });
		dirty = status.stdout.trim().length > 0;
	}

	return {
		repoRoot,
		worktreePath,
		exists,
		registered: entry !== null,
		branch: entry?.branch ?? null,
		detached: entry?.detached ?? false,
		prunable: entry?.prunable ?? null,
		dirty,
	};
}

export function planGitWorktreeCleanupAction(inspection: GitWorktreeInspection): GitWorktreeCleanupAction {
	if (!inspection.exists) return "skip_missing";
	if (inspection.registered) return "git_remove";
	return "fs_remove_only";
}

export type WorktreeResult = {
	cwd: string;
	warnings: string[];
	mode: "worktree" | "shared";
};

export interface GitWorktreeEntry {
	worktreePath: string;
	head?: string;
	branch?: string;
	detached: boolean;
	prunable?: string;
}

export interface GitWorktreeInspection {
	repoRoot: string;
	worktreePath: string;
	exists: boolean;
	registered: boolean;
	branch: string | null;
	detached: boolean;
	prunable: string | null;
	dirty: boolean | null;
}

export type GitWorktreeCleanupAction = "git_remove" | "fs_remove_only" | "skip_missing";

export interface GitWorktreeCleanupResult {
	worktreePath: string;
	action: GitWorktreeCleanupAction;
	removed: boolean;
	registered: boolean;
	warnings: string[];
}

export interface ManagedWorktreeCleanupResult {
	results: GitWorktreeCleanupResult[];
}

function normalizeBranchName(ref: string | undefined): string | null {
	if (!ref) return null;
	const prefix = "refs/heads/";
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function parseGitWorktreeListPorcelain(stdout: string): GitWorktreeEntry[] {
	const entries: GitWorktreeEntry[] = [];
	const blocks = stdout
		.split(/\n\s*\n/g)
		.map((block) => block.trim())
		.filter((block) => block.length > 0);

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		let worktreePath: string | undefined;
		let head: string | undefined;
		let branch: string | undefined;
		let detached = false;
		let prunable: string | undefined;
		for (const line of lines) {
			if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length).trim();
			else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
			else if (line.startsWith("branch ")) branch = normalizeBranchName(line.slice("branch ".length).trim()) ?? undefined;
			else if (line === "detached") detached = true;
			else if (line.startsWith("prunable ")) prunable = line.slice("prunable ".length).trim();
		}
		if (!worktreePath) continue;
		entries.push({ worktreePath, head, branch, detached, prunable });
	}

	return entries;
}

async function resolveGitRepoRoot(cwd: string): Promise<string | null> {
	try {
		const commonDirRaw = (await execGit(["rev-parse", "--git-common-dir"], { cwd })).stdout.trim();
		if (!commonDirRaw) return null;
		const commonDirAbs = path.resolve(cwd, commonDirRaw);
		return path.dirname(commonDirAbs);
	} catch {
		return null;
	}
}

export async function inspectGitWorktree(worktreePath: string): Promise<GitWorktreeInspection | null> {
	const worktreeAbs = normalizeFsPath(worktreePath);
	const exists = fs.existsSync(worktreeAbs);
	if (!exists) {
		return {
			repoRoot: worktreeAbs,
			worktreePath: worktreeAbs,
			exists: false,
			registered: false,
			branch: null,
			detached: false,
			prunable: null,
			dirty: null,
		};
	}

	const repoRoot = await resolveGitRepoRoot(worktreeAbs);
	if (!repoRoot) return null;

	const entries = await (async (): Promise<GitWorktreeEntry[] | null> => {
		try {
			return parseGitWorktreeListPorcelain((await execGit(["worktree", "list", "--porcelain"], { cwd: repoRoot })).stdout).map((entry) => ({
				...entry,
				worktreePath: normalizeFsPath(entry.worktreePath),
			}));
		} catch {
			return null;
		}
	})();
	if (entries === null) {
		return {
			repoRoot,
			worktreePath: worktreeAbs,
			exists: true,
			registered: false,
			branch: null,
			detached: false,
			prunable: null,
			dirty: null,
		};
	}

	const entry = entries.find((candidate) => candidate.worktreePath === worktreeAbs);
	const dirty = await (async (): Promise<boolean | null> => {
		try {
			const status = (await execGit(["status", "--porcelain"], { cwd: worktreeAbs })).stdout;
			return status.trim().length > 0;
		} catch {
			return null;
		}
	})();

	return {
		repoRoot,
		worktreePath: worktreeAbs,
		exists: true,
		registered: Boolean(entry),
		branch: entry?.branch ?? null,
		detached: entry?.detached ?? false,
		prunable: entry?.prunable ?? null,
		dirty,
	};
}

export async function removeGitWorktree(worktreePath: string): Promise<GitWorktreeCleanupResult> {
	const worktreeAbs = normalizeFsPath(worktreePath);
	if (!fs.existsSync(worktreeAbs)) {
		return {
			worktreePath: worktreeAbs,
			action: "skip_missing",
			removed: false,
			registered: false,
			warnings: [],
		};
	}

	const inspection = await inspectGitWorktree(worktreeAbs);
	if (!inspection) {
		await fs.promises.rm(worktreeAbs, { recursive: true, force: true });
		return {
			worktreePath: worktreeAbs,
			action: "fs_remove_only",
			removed: !fs.existsSync(worktreeAbs),
			registered: false,
			warnings: ["Git inspection unavailable; removed worktree path from filesystem only."],
		};
	}

	if (inspection.registered) {
		await execGit(["worktree", "remove", "--force", worktreeAbs], { cwd: inspection.repoRoot, timeoutMs: 120_000 });
		if (fs.existsSync(worktreeAbs)) {
			await fs.promises.rm(worktreeAbs, { recursive: true, force: true });
		}
		return {
			worktreePath: worktreeAbs,
			action: "git_remove",
			removed: !fs.existsSync(worktreeAbs),
			registered: true,
			warnings: [],
		};
	}

	await fs.promises.rm(worktreeAbs, { recursive: true, force: true });
	return {
		worktreePath: worktreeAbs,
		action: "fs_remove_only",
		removed: !fs.existsSync(worktreeAbs),
		registered: false,
		warnings: ["Worktree path was not registered in git worktree list; removed from filesystem only."],
	};
}

export async function cleanupManagedWorktrees(teamDir: string): Promise<ManagedWorktreeCleanupResult> {
	const worktreesDir = path.join(teamDir, "worktrees");
	const entries = await (async (): Promise<fs.Dirent[]> => {
		try {
			return await fs.promises.readdir(worktreesDir, { withFileTypes: true });
		} catch (err: unknown) {
			if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw err;
		}
	})();

	const results: GitWorktreeCleanupResult[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		results.push(await removeGitWorktree(path.join(worktreesDir, entry.name)));
	}
	return { results };
}

export function shouldCleanupGitWorktrees(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.PI_TEAMS_WORKTREE_CLEANUP === "1";
}

/**
 * Ensure a per-teammate git worktree exists, returning the cwd to use for that teammate.
 *
 * Behavior:
 * - If not in a git repo, falls back to shared cwd with a warning.
 * - If git repo is dirty, still creates a worktree but warns that uncommitted changes are not included.
 */
export async function ensureWorktreeCwd(opts: {
	leaderCwd: string;
	teamDir: string;
	teamId: string;
	agentName: string;
}): Promise<WorktreeResult> {
	const warnings: string[] = [];
	let repoRoot: string;
	try {
		repoRoot = (await execGit(["rev-parse", "--show-toplevel"], { cwd: opts.leaderCwd })).stdout.trim();
		if (!repoRoot) throw new Error("empty git toplevel");
	} catch {
		warnings.push("Not a git repository (or git unavailable). Using shared workspace instead of worktree.");
		return { cwd: opts.leaderCwd, warnings, mode: "shared" };
	}

	try {
		const status = (await execGit(["status", "--porcelain"], { cwd: repoRoot })).stdout;
		if (status.trim().length) {
			warnings.push(
				"Git working directory is not clean. Worktree will be created from current HEAD and will NOT include your uncommitted changes.",
			);
		}
	} catch {
		// ignore status errors
	}

	const safeAgent = sanitizeName(opts.agentName);
	const shortTeam = sanitizeName(opts.teamId).slice(0, 12) || "team";
	const branch = `pi-teams/${shortTeam}/${safeAgent}`;

	const worktreesDir = path.join(opts.teamDir, "worktrees");
	const worktreePath = path.join(worktreesDir, safeAgent);
	await fs.promises.mkdir(worktreesDir, { recursive: true });

	// Reuse if it already exists.
	if (fs.existsSync(worktreePath)) {
		return { cwd: worktreePath, warnings, mode: "worktree" };
	}

	try {
		// Create worktree + new branch from HEAD
		await execGit(["worktree", "add", "-b", branch, worktreePath, "HEAD"], { cwd: repoRoot, timeoutMs: 120_000 });
		return { cwd: worktreePath, warnings, mode: "worktree" };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		// If the branch already exists (e.g. previous run), try adding worktree using the existing branch.
		if (msg.includes("already exists") || msg.includes("is already checked out")) {
			try {
				await execGit(["worktree", "add", worktreePath, branch], { cwd: repoRoot, timeoutMs: 120_000 });
				return { cwd: worktreePath, warnings, mode: "worktree" };
			} catch {
				// fall through
			}
		}

		warnings.push(`Failed to create git worktree (${branch}). Using shared workspace instead.`);
		return { cwd: opts.leaderCwd, warnings, mode: "shared" };
	}
}
