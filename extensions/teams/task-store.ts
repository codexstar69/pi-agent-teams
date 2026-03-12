import * as fs from "node:fs";
import * as path from "node:path";
import {
	applyTaskLeaseMetadata,
	createTaskLease,
	readTaskLeaseMetadata,
	refreshTaskLease,
	shouldRecoverLeasedTask,
} from "./heartbeat-lease.js";
import { appendTeamEvent } from "./event-log.js";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTask {
	id: string; // stringified integer (Claude-style)
	subject: string;
	description: string;
	owner?: string; // agent name
	status: TaskStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface RetryableFailureOptions {
	reason?: string;
	partialResult?: string;
	failureKind?: string;
	nowMs?: number;
	baseDelayMs?: number;
	maxAttempts?: number;
	extraMetadata?: Record<string, unknown>;
}

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export function getTaskListDir(teamDir: string, taskListId: string): string {
	return path.join(teamDir, "tasks", sanitizeName(taskListId));
}

function taskPath(taskListDir: string, taskId: string): string {
	return path.join(taskListDir, `${sanitizeName(taskId)}.json`);
}

export interface TaskStoreCacheStats {
	fileReads: number;
	fileCacheHits: number;
	listReads: number;
	listCacheHits: number;
	invalidations: number;
}

type TaskFileCacheEntry = {
	signature: string;
	task: TeamTask | null;
};

type TaskListCacheEntry = {
	signature: string;
	tasks: TeamTask[];
};

const taskFileCache = new Map<string, TaskFileCacheEntry>();
const taskListCache = new Map<string, TaskListCacheEntry>();
const taskStoreCacheStats: TaskStoreCacheStats = {
	fileReads: 0,
	fileCacheHits: 0,
	listReads: 0,
	listCacheHits: 0,
	invalidations: 0,
};

function cloneTask(task: TeamTask | null): TeamTask | null {
	if (!task) return null;
	return {
		...task,
		blocks: [...task.blocks],
		blockedBy: [...task.blockedBy],
		metadata: task.metadata ? { ...task.metadata } : undefined,
	};
}

function cloneTasks(tasks: TeamTask[]): TeamTask[] {
	return tasks.map((task) => cloneTask(task)).filter((task): task is TeamTask => task !== null);
}

function getTaskFileSignature(stat: fs.Stats): string {
	return `${stat.size}:${Math.round(stat.mtimeMs)}`;
}

function invalidateTaskFileCache(file: string): void {
	taskFileCache.delete(file);
	taskListCache.delete(path.dirname(file));
	taskStoreCacheStats.invalidations += 1;
}

function invalidateTaskListCache(taskListDir: string): void {
	taskListCache.delete(taskListDir);
	taskStoreCacheStats.invalidations += 1;
}

export function clearTaskStoreCache(): void {
	taskFileCache.clear();
	taskListCache.clear();
	taskStoreCacheStats.fileReads = 0;
	taskStoreCacheStats.fileCacheHits = 0;
	taskStoreCacheStats.listReads = 0;
	taskStoreCacheStats.listCacheHits = 0;
	taskStoreCacheStats.invalidations = 0;
}

export function getTaskStoreCacheStats(): TaskStoreCacheStats {
	return { ...taskStoreCacheStats };
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function toStringArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

async function readJson(file: string): Promise<unknown | null> {
	try {
		const raw = await fs.promises.readFile(file, "utf8");
		const parsed: unknown = JSON.parse(raw);
		return parsed;
	} catch {
		return null;
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, file);
	invalidateTaskFileCache(file);
}

async function readTaskFromFileCached(file: string, signature?: string): Promise<TeamTask | null> {
	let effectiveSignature = signature;
	if (!effectiveSignature) {
		try {
			const stat = await fs.promises.stat(file);
			effectiveSignature = getTaskFileSignature(stat);
		} catch {
			invalidateTaskFileCache(file);
			return null;
		}
	}

	const cached = taskFileCache.get(file);
	if (cached && cached.signature === effectiveSignature) {
		taskStoreCacheStats.fileCacheHits += 1;
		return cloneTask(cached.task);
	}

	taskStoreCacheStats.fileReads += 1;
	const obj = await readJson(file);
	const task = coerceTask(obj);
	taskFileCache.set(file, { signature: effectiveSignature, task: cloneTask(task) });
	return cloneTask(task);
}

async function appendTaskEvent(
	teamDir: string,
	event: {
		kind: string;
		taskListId: string;
		taskId?: string;
		member?: string;
		data?: Record<string, unknown>;
	},
): Promise<void> {
	try {
		await appendTeamEvent(teamDir, {
			ts: new Date().toISOString(),
			kind: event.kind,
			taskListId: event.taskListId,
			taskId: event.taskId,
			member: event.member,
			data: event.data,
		});
	} catch {
		// event logging is best-effort and should never break task operations
	}
}

function isStatus(s: unknown): s is TaskStatus {
	return s === "pending" || s === "in_progress" || s === "completed";
}

function coerceTask(obj: unknown): TeamTask | null {
	if (!isRecord(obj)) return null;
	if (typeof obj.id !== "string") return null;
	if (typeof obj.subject !== "string") return null;
	if (typeof obj.description !== "string") return null;
	if (!isStatus(obj.status)) return null;

	const now = new Date().toISOString();
	return {
		id: obj.id,
		subject: obj.subject,
		description: obj.description,
		owner: typeof obj.owner === "string" ? obj.owner : undefined,
		status: obj.status,
		blocks: toStringArray(obj.blocks),
		blockedBy: toStringArray(obj.blockedBy),
		metadata: isRecord(obj.metadata) ? obj.metadata : undefined,
		createdAt: typeof obj.createdAt === "string" ? obj.createdAt : now,
		updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : now,
	};
}

function getMetadataInt(task: TeamTask, key: string): number {
	const value = task.metadata?.[key];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return Math.floor(value);
}

function getMetadataBool(task: TeamTask, key: string): boolean {
	return task.metadata?.[key] === true;
}

function getCooldownUntilMs(task: TeamTask): number | null {
	const value = task.metadata?.cooldownUntil;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function getTaskPriority(task: TeamTask): TaskPriority {
	const raw = task.metadata?.priority;
	if (raw === "low" || raw === "normal" || raw === "high" || raw === "urgent") return raw;
	return "normal";
}

export function getTaskPriorityRank(priority: TaskPriority): number {
	switch (priority) {
		case "urgent":
			return 3;
		case "high":
			return 2;
		case "normal":
			return 1;
		case "low":
			return 0;
	}
}

function compareTaskPriority(a: TeamTask, b: TeamTask): number {
	const rankDiff = getTaskPriorityRank(getTaskPriority(b)) - getTaskPriorityRank(getTaskPriority(a));
	if (rankDiff !== 0) return rankDiff;
	return a.id.localeCompare(b.id, undefined, { numeric: true });
}

function withoutTaskLeaseMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata) return undefined;
	const next = { ...metadata };
	delete next.taskLease;
	return Object.keys(next).length > 0 ? next : undefined;
}

function withTaskLeaseMetadata(
	metadata: Record<string, unknown> | undefined,
	owner: string,
	opts: { nowMs?: number; leaseDurationMs?: number } = {},
): Record<string, unknown> {
	const base = withoutTaskLeaseMetadata(metadata) ?? {};
	const lease = createTaskLease(owner, {
		nowMs: opts.nowMs,
		leaseDurationMs: opts.leaseDurationMs,
	});
	return applyTaskLeaseMetadata(base, lease);
}

export function isTaskRetryExhausted(task: TeamTask): boolean {
	return getMetadataBool(task, "retryExhausted");
}

export function isTaskCoolingDown(task: TeamTask, nowMs = Date.now()): boolean {
	if (isTaskRetryExhausted(task)) return false;
	const cooldownUntilMs = getCooldownUntilMs(task);
	if (cooldownUntilMs === null) return false;
	return cooldownUntilMs > nowMs;
}

function isTaskClaimableNow(task: TeamTask, nowMs = Date.now()): boolean {
	if (task.status !== "pending") return false;
	if (task.owner) return false;
	if (isTaskRetryExhausted(task)) return false;
	if (isTaskCoolingDown(task, nowMs)) return false;
	return true;
}

async function allocateTaskId(taskListDir: string): Promise<string> {
	await ensureDir(taskListDir);

	const highwater = path.join(taskListDir, ".highwatermark");
	const lock = `${highwater}.lock`;

	return await withLock(
		lock,
		async () => {
			let n = 0;
			try {
				const raw = await fs.promises.readFile(highwater, "utf8");
				const parsed = Number.parseInt(raw.trim(), 10);
				if (Number.isFinite(parsed) && parsed > 0) n = parsed;
			} catch {
				// ignore
			}
			n += 1;
			await fs.promises.writeFile(highwater, `${n}\n`, "utf8");
			return String(n);
		},
		{ label: "tasks:allocate" },
	);
}

export function shortTaskId(id: string): string {
	return id;
}

export function formatTaskLine(t: TeamTask, opts: { blocked?: boolean } = {}): string {
	const blocked = Boolean(opts.blocked);
	const status = blocked && t.status === "pending" ? "blocked" : t.status;

	const deps = t.blockedBy?.length ?? 0;
	const blocks = t.blocks?.length ?? 0;

	const who = t.owner ? `@${t.owner}` : "";
	const head = `${t.id.padStart(3, " ")} ${status.padEnd(11)} ${who}`.trimEnd();

	const tags: string[] = [];
	if (blocked && t.status === "in_progress") tags.push("blocked");
	if (deps) tags.push(`deps:${deps}`);
	if (blocks) tags.push(`blocks:${blocks}`);
	const tagText = tags.length ? ` [${tags.join(" ")}]` : "";

	const preview = t.subject.length > 80 ? `${t.subject.slice(0, 80)}…` : t.subject;
	return `${head}${tagText}  ${preview}`;
}

export async function listTasks(teamDir: string, taskListId: string): Promise<TeamTask[]> {
	const dir = getTaskListDir(teamDir, taskListId);
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		const files = entries
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		const fileInfos = await Promise.all(
			files.map(async (name) => {
				const file = path.join(dir, name);
				const stat = await fs.promises.stat(file);
				return { file, signature: getTaskFileSignature(stat) };
			}),
		);
		const listSignature = fileInfos.map((info) => `${path.basename(info.file)}:${info.signature}`).join("|");
		const cached = taskListCache.get(dir);
		if (cached && cached.signature === listSignature) {
			taskStoreCacheStats.listCacheHits += 1;
			return cloneTasks(cached.tasks);
		}

		taskStoreCacheStats.listReads += 1;
		const out: TeamTask[] = [];
		for (const info of fileInfos) {
			const task = await readTaskFromFileCached(info.file, info.signature);
			if (task) out.push(task);
		}
		taskListCache.set(dir, { signature: listSignature, tasks: cloneTasks(out) });
		return cloneTasks(out);
	} catch {
		invalidateTaskListCache(dir);
		return [];
	}
}

