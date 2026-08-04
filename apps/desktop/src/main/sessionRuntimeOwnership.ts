/**
 * Persisted single-owner guard for Maker runtimes in shared-userData setups.
 *
 * A lifecycle file lock serializes short mutations, but a vendor turn outlives
 * send acceptance. This owner claim makes permanent deletion fail closed when
 * another live Cindy process still owns the runtime, rather than committing a
 * tombstone that the other process can keep writing through.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getDbClient } from './localDb/client/current.js';
import { createLogger } from './logger.js';

const log = createLogger('session-runtime-ownership');
const processOwnerPrefix = `${process.pid}:${randomUUID()}`;
const locallyOwnedSessionTokens = new Map<string, string>();
const RUNTIME_OWNER_HEARTBEAT_MS = 5_000;
const RUNTIME_OWNER_STALE_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatInFlight = false;
const execFileAsync = promisify(execFile);
let ownProcessStartFingerprintPromise: Promise<string | null> | null = null;

export class SessionRuntimeOwnedElsewhereError extends Error {
  constructor(sessionId: string, ownerPid: number | null) {
    super(
      `Session ${sessionId} runtime is owned by another Cindy process` +
        (ownerPid ? ` (pid ${ownerPid})` : ''),
    );
    this.name = 'SessionRuntimeOwnedElsewhereError';
  }
}

export class SessionRuntimeInactiveError extends Error {
  constructor(sessionId: string, status: string | null) {
    super(`Session ${sessionId} is not active${status ? ` (${status})` : ''}`);
    this.name = 'SessionRuntimeInactiveError';
  }
}

interface RuntimeOwnerRow {
  status: string;
  runtime_owner_id: string | null;
  runtime_owner_pid: number | null;
  runtime_owner_process_start: string | null;
  runtime_owner_heartbeat_at: number | null;
}

function isOwnerFresh(row: RuntimeOwnerRow, now = Date.now()): boolean {
  return (
    row.runtime_owner_heartbeat_at !== null &&
    now - row.runtime_owner_heartbeat_at <= RUNTIME_OWNER_STALE_MS
  );
}

async function readProcessStartFingerprint(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result =
      process.platform === 'win32'
        ? await execFileAsync('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
          ])
        : await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='], {
            // `ps -o lstart=` is formatted text; pin the timezone so two Cindy
            // processes sharing one DB cannot disagree about the same PID.
            env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
          });
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

function isProcessAliveConservatively(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only reliable proof that the process no longer exists.
    // EPERM and unknown probe failures must fail closed: stealing a live
    // runtime lease is worse than temporarily refusing deletion/recovery.
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

function ownProcessStartFingerprint(): Promise<string | null> {
  ownProcessStartFingerprintPromise ??= readProcessStartFingerprint(process.pid);
  return ownProcessStartFingerprintPromise;
}

async function isSameOwnerProcessStillAlive(
  row: RuntimeOwnerRow,
  readFingerprint: (pid: number) => Promise<string | null> = readProcessStartFingerprint,
  isAlive: (pid: number) => boolean = isProcessAliveConservatively,
): Promise<boolean> {
  if (!row.runtime_owner_pid) return false;
  const currentFingerprint = await readFingerprint(row.runtime_owner_pid);
  if (!currentFingerprint) return isAlive(row.runtime_owner_pid);
  // Older/partially migrated rows fail closed while that PID is still alive.
  if (!row.runtime_owner_process_start) return true;
  return currentFingerprint === row.runtime_owner_process_start;
}

function ensureHeartbeatTimer(): void {
  if (heartbeatTimer || locallyOwnedSessionTokens.size === 0) return;
  heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight || locallyOwnedSessionTokens.size === 0) return;
    heartbeatInFlight = true;
    const heartbeatAt = Date.now();
    const owned = [...locallyOwnedSessionTokens.entries()];
    const predicates = owned.map(() => '(id = ? AND runtime_owner_id = ?)').join(' OR ');
    void getDbClient()
      .exec(
        `UPDATE sessions
            SET runtime_owner_heartbeat_at = ?
          WHERE ${predicates}`,
        [heartbeatAt, ...owned.flatMap(([sessionId, token]) => [sessionId, token])],
      )
      .catch((err) => {
        log.warn('session runtime ownership heartbeat failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        heartbeatInFlight = false;
        if (locallyOwnedSessionTokens.size === 0 && heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      });
  }, RUNTIME_OWNER_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

async function readOwner(sessionId: string): Promise<RuntimeOwnerRow | null> {
  return (
    (await getDbClient().queryOne<RuntimeOwnerRow>(
      `SELECT status, runtime_owner_id, runtime_owner_pid,
              runtime_owner_process_start, runtime_owner_heartbeat_at
         FROM sessions
        WHERE id = ?
        LIMIT 1`,
      [sessionId],
    )) ?? null
  );
}

export function getSessionRuntimeOwnerPrefix(): string {
  return processOwnerPrefix;
}

/** Claim an active physical session for this process before vendor startup. */
export async function acquireSessionRuntimeOwnership(
  sessionId: string,
): Promise<() => Promise<void>> {
  const processStartFingerprint = await ownProcessStartFingerprint();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await readOwner(sessionId);
    if (!row) throw new SessionRuntimeInactiveError(sessionId, null);
    if (row.status !== 'active') throw new SessionRuntimeInactiveError(sessionId, row.status);
    const localToken = locallyOwnedSessionTokens.get(sessionId);
    if (localToken && row.runtime_owner_id === localToken) {
      // A replacement runtime must receive a fresh lease token. Reusing the
      // closing runtime's token lets its delayed release clear the new owner.
      const replacementToken = `${processOwnerPrefix}:${randomUUID()}`;
      const replaced = await getDbClient().exec(
        `UPDATE sessions
            SET runtime_owner_id = ?,
                runtime_owner_pid = ?,
                runtime_owner_process_start = ?,
                runtime_owner_heartbeat_at = ?
          WHERE id = ? AND runtime_owner_id = ? AND status = 'active'`,
        [
          replacementToken,
          process.pid,
          processStartFingerprint,
          Date.now(),
          sessionId,
          localToken,
        ],
      );
      if (replaced.changes === 0) continue;
      locallyOwnedSessionTokens.set(sessionId, replacementToken);
      ensureHeartbeatTimer();
      let released = false;
      return async () => {
        if (released) return;
        released = await releaseSessionRuntimeOwnership(sessionId, replacementToken);
      };
    }

    if (
      row.runtime_owner_id &&
      (isOwnerFresh(row) || (await isSameOwnerProcessStillAlive(row)))
    ) {
      throw new SessionRuntimeOwnedElsewhereError(sessionId, row.runtime_owner_pid);
    }

    const heartbeatAt = Date.now();
    const leaseToken = `${processOwnerPrefix}:${randomUUID()}`;
    const result = row.runtime_owner_id
      ? await getDbClient().exec(
          `UPDATE sessions
              SET runtime_owner_id = ?, runtime_owner_pid = ?,
                  runtime_owner_process_start = ?, runtime_owner_heartbeat_at = ?
            WHERE id = ?
              AND status = 'active'
              AND runtime_owner_id = ?
              AND runtime_owner_heartbeat_at IS ?`,
          [
            leaseToken,
            process.pid,
            processStartFingerprint,
            heartbeatAt,
            sessionId,
            row.runtime_owner_id,
            row.runtime_owner_heartbeat_at,
          ],
        )
      : await getDbClient().exec(
          `UPDATE sessions
              SET runtime_owner_id = ?, runtime_owner_pid = ?,
                  runtime_owner_process_start = ?, runtime_owner_heartbeat_at = ?
            WHERE id = ? AND status = 'active' AND runtime_owner_id IS NULL`,
          [leaseToken, process.pid, processStartFingerprint, heartbeatAt, sessionId],
        );
    if (result.changes === 0) continue;

    locallyOwnedSessionTokens.set(sessionId, leaseToken);
    ensureHeartbeatTimer();
    let released = false;
    return async () => {
      if (released) return;
      released = await releaseSessionRuntimeOwnership(sessionId, leaseToken);
    };
  }
  const latest = await readOwner(sessionId);
  if (!latest || latest.status !== 'active') {
    throw new SessionRuntimeInactiveError(sessionId, latest?.status ?? null);
  }
  throw new SessionRuntimeOwnedElsewhereError(sessionId, latest.runtime_owner_pid);
}

