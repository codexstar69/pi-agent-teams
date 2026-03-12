import * as fs from "node:fs";
import * as os from "node:os";

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface LockMetadata {
	pid?: number;
	hostname?: string;
	createdAt?: string;
	label?: string;
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

function formatLockDiagnostics(lockFilePath: string, metadata: LockMetadata | null, ageMs: number | null): string {
	const parts = [`Timeout acquiring lock: ${lockFilePath}`];
	if (metadata?.label) parts.push(`label=${metadata.label}`);
	if (typeof metadata?.pid === "number") parts.push(`pid=${metadata.pid}`);
	if (metadata?.hostname) parts.push(`hostname=${metadata.hostname}`);
	if (metadata?.createdAt) parts.push(`createdAt=${metadata.createdAt}`);
	if (typeof ageMs === "number" && Number.isFinite(ageMs)) parts.push(`ageMs=${Math.max(0, Math.round(ageMs))}`);
	return parts.join(" ");
}

export interface LockOptions {
	/** How long to wait to acquire the lock before failing. */
	timeoutMs?: number;
	/** If lock file is older than this, consider it stale and remove it. */
	staleMs?: number;
	/** Poll interval while waiting for lock. */
	pollMs?: number;
	/** Optional label to help debugging (written into lock file). */
	label?: string;
}

export async function withLock<T>(lockFilePath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const staleMs = opts.staleMs ?? 60_000;
	const basePollMs = opts.pollMs ?? 50;
	const maxPollMs = Math.max(basePollMs, 1_000);
	const start = Date.now();
	const currentHostname = os.hostname();

	let fd: number | null = null;
	let attempt = 0;

	while (fd === null) {
		try {
			fd = fs.openSync(lockFilePath, "wx");
			const payload = {
				pid: process.pid,
				hostname: currentHostname,
				createdAt: new Date().toISOString(),
				label: opts.label,
			};
			try {
				fs.writeFileSync(fd, JSON.stringify(payload));
			} catch (writeErr) {
				// BUG-5 fix: if metadata write fails, close and remove the empty lock file
				// so dead-owner detection still works for other processes.
				try { fs.closeSync(fd); } catch { /* ignore */ }
				fd = null;
				try { fs.unlinkSync(lockFilePath); } catch { /* ignore */ }
				throw writeErr;
			}
		} catch (err: unknown) {
			if (!isErrnoException(err) || err.code !== "EEXIST") throw err;

			let lockAgeMs: number | null = null;
			let metadata: LockMetadata | null = null;

			try {
				metadata = readLockMetadata(lockFilePath);
				const st = fs.statSync(lockFilePath);
				lockAgeMs = Date.now() - st.mtimeMs;
				const sameHost = metadata?.hostname ? metadata.hostname === currentHostname : true;
				const ownerAlive = sameHost && typeof metadata?.pid === "number" ? isPidAlive(metadata.pid) : null;
				const reclaimDeadOwner = ownerAlive === false;
				const reclaimStaleLock = lockAgeMs > staleMs && ownerAlive !== true;
				if (reclaimDeadOwner || reclaimStaleLock) {
					fs.unlinkSync(lockFilePath);
					attempt = 0;
					continue;
				}
			} catch {
				// ignore: stat/unlink failures fall through to wait
			}

			const elapsedMs = Date.now() - start;
			if (elapsedMs > timeoutMs) {
				throw new Error(formatLockDiagnostics(lockFilePath, metadata, lockAgeMs));
			}

			attempt += 1;
			const expBackoff = Math.min(maxPollMs, basePollMs * 2 ** Math.min(attempt, 6));
			const jitterFactor = 0.5 + Math.random();
			const jitteredBackoff = Math.min(maxPollMs, Math.round(expBackoff * jitterFactor));

			const remainingMs = timeoutMs - elapsedMs;
			const sleepMs = Math.max(1, Math.min(remainingMs, jitteredBackoff));
			await sleep(sleepMs);
		}
	}

	try {
		return await fn();
	} finally {
		try {
			if (fd !== null) fs.closeSync(fd);
		} catch {
			// ignore
		}
		try {
			fs.unlinkSync(lockFilePath);
		} catch {
			// ignore
		}
	}
}