export async function getTask(teamDir: string, taskListId: string, taskId: string): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	return await readTaskFromFileCached(taskPath(dir, taskId));
}

export async function createTask(
	teamDir: string,
	taskListId: string,
	input: { subject: string; description: string; owner?: string },
): Promise<TeamTask> {
	const dir = getTaskListDir(teamDir, taskListId);
	const id = await allocateTaskId(dir);
	const now = new Date().toISOString();
	const task: TeamTask = {
		id,
		subject: input.subject,
		description: input.description,
		owner: input.owner,
		status: "pending",
		blocks: [],
		blockedBy: [],
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};

	await writeJsonAtomic(taskPath(dir, id), task);
	await appendTaskEvent(teamDir, {
		kind: "task_created",
		taskListId,
		taskId: task.id,
		member: input.owner,
		data: { subject: task.subject, owner: task.owner ?? null },
	});
	return task;
}

export async function updateTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	updater: (current: TeamTask) => TeamTask,
): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	const file = taskPath(dir, taskId);
	const lock = `${file}.lock`;

	await ensureDir(dir);

	return await withLock(
		lock,
		async () => {
			const curObj = await readJson(file);
			const cur = coerceTask(curObj);
			if (!cur) return null;
			const next = updater({ ...cur });
			next.updatedAt = new Date().toISOString();
			await writeJsonAtomic(file, next);
			return next;
		},
		{ label: `tasks:update:${taskId}` },
	);
}

