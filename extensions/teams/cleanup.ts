import * as fs from "node:fs";
import * as path from "node:path";
import { cleanupManagedWorktrees, shouldCleanupGitWorktrees } from "./worktree.js";

function assertPathWithinParent(parentDir: string, childPath: string, label: string): {
	parentAbs: string;
	childAbs: string;
} {
	const parentAbs = path.resolve(parentDir);
	const childAbs = path.resolve(childPath);
	const rel = path.relative(parentAbs, childAbs);
	if (!rel || rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Refusing to operate on ${label} outside parent. parent=${parentAbs} child=${childAbs}`);
	}
	return { parentAbs, childAbs };
}

export function assertTeamDirWithinTeamsRoot(teamsRootDir: string, teamDir: string): {
	teamsRootAbs: string;
	teamDirAbs: string;
} {
	const { parentAbs, childAbs } = assertPathWithinParent(teamsRootDir, teamDir, "teamDir");
	return { teamsRootAbs: parentAbs, teamDirAbs: childAbs };
}

export function getTeamWorktreesDir(teamDir: string): string {
	return path.join(teamDir, "worktrees");
}

export function assertWorktreePathWithinTeamDir(teamDir: string, worktreePath: string): {
	worktreesDirAbs: string;
	worktreeAbs: string;
} {
	const { parentAbs, childAbs } = assertPathWithinParent(getTeamWorktreesDir(teamDir), worktreePath, "worktree");
	return { worktreesDirAbs: parentAbs, worktreeAbs: childAbs };
}

export async function listManagedWorktreePaths(teamDir: string): Promise<string[]> {
	const worktreesDir = getTeamWorktreesDir(teamDir);
	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(worktreesDir, { withFileTypes: true });
	} catch (err: unknown) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return [];
		throw err;
	}

	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => assertWorktreePathWithinTeamDir(teamDir, path.join(worktreesDir, entry.name)).worktreeAbs)
		.sort((a, b) => a.localeCompare(b));
}

export interface TeamCleanupPlan {
	teamsRootAbs: string;
	teamDirAbs: string;
	worktreePaths: string[];
}

export function buildTeamCleanupPlan(
	teamsRootDir: string,
	teamDir: string,
	worktreePaths: string[],
): TeamCleanupPlan {
	const { teamsRootAbs, teamDirAbs } = assertTeamDirWithinTeamsRoot(teamsRootDir, teamDir);
	const normalizedWorktrees = worktreePaths
		.map((worktreePath) => assertWorktreePathWithinTeamDir(teamDirAbs, worktreePath).worktreeAbs)
		.sort((a, b) => a.localeCompare(b));
	return {
		teamsRootAbs,
		teamDirAbs,
		worktreePaths: normalizedWorktrees,
	};
}

/**
 * Recursively delete the given teamDir, but only if it's safely inside teamsRootDir.
 *
 * Uses fs.rm({ recursive: true, force: true }) so it's idempotent.
 */
export async function cleanupTeamDir(
	teamsRootDir: string,
	teamDir: string,
	opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const worktreePaths = await listManagedWorktreePaths(teamDir);
	const { teamDirAbs } = buildTeamCleanupPlan(teamsRootDir, teamDir, worktreePaths);
	if (shouldCleanupGitWorktrees(opts.env)) {
		await cleanupManagedWorktrees(teamDirAbs);
	}
	await fs.promises.rm(teamDirAbs, { recursive: true, force: true });
}
