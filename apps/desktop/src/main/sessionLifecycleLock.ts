/**
 * Cross-process lifecycle serialization for one logical session.
 *
 * A physical IM session id may be replaced after permanent deletion, while all
 * generations still own the same logical lifecycle. Every status transition
 * and every producer that can create runtime/files/queue state must therefore
 * serialize on COALESCE(im_logical_session_id, id), not only on the physical id.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';

import { withCrossProcessLock } from './device-link/crossProcessLock.js';
import { getCurrentDbClientUserId, getDbClient } from './localDb/client/current.js';
import { createLogger } from './logger.js';

const log = createLogger('session-lifecycle-lock');
const sessionLifecycleTails = new Map<string, Promise<void>>();
const SESSION_LIFECYCLE_LOCK_WAIT_MS = 60_000;

export interface SessionLifecycleIdentity {
  requestedSessionId: string;
  logicalSessionId: string;
}

export type SessionLifecycleLockResult<T> =
  | { acquired: false; reason: 'lookup-failed' | 'busy' | 'unavailable' }
  | { acquired: true; identity: SessionLifecycleIdentity; value: T };

export type ActiveSessionLifecycleResult<T> =
  | { admitted: false; reason: 'lookup-failed' | 'busy' | 'unavailable' }
  | { admitted: false; reason: 'missing' | 'archived' | 'deleted' }
  | { admitted: true; identity: SessionLifecycleIdentity; value: T };

export type SessionLifecycleLeaseResult =
  | { acquired: false; reason: 'lookup-failed' | 'busy' | 'unavailable' }
  | {
      acquired: true;
      identity: SessionLifecycleIdentity;
      release: () => void;
    };

async function resolveSessionLifecycleIdentity(
  sessionId: string,
): Promise<SessionLifecycleIdentity | null> {
  try {
    const row = await getDbClient().queryOne<{ lifecycleId: string }>(
      'SELECT COALESCE(im_logical_session_id, id) AS lifecycleId FROM sessions WHERE id = ? LIMIT 1',
      [sessionId],
    );
    return {
      requestedSessionId: sessionId,
      // A not-yet-created explicit session still needs a stable admission lock.
      logicalSessionId: row?.lifecycleId || sessionId,
    };
  } catch (err) {
    log.warn('session lifecycle identity lookup failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function withProcessLocalLifecycleLock<T>(
  logicalSessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = sessionLifecycleTails.get(logicalSessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  sessionLifecycleTails.set(logicalSessionId, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (sessionLifecycleTails.get(logicalSessionId) === tail) {
      sessionLifecycleTails.delete(logicalSessionId);
    }
  }
}

async function withResolvedSessionLifecycleLock<T>(
  identity: SessionLifecycleIdentity,
  run: () => Promise<T>,
): Promise<SessionLifecycleLockResult<T>> {
  return withProcessLocalLifecycleLock(identity.logicalSessionId, async () => {
    const ownerId = getCurrentDbClientUserId() ?? 'unknown-owner';
    const lockKey = createHash('sha256')
      .update(ownerId)
      .update('\0')
      .update(identity.logicalSessionId)
      .digest('hex');
    const lockDir = path.join(app.getPath('userData'), 'session-lifecycle-locks');
    try {
      await fs.mkdir(lockDir, { recursive: true });
    } catch (err) {
      log.warn('session lifecycle lock directory unavailable', {
        sessionId: identity.requestedSessionId,
        logicalSessionId: identity.logicalSessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return { acquired: false, reason: 'unavailable' };
    }
    return withCrossProcessLock(
      path.join(lockDir, `${lockKey}.lock`),
      {
        label: `session-lifecycle:${lockKey.slice(0, 12)}`,
        waitMs: SESSION_LIFECYCLE_LOCK_WAIT_MS,
      },
      async (status): Promise<SessionLifecycleLockResult<T>> => {
        if (!status.held) {
          log.warn('session lifecycle operation rejected without cross-process lock', {
            sessionId: identity.requestedSessionId,
            logicalSessionId: identity.logicalSessionId,
            reason: status.reason,
          });
          return { acquired: false, reason: status.reason };
        }
        return { acquired: true, identity, value: await run() };
      },
    );
  });
}

export async function withSessionLifecycleLock<T>(
  sessionId: string,
  run: (identity: SessionLifecycleIdentity) => Promise<T>,
): Promise<SessionLifecycleLockResult<T>> {
  const identity = await resolveSessionLifecycleIdentity(sessionId);
  if (!identity) return { acquired: false, reason: 'lookup-failed' };
  return withResolvedSessionLifecycleLock(identity, () => run(identity));
}

/**
 * Acquire a lifecycle lock whose release boundary is controlled by the caller.
 * This is for long producer setup functions that must stop holding the lock as
 * soon as Session.send settles, while their turn observer continues afterward.
 */