export async function isTaskBlocked(teamDir: string, taskListId: string, task: TeamTask): Promise<boolean> {
	if (!task.blockedBy?.length) return false;
	for (const depId of task.blockedBy) {
		const dep = await getTask(teamDir, taskListId, depId);
		if (!dep) return true;
		if (dep.status !== "completed") return true;
	}
	return false;
}

export async function agentHasActiveTask(teamDir: string, taskListId: string, agentName: string): Promise<boolean> {
	const tasks = await listTasks(teamDir, taskListId);
	return tasks.some((t) => t.owner === agentName && t.status === "in_progress");
}

/**
 * Claim a specific task (owner must be empty).
 * Returns the updated task if claim succeeded, otherwise null.
 */
export async function claimTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean; checkBlocked?: boolean; nowMs?: number; leaseDurationMs?: number } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	// BUG-1 fix: check dependency blocking before claiming.
	if (opts.checkBlocked !== false) {
		const task = await getTask(teamDir, taskListId, taskId);
		if (task && (await isTaskBlocked(teamDir, taskListId, task))) return null;
	}

	const updated = await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (!isTaskClaimableNow(cur, opts.nowMs)) return cur;
		return {
			...cur,
			owner: agentName,
			status: "in_progress",
			metadata: withTaskLeaseMetadata(cur.metadata, agentName, {
				nowMs: opts.nowMs,
				leaseDurationMs: opts.leaseDurationMs,
			}),
		};
	});
	if (updated?.owner === agentName && updated.status === "in_progress") {
		await appendTaskEvent(teamDir, {
			kind: "task_claimed",
			taskListId,
			taskId: updated.id,
			member: agentName,
			data: { owner: agentName },
		});
	}
	return updated;
}

