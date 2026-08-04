import { throwIpcError } from '../utils/ipcValidate.js';
import { withSessionLifecycleLock } from '../sessionLifecycleLock.js';

export const sendToSessionLocks = new Map<string, Promise<unknown>>();

/** Acquire the local route lease used by every producer for one session. */
export async function acquireSendToSessionLock(sessionId: string): Promise<() => void> {
  const previous = sendToSessionLocks.get(sessionId);
  const waitPrevious = previous ? previous.catch(() => undefined) : Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const run = waitPrevious.then(() => gate);
  const tracked = run.finally(() => {
    if (sendToSessionLocks.get(sessionId) === tracked) {
      sendToSessionLocks.delete(sessionId);
    }
  });
  sendToSessionLocks.set(sessionId, tracked);
  await waitPrevious;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
  };
}

/** Serialize local sends and runtime route changes for one session. */
export async function withSendToSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquireSendToSessionLock(sessionId);
  try {
    return await task();
  } finally {
    release();
  }
}

/** Serialize a route operation with the cross-process session lifecycle lock. */
export async function withSessionRouteLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const locked = await withSessionLifecycleLock(sessionId, () =>
    withSendToSessionLock(sessionId, task),
  );
  if (!locked.acquired) {
    throwIpcError(
      'PRECONDITION_FAILED',
      `Session lifecycle is busy or unavailable: ${sessionId}`,
    );
  }
  return locked.value;
}
