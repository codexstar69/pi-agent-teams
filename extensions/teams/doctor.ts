import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assessWorkerHeartbeatFreshness } from "./heartbeat-lease.js";
import { listManagedWorktreePaths } from "./cleanup.js";
import type { TeamConfig } from "./team-config.js";

export interface DoctorStaleWorker {
	name: string;
	lastSeenAt?: string;
	reason: "stale" | "missing" | "invalid";
	ageMs: number | null;
}

export interface DoctorManagedWorktree {
	worktreePath: string;
	exists: boolean;
}

export interface DoctorStaleLock {
	lockFilePath: string;
	label?: string;
	pid?: number;
	hostname?: string;
	createdAt?: string;
	ageMs: number;
	reason: "dead_owner" | "stale_age";
}

export interface TeamDoctorReport {
	teamDir: string;
	staleWorkers: DoctorStaleWorker[];
	managedWorktrees: DoctorManagedWorktree[];
	staleLocks: DoctorStaleLock[];
	summary: string;
}

function formatAgeMs(ageMs: number | null): string {
	if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
	if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
	const sec = Math.round(ageMs / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.round(sec / 60);
	return `${min}m`;
}

interface LockMetadata {
	pid?: number;
	hostname?: string;
	createdAt?: string;
	label?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function readLockMetadata(lockFilePath: string): LockMetadata | null {
	try {
		const raw = fs.readFileSync(lockFilePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return null;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
			hostname: typeof parsed.hostname === "string" ? parsed.hostname : undefined,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
			label: typeof parsed.label === "string" ? parsed.label : undefined,
		};
	} catch {
		return null;
	}
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ESRCH") return false;
		if (isErrnoException(err) && err.code === "EPERM") return true;
		return true;
	}
}

async function listLockFilesRecursive(rootDir: string): Promise<string[]> {
	const out: string[] = [];
	const walk = async (dir: string) => {
		let entries: fs.Dirent[] = [];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (err: unknown) {
			if (isErrnoException(err) && err.code === "ENOENT") return;
			throw err;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(fullPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".lock")) out.push(path.resolve(fullPath));
		}
	};
	await walk(rootDir);
	return out.sort((a, b) => a.localeCompare(b));
}

async function inspectStaleLocks(teamDir: string, nowMs: number, staleMs: number): Promise<DoctorStaleLock[]> {
	const currentHostname = os.hostname();
	const lockFiles = await listLockFilesRecursive(teamDir);
	const out: DoctorStaleLock[] = [];
	for (const lockFilePath of lockFiles) {
		let st: fs.Stats;
		try {
			st = await fs.promises.stat(lockFilePath);
		} catch {
			continue;
		}
		const ageMs = Math.max(0, nowMs - st.mtimeMs);
		const metadata = readLockMetadata(lockFilePath);
		const sameHost = metadata?.hostname ? metadata.hostname === currentHostname : true;
		const ownerAlive = sameHost && typeof metadata?.pid === "number" ? isPidAlive(metadata.pid) : null;
		if (ownerAlive === false) {
			out.push({
				lockFilePath,
				label: metadata?.label,
				pid: metadata?.pid,
				hostname: metadata?.hostname,
				createdAt: metadata?.createdAt,
				ageMs,
				reason: "dead_owner",
			});
			continue;
		}
		if (ageMs > staleMs && ownerAlive !== true) {
			out.push({
				lockFilePath,
				label: metadata?.label,
				pid: metadata?.pid,
				hostname: metadata?.hostname,
				createdAt: metadata?.createdAt,
				ageMs,
				reason: "stale_age",
			});
		}
	}
	return out;
}

function summarizeDoctorReport(report: {
	staleWorkers: number;
	staleLocks: number;
	managedWorktrees: number;
}): string {
	const parts = [
		`${report.staleWorkers} stale worker${report.staleWorkers === 1 ? "" : "s"}`,
		`${report.staleLocks} stale lock${report.staleLocks === 1 ? "" : "s"}`,
		`${report.managedWorktrees} managed worktree${report.managedWorktrees === 1 ? "" : "s"}`,
	];
	return parts.join(", ");
}

export function formatTeamDoctorReport(report: TeamDoctorReport): string {
	const lines: string[] = [];
	lines.push(`Team doctor: ${report.teamDir}`);
	lines.push(`Summary: ${report.summary}`);
	lines.push("");
	lines.push(`Stale workers (${report.staleWorkers.length}):`);
	if (report.staleWorkers.length === 0) lines.push("  - none");
	for (const worker of report.staleWorkers) {
		lines.push(`  - ${worker.name} · reason=${worker.reason} · age=${formatAgeMs(worker.ageMs)}`);
	}
	lines.push("");
	lines.push(`Managed worktrees (${report.managedWorktrees.length}):`);
	if (report.managedWorktrees.length === 0) lines.push("  - none");
	for (const worktree of report.managedWorktrees) {
		lines.push(`  - ${worktree.worktreePath}${worktree.exists ? "" : " (missing)"}`);
	}
	lines.push("");
	lines.push(`Stale locks (${report.staleLocks.length}):`);
	if (report.staleLocks.length === 0) lines.push("  - none");
	for (const lock of report.staleLocks) {
		lines.push(
			`  - ${lock.lockFilePath} · reason=${lock.reason} · age=${formatAgeMs(lock.ageMs)}${lock.label ? ` · label=${lock.label}` : ""}`,
		);
	}
	return lines.join("\n");
}

export async function collectTeamDoctorReport(opts: {
	teamDir: string;
	teamConfig: TeamConfig | null;
	nowMs?: number;
	heartbeatStaleMs?: number;
	lockStaleMs?: number;
}): Promise<TeamDoctorReport> {
	const teamDir = path.resolve(opts.teamDir);
	const nowMs = opts.nowMs ?? Date.now();
	const heartbeatStaleMs = Math.max(1, opts.heartbeatStaleMs ?? 30_000);
	const lockStaleMs = Math.max(1, opts.lockStaleMs ?? 60_000);

	const staleWorkers: DoctorStaleWorker[] = [];
	for (const member of opts.teamConfig?.members ?? []) {
		if (member.role !== "worker" || member.status !== "online") continue;
		const freshness = assessWorkerHeartbeatFreshness(member.lastSeenAt, nowMs, heartbeatStaleMs);
		if (!freshness.isStale || freshness.reason === "fresh") continue;
		staleWorkers.push({
			name: member.name,
			lastSeenAt: member.lastSeenAt,
			reason: freshness.reason,
			ageMs: freshness.ageMs,
		});
	}

	const managedWorktrees = (await listManagedWorktreePaths(teamDir)).map((worktreePath) => ({
		worktreePath,
		exists: fs.existsSync(worktreePath),
	}));
	const staleLocks = await inspectStaleLocks(teamDir, nowMs, lockStaleMs);

	return {
		teamDir,
		staleWorkers,
		managedWorktrees,
		staleLocks,
		summary: summarizeDoctorReport({
			staleWorkers: staleWorkers.length,
			staleLocks: staleLocks.length,
			managedWorktrees: managedWorktrees.length,
		}),
	};
}