/**
 * Start an assigned task (owner matches), marking it in_progress.
 */
export async function startAssignedTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: { nowMs?: number; leaseDurationMs?: number } = {},
): Promise<TeamTask | null> {
	const updated = await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status !== "pending") return cur;
		return {
			...cur,
			status: "in_progress",
			metadata: withTaskLeaseMetadata(cur.metadata, agentName, {
				nowMs: opts.nowMs,
				leaseDurationMs: opts.leaseDurationMs,
			}),
		};
	});
	if (updated?.owner === agentName && updated.status === "in_progress") {
		await appendTaskEvent(teamDir, {
			kind: "task_started",
			taskListId,
			taskId: updated.id,
			member: agentName,
			data: { owner: agentName },
		});
	}
	return updated;
}

export async function completeTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	result?: string,
): Promise<TeamTask | null> {
	const updated = await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;
		const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
		if (result) metadata.result = result;
		metadata.completedAt = new Date().toISOString();
		return { ...cur, status: "completed", metadata };
	});
	if (updated?.status === "completed") {
		await appendTaskEvent(teamDir, {
			kind: "task_completed",
			taskListId,
			taskId: updated.id,
			member: agentName,
			data: { owner: agentName },
		});
	}
	return updated;
}

export async function unassignTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	reason?: string,
	extraMetadata?: Record<string, unknown>,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;

		const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
		if (reason) metadata.unassignedReason = reason;
		metadata.unassignedAt = new Date().toISOString();
		if (extraMetadata) Object.assign(metadata, extraMetadata);

		return {
			...cur,
			owner: undefined,
			status: "pending",
			metadata,
		};
	});
}

