import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";

export interface TeamEvent {
	ts: string;
	kind: string;
	teamId?: string;
	taskListId?: string;
	member?: string;
	taskId?: string;
	data?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function coerceTeamEvent(value: unknown): TeamEvent | null {
	if (!isRecord(value)) return null;
	if (typeof value.ts !== "string") return null;
	if (typeof value.kind !== "string") return null;
	const data = isRecord(value.data) ? value.data : undefined;
	return {
		ts: value.ts,
		kind: value.kind,
		teamId: typeof value.teamId === "string" ? value.teamId : undefined,
		taskListId: typeof value.taskListId === "string" ? value.taskListId : undefined,
		member: typeof value.member === "string" ? value.member : undefined,
		taskId: typeof value.taskId === "string" ? value.taskId : undefined,
		data,
	};
}

async function ensureDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
}

export function getTeamLogsDir(teamDir: string): string {
	return path.join(teamDir, "logs");
}

export function getTeamEventsLogPath(teamDir: string): string {
	return path.join(getTeamLogsDir(teamDir), "events.jsonl");
}

export async function appendTeamEvent(teamDir: string, event: TeamEvent): Promise<void> {
	const file = getTeamEventsLogPath(teamDir);
	const lockPath = `${file}.lock`;
	await ensureDir(path.dirname(file));
	await withLock(
		lockPath,
		async () => {
			await fs.promises.appendFile(file, JSON.stringify(event) + "\n", "utf8");
		},
		{ label: "event-log:append" },
	);
}

export async function readRecentTeamEvents(teamDir: string, opts: { limit?: number } = {}): Promise<TeamEvent[]> {
	const file = getTeamEventsLogPath(teamDir);
	let raw: string;
	try {
		raw = await fs.promises.readFile(file, "utf8");
	} catch {
		return [];
	}

	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const events: TeamEvent[] = [];
	for (const line of lines) {
		try {
			const parsed: unknown = JSON.parse(line);
			const event = coerceTeamEvent(parsed);
			if (event) events.push(event);
		} catch {
			// ignore malformed jsonl lines
		}
	}

	const limit = opts.limit;
	if (typeof limit === "number" && Number.isFinite(limit) && limit >= 0) {
		if (limit === 0) return [];
		return events.slice(-Math.floor(limit));
	}
	return events;
}
