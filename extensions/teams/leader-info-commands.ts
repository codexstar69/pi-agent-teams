import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { sanitizeName } from "./names.js";
import { getTeamDir, getTeamsRootDir } from "./paths.js";
import type { TeammateRpc } from "./teammate-rpc.js";
import type { TeamConfig, TeamMember } from "./team-config.js";
import type { TeamsStyle } from "./teams-style.js";
import { formatMemberDisplayName, getTeamsStrings } from "./teams-style.js";

function powerShellQuote(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function buildPiCommandParts(teamsEntry: string | null): string[] {
	const parts = ["pi"];
	if (teamsEntry) parts.push("--no-extensions", "-e", teamsEntry);
	return parts;
}

export function buildTeamEnvOutput(opts: {
	teamId: string;
	taskListId: string;
	leadName: string;
	style: TeamsStyle;
	teamsRoot: string;
	teamDir: string;
	agentName: string;
	autoClaim: string;
	teamsEntry: string | null;
	shellQuote: (value: string) => string;
}): string {
	const env: Record<string, string> = {
		PI_TEAMS_ROOT_DIR: opts.teamsRoot,
		PI_TEAMS_WORKER: "1",
		PI_TEAMS_TEAM_ID: opts.teamId,
		PI_TEAMS_TASK_LIST_ID: opts.taskListId,
		PI_TEAMS_AGENT_NAME: opts.agentName,
		PI_TEAMS_LEAD_NAME: opts.leadName,
		PI_TEAMS_STYLE: opts.style,
		PI_TEAMS_AUTO_CLAIM: opts.autoClaim,
	};
	const piCommandParts = buildPiCommandParts(opts.teamsEntry);

	const posixExports = Object.entries(env)
		.map(([key, value]) => `export ${key}=${opts.shellQuote(value)}`)
		.join("\n");
	const posixRun = Object.entries(env)
		.map(([key, value]) => `${key}=${opts.shellQuote(value)}`)
		.concat(piCommandParts.map((part) => opts.shellQuote(part)))
		.join(" ");

	const powerShellExports = Object.entries(env)
		.map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
		.join("\n");
	const powerShellRun = Object.entries(env)
		.map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`)
		.concat(`& ${piCommandParts.map((part) => powerShellQuote(part)).join(" ")}`)
		.join("; ");

	return [
		`teamId: ${opts.teamId}`,
		`taskListId: ${opts.taskListId}`,
		`leadName: ${opts.leadName}`,
		`teamsRoot: ${opts.teamsRoot}`,
		`teamDir: ${opts.teamDir}`,
		"",
		"POSIX shell (macOS/Linux):",
		posixExports,
		"",
		"Run:",
		posixRun,
		"",
		"PowerShell (Windows):",
		powerShellExports,
		"",
		"Run:",
		powerShellRun,
	].join("\n");
}

export async function handleTeamListCommand(opts: {
	ctx: ExtensionCommandContext;
	teammates: Map<string, TeammateRpc>;
	getTeamConfig: () => TeamConfig | null;
	style: TeamsStyle;
	refreshTasks: () => Promise<void>;
	renderWidget: () => void;
}): Promise<void> {
	const { ctx, teammates, getTeamConfig, style, refreshTasks, renderWidget } = opts;
	const strings = getTeamsStrings(style);

	await refreshTasks();

	const teamConfig = getTeamConfig();
	const cfgWorkers = (teamConfig?.members ?? []).filter((m) => m.role === "worker");
	const cfgByName = new Map<string, TeamMember>();
	for (const m of cfgWorkers) cfgByName.set(m.name, m);

	const names = new Set<string>();
	for (const name of teammates.keys()) names.add(name);
	for (const name of cfgByName.keys()) names.add(name);

	if (names.size === 0) {
		ctx.ui.notify(`No ${strings.memberTitle.toLowerCase()}s`, "info");
		renderWidget();
		return;
	}

	const lines: string[] = [];
	for (const name of Array.from(names).sort()) {
		const rpc = teammates.get(name);
		const cfg = cfgByName.get(name);
		const status = rpc ? rpc.status : cfg?.status ?? "offline";
		const kind = rpc ? "rpc" : cfg ? "manual" : "unknown";
		lines.push(`${formatMemberDisplayName(style, name)}: ${status} (${kind})`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
	renderWidget();
}

export async function handleTeamIdCommand(opts: {
	ctx: ExtensionCommandContext;
	teamId: string;
	taskListId: string | null;
	leadName: string;
	style: TeamsStyle;
}): Promise<void> {
	const { ctx, teamId, taskListId, leadName, style } = opts;
	const sessionTeamId = ctx.sessionManager.getSessionId();
	const effectiveTlId = taskListId ?? teamId;
	const teamsRoot = getTeamsRootDir();
	const teamDir = getTeamDir(teamId);

	ctx.ui.notify(
		[
			`teamId: ${teamId}`,
			...(teamId !== sessionTeamId ? [`sessionTeamId: ${sessionTeamId}`] : []),
			`taskListId: ${effectiveTlId}`,
			`leadName: ${leadName}`,
			`style: ${style}`,
			`teamsRoot: ${teamsRoot}`,
			`teamDir: ${teamDir}`,
		].join("\n"),
		"info",
	);
}

export async function handleTeamEnvCommand(opts: {
	ctx: ExtensionCommandContext;
	rest: string[];
	teamId: string;
	taskListId: string | null;
	leadName: string;
	style: TeamsStyle;
	getTeamsExtensionEntryPath: () => string | null;
	shellQuote: (v: string) => string;
}): Promise<void> {
	const { ctx, rest, teamId, taskListId, leadName, style, getTeamsExtensionEntryPath, shellQuote } = opts;

	const nameRaw = rest[0];
	if (!nameRaw) {
		ctx.ui.notify("Usage: /team env <name>", "error");
		return;
	}

	const name = sanitizeName(nameRaw);
	const effectiveTlId = taskListId ?? teamId;
	const teamsRoot = getTeamsRootDir();
	const teamDir = getTeamDir(teamId);
	const autoClaim = (process.env.PI_TEAMS_DEFAULT_AUTO_CLAIM ?? "1") === "1" ? "1" : "0";

	const teamsEntry = getTeamsExtensionEntryPath();
	ctx.ui.notify(
		buildTeamEnvOutput({
			teamId,
			taskListId: effectiveTlId,
			leadName,
			style,
			teamsRoot,
			teamDir,
			agentName: name,
			autoClaim,
			teamsEntry,
			shellQuote,
		}),
		"info",
	);
}