export async function releaseSessionRuntimeOwnership(
  sessionId: string,
  leaseToken = locallyOwnedSessionTokens.get(sessionId),
): Promise<boolean> {
  if (!leaseToken) return true;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await getDbClient().exec(
        `UPDATE sessions
            SET runtime_owner_id = NULL,
                runtime_owner_pid = NULL,
                runtime_owner_process_start = NULL,
                runtime_owner_heartbeat_at = NULL
          WHERE id = ? AND runtime_owner_id = ?`,
        [sessionId, leaseToken],
      );
      if (locallyOwnedSessionTokens.get(sessionId) === leaseToken) {
        locallyOwnedSessionTokens.delete(sessionId);
      }
      if (locallyOwnedSessionTokens.size === 0 && heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  log.warn('failed to release session runtime ownership', {
      sessionId,
      err: lastError instanceof Error ? lastError.message : String(lastError),
  });
  // Keep the exact local token and heartbeat alive: the caller can retry, and
  // no delayed release can ever clear a replacement token.
  return false;
}

/** Clear only an expired foreign lease before a status transition. */
export async function clearDeadForeignSessionRuntimeOwner(sessionId: string): Promise<void> {
  const row = await readOwner(sessionId);
  if (!row?.runtime_owner_id) return;
  if (locallyOwnedSessionTokens.get(sessionId) === row.runtime_owner_id) return;
  if (isOwnerFresh(row) || (await isSameOwnerProcessStillAlive(row))) return;
  await getDbClient().exec(
    `UPDATE sessions
        SET runtime_owner_id = NULL,
            runtime_owner_pid = NULL,
            runtime_owner_process_start = NULL,
            runtime_owner_heartbeat_at = NULL
      WHERE id = ? AND runtime_owner_id = ? AND runtime_owner_heartbeat_at IS ?`,
    [sessionId, row.runtime_owner_id, row.runtime_owner_heartbeat_at],
  );
}

export async function assertSessionRuntimeOwnedLocallyOrUnclaimed(
  sessionId: string,
): Promise<void> {
  await clearDeadForeignSessionRuntimeOwner(sessionId);
  const row = await readOwner(sessionId);
  if (
    row?.runtime_owner_id &&
    locallyOwnedSessionTokens.get(sessionId) !== row.runtime_owner_id
  ) {
    throw new SessionRuntimeOwnedElsewhereError(sessionId, row.runtime_owner_pid);
  }
}

export const __testing = {
  processOwnerPrefix,
  heartbeatMs: RUNTIME_OWNER_HEARTBEAT_MS,
  staleMs: RUNTIME_OWNER_STALE_MS,
  isOwnerFresh,
  readProcessStartFingerprint,
  isProcessAliveConservatively,
  isSameOwnerProcessStillAlive,
  locallyOwnedSessionTokens,
};
