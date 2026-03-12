import type { AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { popUnreadMessages, writeToMailbox } from "./mailbox.js";
import { sanitizeName } from "./names.js";
import { getTeamsStyleFromEnv, type TeamsStyle, getTeamsStrings } from "./teams-style.js";
import {
	TEAM_MAILBOX_NS,
	isAbortRequestMessage,
	isPlanApprovedMessage,
	isPlanRejectedMessage,
	isSetSessionNameMessage,
	isShutdownRequestMessage,
	isTaskAssignmentMessage,
} from "./protocol.js";
import { getWorkerPollDelayMs } from "./adaptive-polling.js";
import { buildWorkerHeartbeatMeta, getWorkerHeartbeatConfig, readTaskLeaseMetadata, type WorkerHeartbeatPhase } from "./heartbeat-lease.js";
import { getTeamDir } from "./paths.js";
import { ensureTeamConfig, setMemberStatus, upsertMember } from "./team-config.js";
import {
	claimNextAvailableTask,
	completeTask,
	getTask,
	isTaskBlocked,
	markTaskRetryableFailure,
	refreshTaskLeaseHeartbeat,
	startAssignedTask,
	unassignTasksForAgent,
	type TeamTask,
} from "./task-store.js";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function teamDirFromEnv(): {
	teamId: string;
	teamDir: string;
	taskListId: string;
	agentName: string;
	leadName: string;
	styleId: TeamsStyle;
	autoClaim: boolean;
} | null {
	const teamId = process.env.PI_TEAMS_TEAM_ID;
	const agentNameRaw = process.env.PI_TEAMS_AGENT_NAME;
	if (!teamId || !agentNameRaw) return null;

	const agentName = sanitizeName(agentNameRaw);
	const taskListId = process.env.PI_TEAMS_TASK_LIST_ID ?? teamId;
	const styleId = getTeamsStyleFromEnv(process.env);
	const leadName = sanitizeName(process.env.PI_TEAMS_LEAD_NAME ?? "team-lead");
	const autoClaim = (process.env.PI_TEAMS_AUTO_CLAIM ?? "1") === "1";

	return {
		teamId,
		teamDir: getTeamDir(teamId),
		taskListId,
		agentName,
		leadName,
		styleId,
		autoClaim,
	};
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasProperty<K extends string>(value: unknown, key: K): value is Record<K, unknown> & Record<string, unknown> {
	return isObjectRecord(value) && key in value;
}

function hasStringProperty<K extends string>(value: unknown, key: K): value is Record<K, string> & Record<string, unknown> {
	return isObjectRecord(value) && typeof value[key] === "string";
}

type AssistantMessageWithContent = Record<"role", "assistant"> & Record<"content", unknown> & Record<string, unknown>;

function isAssistantMessageWithContent(message: unknown): message is AssistantMessageWithContent {
	return hasStringProperty(message, "role") && message.role === "assistant" && hasProperty(message, "content");
}

type TextBlock = { type: "text"; text: string };

function isTextBlock(block: unknown): block is TextBlock {
	return hasStringProperty(block, "type") && block.type === "text" && hasStringProperty(block, "text");
}

function extractLastAssistantText(messages: AgentMessage[]): string {
	const assistant = messages.filter((m) => isAssistantMessageWithContent(m));
	const last = assistant.at(-1);
	if (!last) return "";

	const content = last.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.filter((c) => isTextBlock(c)).map((c) => c.text).join("");
	}
	return "";
}

function buildTaskPrompt(style: TeamsStyle, agentName: string, task: TeamTask, planOnly = false): string {
	const strings = getTeamsStrings(style);
	const footer = planOnly
		? "Produce a detailed implementation plan only. Do NOT make any changes or implement anything yet. Your plan will be reviewed before you can proceed."
		: "Do the work now. When finished, reply with a concise summary and any key outputs.";

	const actor = strings.memberTitle.toLowerCase();
	return [
		`You are ${actor} '${agentName}'.`,
		`You have been assigned task #${task.id}.`,
		`Subject: ${task.subject}`,
		"",
		`Description:\n${task.description}`,
		"",
		footer,
	].join("\n");
}

// Message parsers are shared with the leader implementation.
export function runWorker(pi: ExtensionAPI): void {
	const env = teamDirFromEnv();
	if (!env) return;

	const { teamId, teamDir, taskListId, agentName, leadName, styleId, autoClaim } = env;
	const retryBaseDelayMs = parsePositiveInt(process.env.PI_TEAMS_RETRY_BASE_DELAY_MS, 5_000);
	const retryMaxAttempts = parsePositiveInt(process.env.PI_TEAMS_RETRY_MAX_ATTEMPTS, 3);
	const heartbeatConfig = getWorkerHeartbeatConfig(process.env);
	const heartbeatsEnabled = process.env.PI_TEAMS_HEARTBEATS === "1";
	const taskLeasesEnabled = process.env.PI_TEAMS_TASK_LEASES === "1";

	// Prefer persisted team config style (leader-controlled) over env default.
	// This keeps manual workers consistent with the current team terminology.
	let style: TeamsStyle = styleId;

	const TeamMessageToolParamsSchema = Type.Object({
		recipient: Type.String({ description: "Name of the comrade to message" }),
		message: Type.String({ description: "The message to send" }),
	});
	// Match the schema at compile-time.
	type TeamMessageToolParams = Static<typeof TeamMessageToolParamsSchema>;
	// Tool result details to match AgentToolResult<TDetails> contract.
	type TeamMessageToolDetails = { recipient: string; timestamp: string };

	pi.registerTool({
		name: "team_message",
		label: "Team Message",
		description: "Send a message to a comrade. Use this to coordinate with peers on related tasks.",
		parameters: TeamMessageToolParamsSchema,
		async execute(
			_toolCallId,
			params: TeamMessageToolParams,
			_signal,
			_onUpdate,
			_ctx,
		): Promise<AgentToolResult<TeamMessageToolDetails>> {
			const recipient = sanitizeName(params.recipient);
			const message = params.message;
			const ts = new Date().toISOString();
			// Write to recipient's mailbox in team namespace
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, recipient, {
				from: agentName,
				text: message,
				timestamp: ts,
			});
			// CC leader with peer_dm_sent notification
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
				from: agentName,
				text: JSON.stringify({
					type: "peer_dm_sent",
					from: agentName,
					to: recipient,
					summary: message.slice(0, 100),
					timestamp: ts,
				}),
				timestamp: ts,
			});
			return {
				content: [{ type: "text", text: `Message sent to ${recipient}` }],
				details: { recipient, timestamp: ts },
			};
		},
	});

	let ctxRef: ExtensionContext | null = null;
	let isStreaming = false;
	let isDeciding = false;
	let currentTaskId: string | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let heartbeatInFlight = false;
	let pollIdleStreak = 0;
	let pollErrorStreak = 0;
	const MAX_POLL_ERROR_STREAK = 5;
	let pendingTaskAssignments: string[] = [];
	let pendingDmTexts: string[] = [];
	let pollAbort = false;
	let shutdownInProgress = false;
	const seenShutdownRequestIds = new Set<string>();

	let abortTaskId: string | null = null;
	let abortReason: string | undefined;
	let abortRequestId: string | null = null;
	const seenAbortRequestIds = new Set<string>();

	// Plan-required mode
	let planMode = process.env.PI_TEAMS_PLAN_REQUIRED === "1";
	let planApproved = false;
	let planRequestId: string | null = null;
	/** Tools that were active before plan-mode restriction, so we can restore them on approval. */
	let prePlanTools: string[] | null = null;

	const currentHeartbeatPhase = (): WorkerHeartbeatPhase => {
		if (shutdownInProgress || pollAbort) return "shutdown";
		if (planMode && currentTaskId && !planApproved) return "planning";
		if (isStreaming || currentTaskId) return "streaming";
		return "idle";
	};

	const publishHeartbeat = async (status: "online" | "offline" = "online", extraMeta?: Record<string, unknown>) => {
		if (!heartbeatsEnabled) return;
		if (heartbeatInFlight) return;
		heartbeatInFlight = true;
		try {
			let leaseToken: string | undefined;
			let leaseExpiresAt: string | undefined;
			if (taskLeasesEnabled && currentTaskId && status === "online") {
				const refreshedTask = await refreshTaskLeaseHeartbeat(teamDir, taskListId, currentTaskId, agentName, {
					leaseDurationMs: heartbeatConfig.leaseDurationMs,
				});
				const lease = readTaskLeaseMetadata(refreshedTask?.metadata);
				leaseToken = lease?.token;
				leaseExpiresAt = lease?.expiresAt;
			}
			const meta = buildWorkerHeartbeatMeta({
				phase: currentHeartbeatPhase(),
				currentTaskId: currentTaskId ?? undefined,
				leaseToken,
				leaseExpiresAt,
			});
			await setMemberStatus(teamDir, agentName, status, {
				lastSeenAt: meta.heartbeatAt,
				meta: extraMeta ? { ...meta, ...extraMeta } : { ...meta },
			});
		} catch {
			// ignore heartbeat failures
		} finally {
			heartbeatInFlight = false;
		}
	};

	const stopHeartbeatLoop = () => {
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	};

	const startHeartbeatLoop = () => {
		if (!heartbeatsEnabled) return;
		stopHeartbeatLoop();
		heartbeatTimer = setInterval(() => {
			void publishHeartbeat();
		}, heartbeatConfig.intervalMs);
	};

	const poll = async () => {
		while (!pollAbort) {
			let hasInboxActivity = false;
			let hasPendingWork = false;
			let hasRunningWork = false;
			try {
				// Two namespaces (Claude-style):
				// - team namespace for DM/idle notifications
				// - taskListId namespace for task_assignment pings
				const [teamMsgs, taskMsgs] = await Promise.all([
					popUnreadMessages(teamDir, TEAM_MAILBOX_NS, agentName),
					popUnreadMessages(teamDir, taskListId, agentName),
				]);
				hasInboxActivity = teamMsgs.length > 0 || taskMsgs.length > 0;
				pollErrorStreak = 0; // reset on successful read

				for (const m of [...taskMsgs, ...teamMsgs]) {
					const shutdown = isShutdownRequestMessage(m.text);
					if (shutdown && !seenShutdownRequestIds.has(shutdown.requestId)) {
						seenShutdownRequestIds.add(shutdown.requestId);

						const ts = new Date().toISOString();

						// Reject shutdown if currently busy (including plan-mode waiting for approval)
						if (currentTaskId) {
							await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
								from: agentName,
								text: JSON.stringify({
									type: "shutdown_rejected",
									requestId: shutdown.requestId,
									from: agentName,
									reason: `Currently working on task #${currentTaskId}`,
									timestamp: ts,
								}),
								timestamp: ts,
							});
							continue;
						}

						// Idle — approve shutdown
						shutdownInProgress = true;
						pollAbort = true;
						stopHeartbeatLoop();

						await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
							from: agentName,
							text: JSON.stringify({
								type: "shutdown_approved",
								requestId: shutdown.requestId,
								from: agentName,
								timestamp: ts,
							}),
							timestamp: ts,
						});

						try {
							await cleanup("shutdown requested");
						} catch {
							// ignore
						}
						await publishHeartbeat("offline", { offlineReason: "shutdown requested" });

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						try {
							ctxRef?.shutdown();
						} catch {
							// ignore
						}
						return;
					}

					const setName = isSetSessionNameMessage(m.text);
					if (setName) {
						const desired = setName.name.trim();
						if (desired) {
							try {
								const existing = pi.getSessionName?.();
								// Only overwrite sessions that are unnamed or already managed by us.
								if (!existing || existing.startsWith("pi agent teams -")) {
									if (existing !== desired) pi.setSessionName(desired);
								}
							} catch {
								// ignore
							}
						}
						continue;
					}

					const abortReq = isAbortRequestMessage(m.text);
					if (abortReq && !seenAbortRequestIds.has(abortReq.requestId)) {
						seenAbortRequestIds.add(abortReq.requestId);

						// If the request targets a specific task and we're busy on a different one, ignore.
						if (abortReq.taskId && currentTaskId && abortReq.taskId !== currentTaskId) continue;

						if (currentTaskId) {
							abortTaskId = currentTaskId;
							abortReason = abortReq.reason;
							abortRequestId = abortReq.requestId;
						}

						try {
							ctxRef?.abort();
						} catch {
							// ignore
						}
						continue;
					}

					// Plan approval/rejection handling
					const planApproval = isPlanApprovedMessage(m.text);
					if (planApproval && planRequestId && planApproval.requestId === planRequestId) {
						pi.setActiveTools(prePlanTools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"]);
						prePlanTools = null;
						planApproved = true;
						planMode = false;
						planRequestId = null;
						pi.sendUserMessage("Your plan has been approved. Proceed with implementation.");
						continue;
					}

					const planRejection = isPlanRejectedMessage(m.text);
					if (planRejection && planRequestId && planRejection.requestId === planRequestId) {
						planRequestId = null;
						pi.sendUserMessage(
							`Your plan was rejected. Feedback: ${planRejection.feedback}\nPlease revise your plan.`,
						);
						continue;
					}

					const assign = isTaskAssignmentMessage(m.text);
					if (assign) {
						pendingTaskAssignments.push(assign.taskId);
						continue;
					}
					// Plain DM (or unknown structured message)
					pendingDmTexts.push(m.text);
				}

				if (!shutdownInProgress) await maybeStartNextWork();
				hasPendingWork = pendingTaskAssignments.length > 0 || pendingDmTexts.length > 0;
				hasRunningWork = currentTaskId !== null || isStreaming;
			} catch {
				// BUG-4 fix: track consecutive poll errors and back off.
				pollErrorStreak += 1;
				if (pollErrorStreak >= MAX_POLL_ERROR_STREAK) {
					void publishHeartbeat("online", { pollErrorStreak, pollErrorState: "degraded" });
				}
			}

			const errorBackoffMs = pollErrorStreak >= MAX_POLL_ERROR_STREAK
				? Math.min(10_000, 1_000 * Math.pow(2, Math.min(pollErrorStreak - MAX_POLL_ERROR_STREAK, 4)))
				: 0;
			const delayMs = Math.max(errorBackoffMs, getWorkerPollDelayMs({
				env: process.env,
				idleStreak: pollIdleStreak,
				hasInboxActivity,
				hasPendingWork,
				hasRunningWork,
			}));
			pollIdleStreak = hasInboxActivity || hasPendingWork || hasRunningWork ? 0 : pollIdleStreak + 1;
			await sleep(delayMs);
		}
	};

	const maybeStartNextWork = async () => {
		if (!ctxRef) return;
		if (shutdownInProgress) return;
		if (isStreaming) return;
		if (currentTaskId) return;
		if (isDeciding) return;

		isDeciding = true;
		try {
			// 1) Assigned tasks
			const requeue: string[] = [];
			while (pendingTaskAssignments.length) {
				const taskId = pendingTaskAssignments.shift();
				if (!taskId) break;
				const task = await getTask(teamDir, taskListId, taskId);
				if (!task) continue;
				if (task.owner !== agentName) continue;
				if (task.status === "completed") continue;

				// Respect deps: don't start assigned tasks until unblocked.
				if (await isTaskBlocked(teamDir, taskListId, task)) {
					requeue.push(taskId);
					continue;
				}

				// Mark in_progress if needed
				if (task.status === "pending") {
					await startAssignedTask(teamDir, taskListId, taskId, agentName, {
						leaseDurationMs: taskLeasesEnabled ? heartbeatConfig.leaseDurationMs : undefined,
					});
				}

				currentTaskId = taskId;
				isStreaming = true; // optimistic; agent_start will follow
				void publishHeartbeat();
				pi.sendUserMessage(buildTaskPrompt(style, agentName, task, planMode && !planApproved));
				pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];
				return;
			}
			pendingTaskAssignments = [...requeue, ...pendingTaskAssignments];

			// 2) DMs
			if (pendingDmTexts.length) {
				const text = pendingDmTexts.join("\n\n---\n\n");
				pendingDmTexts = [];
				isStreaming = true;
				void publishHeartbeat();
				pi.sendUserMessage([
					{ type: "text", text: "You have received comrade message(s):" },
					{ type: "text", text },
				]);
				return;
			}

			// 3) Auto-claim
			if (autoClaim) {
				// Small randomized delay improves fairness (reduces one fast worker hogging tasks)
				// and reduces lock contention when many workers become idle simultaneously.
				await sleep(Math.floor(Math.random() * 250));

				const claimed = await claimNextAvailableTask(teamDir, taskListId, agentName, {
					checkAgentBusy: true,
					leaseDurationMs: taskLeasesEnabled ? heartbeatConfig.leaseDurationMs : undefined,
				});
				if (claimed) {
					currentTaskId = claimed.id;
					isStreaming = true;
					void publishHeartbeat();
					pi.sendUserMessage(buildTaskPrompt(style, agentName, claimed, planMode && !planApproved));
					return;
				}
			}
		} finally {
			isDeciding = false;
		}
	};

	const sendIdleNotification = async (
		completedTaskId?: string,
		completedStatus?: "completed" | "failed",
		failureReason?: string,
	) => {
		type IdleNotificationPayload = {
			type: "idle_notification";
			from: string;
			timestamp: string;
			completedTaskId?: string;
			completedStatus?: "completed" | "failed";
			failureReason?: string;
		};

		const payload: IdleNotificationPayload = {
			type: "idle_notification",
			from: agentName,
			timestamp: new Date().toISOString(),
		};
		if (completedTaskId) payload.completedTaskId = completedTaskId;
		if (completedStatus) payload.completedStatus = completedStatus;
		if (failureReason) payload.failureReason = failureReason;

		await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
			from: agentName,
			text: JSON.stringify(payload),
			timestamp: new Date().toISOString(),
		});
	};

	const cleanup = async (reason: string) => {
		try {
			await unassignTasksForAgent(teamDir, taskListId, agentName, reason);
		} catch {
			// ignore
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;

		// Restrict tools in plan-required mode (read-only until plan is approved)
		if (planMode) {
			prePlanTools = pi.getActiveTools?.() ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
			pi.setActiveTools(["read", "grep", "find", "ls"]);
		}

		// Register ourselves in the shared team config so manual tmux workers are discoverable.
		try {
			const cfg = await ensureTeamConfig(teamDir, { teamId, taskListId, leadName, style: styleId });
			style = cfg.style ?? styleId;
			const now = new Date().toISOString();
			if (!cfg.members.some((m) => m.name === agentName)) {
				await upsertMember(teamDir, {
					name: agentName,
					role: "worker",
					status: "online",
					lastSeenAt: now,
					cwd: ctx.cwd,
					sessionFile: ctx.sessionManager.getSessionFile(),
				});
			} else {
				await setMemberStatus(teamDir, agentName, "online", { lastSeenAt: now });
			}
		} catch {
			// ignore config errors
		}

		if (heartbeatsEnabled) {
			await publishHeartbeat();
			startHeartbeatLoop();
		}
		void poll();
		await maybeStartNextWork();
		// Claude-style: let the leader know we're idle even if no task was completed yet.
		if (!isStreaming && !currentTaskId) {
			await sendIdleNotification();
		}
	});

	pi.on("session_shutdown", async () => {
		pollAbort = true;
		stopHeartbeatLoop();
		await cleanup("worker shutdown");
		if (heartbeatsEnabled) await publishHeartbeat("offline", { offlineReason: "worker shutdown" });
		await sendIdleNotification(undefined, undefined, "worker shutdown");
	});

	pi.on("agent_start", async () => {
		isStreaming = true;
		if (heartbeatsEnabled) await publishHeartbeat();
	});

	pi.on("agent_end", async (event) => {
		isStreaming = false;

		// Plan submission: if in plan mode and not yet approved, send plan to leader for review
		// Only do this when we're working on a task and haven't already requested approval.
		if (planMode && !planApproved && currentTaskId && !planRequestId) {
			const lastAssistantText = extractLastAssistantText(event.messages);
			const reqId = randomUUID();
			planRequestId = reqId;
			const timestamp = new Date().toISOString();
			await writeToMailbox(teamDir, TEAM_MAILBOX_NS, leadName, {
				from: agentName,
				text: JSON.stringify({
					type: "plan_approval_request",
					requestId: reqId,
					from: agentName,
					plan: lastAssistantText,
					taskId: currentTaskId ?? undefined,
					timestamp,
				}),
				timestamp,
			});
			// Do NOT clear currentTaskId, do NOT complete the task, do NOT send idle notification
			return;
		}

		const taskId = currentTaskId;
		currentTaskId = null;

		let completedTaskId: string | undefined;
		let completedStatus: "completed" | "failed" | undefined;
		let failureReason: string | undefined;

		try {
			if (taskId) {
				const rawResult = extractLastAssistantText(event.messages);
				const trimmed = rawResult.trim();
				const abortedByRequest = abortTaskId === taskId;
				const aborted = abortedByRequest || trimmed.length === 0;

				if (aborted) {
					const nowMs = Date.now();
					const extra: Record<string, unknown> = {
						abortedAt: new Date(nowMs).toISOString(),
						abortedBy: agentName,
					};

					if (abortedByRequest) {
						if (abortRequestId) extra.abortRequestId = abortRequestId;
						extra.abortReason = abortReason ?? "abort requested";
						if (trimmed.length > 0) extra.partialResult = rawResult;
					} else {
						extra.abortReason = "no assistant result";
					}

					await markTaskRetryableFailure(teamDir, taskListId, taskId, agentName, {
						reason: typeof extra.abortReason === "string" ? extra.abortReason : "task aborted",
						partialResult: typeof extra.partialResult === "string" ? extra.partialResult : undefined,
						failureKind: abortedByRequest ? "aborted" : "empty_result",
						nowMs,
						baseDelayMs: retryBaseDelayMs,
						maxAttempts: retryMaxAttempts,
						extraMetadata: extra,
					});
					completedTaskId = taskId;
					completedStatus = "failed";
					failureReason = typeof extra.abortReason === "string" ? extra.abortReason : undefined;
				} else {
					await completeTask(teamDir, taskListId, taskId, agentName, rawResult);
					completedTaskId = taskId;
					completedStatus = "completed";
				}
			}
		} finally {
			abortTaskId = null;
			abortReason = undefined;
			abortRequestId = null;
		}

		await maybeStartNextWork();
		await publishHeartbeat();

		// Only tell the leader we're idle if we truly didn't start more work.
		if (!isStreaming && !currentTaskId) {
			await sendIdleNotification(completedTaskId, completedStatus, failureReason);
		}
	});

	// Best-effort cleanup on SIGTERM (leader kill).
	process.on("SIGTERM", () => {
		pollAbort = true;
		stopHeartbeatLoop();
		void (async () => {
			await cleanup("SIGTERM");
			if (heartbeatsEnabled) await publishHeartbeat("offline", { offlineReason: "SIGTERM" });
			await sendIdleNotification(undefined, undefined, "SIGTERM");
		})().finally(() => process.exit(0));
	});
}