/** Reset all non-completed tasks owned by agent back to pending + unowned. */
export async function unassignTasksForAgent(
	teamDir: string,
	taskListId: string,
	agentName: string,
	reason?: string,
): Promise<number> {
	const tasks = await listTasks(teamDir, taskListId);
	let changed = 0;
	for (const t of tasks) {
		if (t.owner !== agentName) continue;
		if (t.status === "completed") continue;
		const updated = await updateTask(teamDir, taskListId, t.id, (cur) => {
			// Re-check ownership under the per-task lock to avoid races with other claimers.
			if (cur.owner !== agentName) return cur;
			if (cur.status === "completed") return cur;

			const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
			if (reason) metadata.unassignedReason = reason;
			metadata.unassignedAt = new Date().toISOString();
			return {
				...cur,
				owner: undefined,
				status: "pending",
				metadata,
			};
		});
		if (updated) changed += 1;
	}

	// BUG-3 fix: second pass to catch tasks assigned during the first pass (TOCTOU gap).
	const secondPass = await listTasks(teamDir, taskListId);
	const firstPassIds = new Set(tasks.map((t) => t.id));
	for (const t of secondPass) {
		if (firstPassIds.has(t.id)) continue;
		if (t.owner !== agentName) continue;
		if (t.status === "completed") continue;
		const updated = await updateTask(teamDir, taskListId, t.id, (cur) => {
			if (cur.owner !== agentName) return cur;
			if (cur.status === "completed") return cur;

			const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
			if (reason) metadata.unassignedReason = reason;
			metadata.unassignedAt = new Date().toISOString();
			return {
				...cur,
				owner: undefined,
				status: "pending",
				metadata,
			};
		});
		if (updated) changed += 1;
	}

	return changed;
}

export async function refreshTaskLeaseHeartbeat(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: { nowMs?: number; leaseDurationMs?: number } = {},
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status !== "in_progress") return cur;

		const existingLease = readTaskLeaseMetadata(cur.metadata);
		const nextLease = existingLease
			? refreshTaskLease(existingLease, agentName, { nowMs: opts.nowMs, leaseDurationMs: opts.leaseDurationMs })
			: createTaskLease(agentName, { nowMs: opts.nowMs, leaseDurationMs: opts.leaseDurationMs });
		if (!nextLease) return cur;

		return {
			...cur,
			metadata: applyTaskLeaseMetadata(withoutTaskLeaseMetadata(cur.metadata) ?? {}, nextLease),
		};
	});
}

export async function recoverLeasedTaskIfStale(
	teamDir: string,
	taskListId: string,
	taskId: string,
	opts: { ownerLastSeenAt?: string; nowMs?: number; heartbeatStaleMs?: number } = {},
): Promise<TeamTask | null> {
	const updated = await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.status !== "in_progress") return cur;
		const decision = shouldRecoverLeasedTask({
			taskMetadata: cur.metadata,
			ownerLastSeenAt: opts.ownerLastSeenAt,
			nowMs: opts.nowMs,
			heartbeatStaleMs: opts.heartbeatStaleMs,
		});
		if (!decision.recover) return cur;

		const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
		metadata.leaseRecoveryReason = decision.reason;
		metadata.leaseRecoveryAt = new Date(opts.nowMs ?? Date.now()).toISOString();
		return {
			...cur,
			owner: undefined,
			status: "pending",
			metadata,
		};
	});
	if (updated?.status === "pending" && updated.owner === undefined && updated.metadata?.leaseRecoveryAt) {
		await appendTaskEvent(teamDir, {
			kind: "task_recovered",
			taskListId,
			taskId: updated.id,
			data: { reason: updated.metadata.leaseRecoveryReason },
		});
	}
	return updated;
}

export async function markTaskRetryableFailure(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: RetryableFailureOptions = {},
): Promise<TeamTask | null> {
	const nowMs = opts.nowMs ?? Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const baseDelayMs = Math.max(0, Math.floor(opts.baseDelayMs ?? 5_000));
	const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 3));

	const updated = await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;

		const retryCount = getMetadataInt(cur, "retryCount") + 1;
		const retryExhausted = retryCount >= maxAttempts;
		const metadata = withoutTaskLeaseMetadata(cur.metadata) ?? {};
		const cooldownDelayMs = retryExhausted ? 0 : baseDelayMs * 2 ** Math.max(0, retryCount - 1);

		metadata.retryCount = retryCount;
		metadata.retryLimit = maxAttempts;
		metadata.retryExhausted = retryExhausted;
		metadata.lastFailureAt = nowIso;
		metadata.failureKind = opts.failureKind ?? "retryable";
		if (opts.reason) metadata.lastFailureReason = opts.reason;
		if (opts.partialResult) metadata.partialResult = opts.partialResult;
		metadata.cooldownDelayMs = cooldownDelayMs;
		if (retryExhausted) delete metadata.cooldownUntil;
		else metadata.cooldownUntil = new Date(nowMs + cooldownDelayMs).toISOString();
		if (opts.extraMetadata) Object.assign(metadata, opts.extraMetadata);

		return {
			...cur,
			owner: undefined,
			status: "pending",
			metadata,
		};
	});
	if (updated?.status === "pending") {
		await appendTaskEvent(teamDir, {
			kind: "task_retryable_failure",
			taskListId,
			taskId: updated.id,
			member: agentName,
			data: {
				retryCount: updated.metadata?.retryCount,
				retryExhausted: updated.metadata?.retryExhausted,
				reason: updated.metadata?.lastFailureReason,
			},
		});
	}
	return updated;
}

