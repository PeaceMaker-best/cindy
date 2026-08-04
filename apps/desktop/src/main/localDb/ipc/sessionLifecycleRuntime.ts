import type { Maker } from '@cindy/maker-core';

export interface SessionLifecycleRuntimeDeps {
  prepareSessionRuntimeForPermanentDeletion(
    sessionId: string,
  ): Promise<() => Promise<void>>;
  getMakerIfReady(): Maker | null;
  getGoalController(): { clearGoal(sessionId: string): Promise<void> } | null;
  isSessionStillRemovable(sessionId: string): Promise<boolean>;
  recycleWorktreeForRemovedSession(sessionId: string): Promise<void>;
  drainPersistQueue(): Promise<void>;
  notifyGhostSessionEvent(
    kind: 'created' | 'archived' | 'switched',
    data: { sessionId: string; workdir?: string },
  ): void;
}

let deps: SessionLifecycleRuntimeDeps | null = null;

/** Configure cyclic Desktop runtime services from the bootstrap composition root. */
export function configureSessionLifecycleRuntime(next: SessionLifecycleRuntimeDeps): void {
  deps = next;
}

/** Fail closed when a lifecycle callback fires before bootstrap wiring completes. */
export function getSessionLifecycleRuntime(): SessionLifecycleRuntimeDeps {
  if (!deps) {
    throw new Error('Session lifecycle runtime is not initialized');
  }
  return deps;
}