export async function acquireSessionLifecycleLease(
  sessionId: string,
): Promise<SessionLifecycleLeaseResult> {
  let readySettled = false;
  let settleReady!: (result: SessionLifecycleLeaseResult) => void;
  const ready = new Promise<SessionLifecycleLeaseResult>((resolve) => {
    settleReady = (result) => {
      if (readySettled) return;
      readySettled = true;
      resolve(result);
    };
  });

  const held = withSessionLifecycleLock(sessionId, async (identity) => {
    await new Promise<void>((resolveRelease) => {
      let released = false;
      settleReady({
        acquired: true,
        identity,
        release: () => {
          if (released) return;
          released = true;
          resolveRelease();
        },
      });
    });
  });
  void held.then(
    (result) => {
      if (!result.acquired) settleReady(result);
    },
    (err) => {
      log.warn('session lifecycle lease failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      settleReady({ acquired: false, reason: 'unavailable' });
    },
  );
  return ready;
}

/**
 * Admit one producer while the persisted physical generation is still active.
 *
 * This helper intentionally owns only the cross-process logical lifecycle
 * lock. Callers that already hold or acquire a process-local route/agent-switch
 * lock can compose it without recursively taking that lock. Producers that do
 * not own such a lock should continue using register.ts's
 * withActiveSessionRouteLock.
 */
export async function withActiveSessionLifecycleLock<T>(
  sessionId: string,
  run: (identity: SessionLifecycleIdentity) => Promise<T>,
): Promise<ActiveSessionLifecycleResult<T>> {
  const locked = await withSessionLifecycleLock(sessionId, async (identity) => {
    const row = await getDbClient().queryOne<{ status: string }>(
      'SELECT status FROM sessions WHERE id = ? LIMIT 1',
      [sessionId],
    );
    if (!row) return { admitted: false as const, reason: 'missing' as const };
    if (row.status === 'deleted') {
      return { admitted: false as const, reason: 'deleted' as const };
    }
    if (row.status !== 'active') {
      return { admitted: false as const, reason: 'archived' as const };
    }
    return { admitted: true as const, value: await run(identity) };
  });
  if (!locked.acquired) return { admitted: false, reason: locked.reason };
  if (!locked.value.admitted) return locked.value;
  return {
    admitted: true,
    identity: locked.identity,
    value: locked.value.value,
  };
}

/**
 * Acquire multiple logical lifecycle locks in stable order. This is required
 * for one WeChat poll batch that may route attachments for several peers.
 */
export async function withSessionLifecycleLocks<T>(
  sessionIds: string[],
  run: (identities: SessionLifecycleIdentity[]) => Promise<T>,
): Promise<SessionLifecycleLockResult<T>> {
  const resolved = await Promise.all(sessionIds.map(resolveSessionLifecycleIdentity));
  if (resolved.some((identity) => identity === null)) {
    return { acquired: false, reason: 'lookup-failed' };
  }
  const unique = new Map<string, SessionLifecycleIdentity>();
  for (const identity of resolved as SessionLifecycleIdentity[]) {
    if (!unique.has(identity.logicalSessionId)) unique.set(identity.logicalSessionId, identity);
  }
  const identities = [...unique.values()].sort((a, b) =>
    a.logicalSessionId.localeCompare(b.logicalSessionId),
  );

  const acquireAt = async (index: number): Promise<SessionLifecycleLockResult<T>> => {
    if (index >= identities.length) {
      return {
        acquired: true,
        identity: identities[0] ?? { requestedSessionId: '', logicalSessionId: '' },
        value: await run(identities),
      };
    }
    const result = await withResolvedSessionLifecycleLock(identities[index], () =>
      acquireAt(index + 1),
    );
    if (!result.acquired) return result;
    return result.value;
  };

  return acquireAt(0);
}

export const __testing = {
  waitMs: SESSION_LIFECYCLE_LOCK_WAIT_MS,
};
