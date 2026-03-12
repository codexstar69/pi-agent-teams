import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	compactMailboxMessages,
	getInboxPath,
	getMailboxPruningConfig,
	popUnreadMessages,
	writeToMailbox,
	type MailboxMessage,
} from "../extensions/teams/mailbox.js";

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
	assert(actual === expected, `${label}${actual === expected ? "" : ` (actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)})`}`);
}

const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-teams-mailbox-prune-"));
const teamDir = path.join(tmpRoot, "team");
const namespace = "team";
const recipient = "agent-prune";

const helperInput: MailboxMessage[] = Array.from({ length: 80 }, (_, i) => ({
	from: "tester",
	text: `msg-${i}`,
	timestamp: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
	read: true,
}));
const helperCompacted = compactMailboxMessages(helperInput, {
	enabled: true,
	maxReadMessages: 5,
	maxTotalMessages: 20,
});
assertEq(helperCompacted.length, 5, "compactMailboxMessages keeps only configured read history");
assertEq(helperCompacted[0]?.text, "msg-75", "compactMailboxMessages keeps newest read tail");
assertEq(getMailboxPruningConfig({ PI_TEAMS_MAILBOX_MAX_READ_MESSAGES: "7" }).maxReadMessages, 7, "config reads env override");
assertEq(getMailboxPruningConfig({ PI_TEAMS_MAILBOX_MAX_READ_MESSAGES: "bad" }).maxReadMessages, 50, "config falls back on invalid env");

for (let i = 0; i < 80; i++) {
	await writeToMailbox(teamDir, namespace, recipient, {
		from: i % 2 === 0 ? "team-lead" : "peer",
		text: `bulk-${i}`,
		timestamp: `2025-01-01T01:${String(i).padStart(2, "0")}:00Z`,
	});
}

const popped = await popUnreadMessages(teamDir, namespace, recipient);
assertEq(popped.length, 80, "popUnreadMessages returns all unread messages before pruning");

const inboxPath = getInboxPath(teamDir, namespace, recipient);
const compactedRaw: unknown = JSON.parse(await fs.promises.readFile(inboxPath, "utf8"));
assert(Array.isArray(compactedRaw), "mailbox file remains an array after pruning");
const compacted = Array.isArray(compactedRaw) ? compactedRaw : [];
assert(compacted.length <= 50, "mailbox pruning bounds stored read history");
assertEq((compacted.at(-1) as { text?: string } | undefined)?.text ?? null, "bulk-79", "mailbox pruning keeps newest message");
assert(compacted.every((msg) => (msg as { read?: unknown }).read === true), "mailbox pruning only persists read messages after pop");

if (failed > 0) {
	console.error(`FAILED: ${failed} assertion(s)`);
	process.exit(1);
}

console.log(`PASSED: ${passed}`);