/**
 * Find and claim the first available task:
 * - pending
 * - unowned
 * - unblocked
 */
export async function claimNextAvailableTask(
	teamDir: string,
	taskListId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean; nowMs?: number; leaseDurationMs?: number } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	const tasks = await listTasks(teamDir, taskListId);
	const orderedTasks = tasks.slice().sort(compareTaskPriority);
	for (const t of orderedTasks) {
		if (!isTaskClaimableNow(t, opts.nowMs)) continue;
		if (await isTaskBlocked(teamDir, taskListId, t)) continue;

		const claimed = await claimTask(teamDir, taskListId, t.id, agentName, {
			checkAgentBusy: false,
			checkBlocked: false, // BUG-9 fix: already checked above, skip redundant I/O
			nowMs: opts.nowMs,
			leaseDurationMs: opts.leaseDurationMs,
		});
		if (claimed && claimed.owner === agentName && claimed.status === "in_progress") return claimed;
	}
	return null;
}

export type TaskDependencyOpResult =
	| { ok: true; task: TeamTask; dependency: TeamTask }
	| { ok: false; error: string };

function uniqStrings(xs: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const x of xs) {
		if (seen.has(x)) continue;
		seen.add(x);
		out.push(x);
	}
	return out;
}

function findDependencyPath(
	taskById: ReadonlyMap<string, TeamTask>,
	startId: string,
	targetId: string,
	visiting = new Set<string>(),
): string[] | null {
	if (startId === targetId) return [startId];
	if (visiting.has(startId)) return null;
	visiting.add(startId);

	const start = taskById.get(startId);
	for (const nextId of start?.blockedBy ?? []) {
		const subPath = findDependencyPath(taskById, nextId, targetId, visiting);
		if (subPath) return [startId, ...subPath];
	}

	visiting.delete(startId);
	return null;
}

/**
 * Add a dependency edge: taskId is blockedBy depId (and depId blocks taskId).
 */
export async function addTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	if (!taskId || !depId) return { ok: false, error: "Missing task id or dependency id" };
	if (taskId === depId) return { ok: false, error: "Task cannot depend on itself" };

	const task = await getTask(teamDir, taskListId, taskId);
	if (!task) return { ok: false, error: `Task not found: ${taskId}` };
	const dep = await getTask(teamDir, taskListId, depId);
	if (!dep) return { ok: false, error: `Dependency task not found: ${depId}` };

	const allTasks = await listTasks(teamDir, taskListId);
	const taskById = new Map(allTasks.map((t) => [t.id, t]));
	const cyclePath = findDependencyPath(taskById, depId, taskId);
	if (cyclePath) {
		const cycleText = [taskId, ...cyclePath].join(" -> ");
		return {
			ok: false,
			error: `Dependency cycle detected: ${cycleText}`,
		};
	}

	const updatedTask = await updateTask(teamDir, taskListId, taskId, (cur) => ({
		...cur,
		blockedBy: uniqStrings([...(cur.blockedBy ?? []), depId]),
	}));
	if (!updatedTask) return { ok: false, error: `Task not found: ${taskId}` };

	const updatedDep = await updateTask(teamDir, taskListId, depId, (cur) => ({
		...cur,
		blocks: uniqStrings([...(cur.blocks ?? []), taskId]),
	}));
	if (!updatedDep) return { ok: false, error: `Dependency task not found: ${depId}` };

	return { ok: true, task: updatedTask, dependency: updatedDep };
}

/**
 * Remove dependency edge: taskId no longer blockedBy depId (and depId no longer blocks taskId).
 */
export async function removeTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	if (!taskId || !depId) return { ok: false, error: "Missing task id or dependency id" };
	if (taskId === depId) return { ok: false, error: "Task cannot remove itself as a dependency" };

	const task = await getTask(teamDir, taskListId, taskId);
	if (!task) return { ok: false, error: `Task not found: ${taskId}` };
	const dep = await getTask(teamDir, taskListId, depId);
	if (!dep) return { ok: false, error: `Dependency task not found: ${depId}` };

	const updatedTask = await updateTask(teamDir, taskListId, taskId, (cur) => ({
		...cur,
		blockedBy: (cur.blockedBy ?? []).filter((x) => x !== depId),
	}));
	if (!updatedTask) return { ok: false, error: `Task not found: ${taskId}` };

	const updatedDep = await updateTask(teamDir, taskListId, depId, (cur) => ({
		...cur,
		blocks: (cur.blocks ?? []).filter((x) => x !== taskId),
	}));
	if (!updatedDep) return { ok: false, error: `Dependency task not found: ${depId}` };

	return { ok: true, task: updatedTask, dependency: updatedDep };
}

export type TaskClearMode = "completed" | "all";

export interface ClearTasksResult {
	mode: TaskClearMode;
	taskListId: string;
	taskListDir: string;
	deletedTaskIds: string[];
	skippedTaskIds: string[];
	errors: Array<{ file: string; error: string }>;
}

/**
 * Delete task JSON files from the task list directory.
 *
 * Safety properties:
 * - Only deletes `*.json` files inside `<teamDir>/tasks/<taskListId>/`.
 * - Refuses to operate if the resolved task list directory is not within `teamDir`.
 */
export async function clearTasks(
	teamDir: string,
	taskListId: string,
	mode: TaskClearMode = "completed",
): Promise<ClearTasksResult> {
	const taskListDir = getTaskListDir(teamDir, taskListId);

	// Path safety: ensure the taskListDir is inside teamDir (prevents path traversal accidents).
	const teamAbs = path.resolve(teamDir);
	const listAbs = path.resolve(taskListDir);
	if (!(listAbs === teamAbs || listAbs.startsWith(teamAbs + path.sep))) {
		throw new Error(`Refusing to clear tasks outside teamDir. teamDir=${teamAbs} taskListDir=${listAbs}`);
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(taskListDir, { withFileTypes: true });
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { mode, taskListId, taskListDir, deletedTaskIds: [], skippedTaskIds: [], errors: [] };
		}
		throw err;
	}

	const deletedTaskIds: string[] = [];
	const skippedTaskIds: string[] = [];
	const errors: Array<{ file: string; error: string }> = [];

	for (const e of entries) {
		if (!e.isFile()) continue;
		if (!e.name.endsWith(".json")) continue;

		const file = path.join(taskListDir, e.name);
		const fileAbs = path.resolve(file);
		if (!fileAbs.startsWith(listAbs + path.sep)) {
			errors.push({ file, error: "Refusing to delete file outside taskListDir" });
			continue;
		}

		let shouldDelete = false;
		let taskIdFromName = e.name.slice(0, -".json".length);

		if (mode === "all") {
			shouldDelete = true;
		} else {
			const obj = await readJson(file);
			const task = coerceTask(obj);
			if (task && task.status === "completed") {
				shouldDelete = true;
				taskIdFromName = task.id;
			}
		}

		if (!shouldDelete) {
			skippedTaskIds.push(taskIdFromName);
			continue;
		}

		try {
			await fs.promises.unlink(file);
			invalidateTaskFileCache(file);
			deletedTaskIds.push(taskIdFromName);
		} catch (err: unknown) {
			if (isErrnoException(err) && err.code === "ENOENT") continue;
			errors.push({ file, error: err instanceof Error ? err.message : String(err) });
		}
	}

	return { mode, taskListId, taskListDir, deletedTaskIds, skippedTaskIds, errors };
}
