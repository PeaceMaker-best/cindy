/**
 * Best-effort cleanup for resources owned by a permanently deleted session.
 *
 * The caller may provide a lifecycle guard that is rechecked before every
 * resource family. Each family is isolated so one filesystem or ledger failure
 * cannot prevent the remaining cleanup work from running while the session is
 * still eligible for deletion.
 */

import * as imageCacheStore from './imageCacheStore';
import { removeSessionRefs as removeSessionMediaRefs } from './cindy-media/ledger';
import { removeWechatSessionAttachmentDir } from './im/wechat/mediaStaging';
import { getCurrentDbClientUserId, getDbClient } from './localDb/client/current';
import type { DbClient } from './localDb/client/DbClient';
import { listDeletedSessionChatAttachmentPaths } from './localDb/ipc/messages';
import { removeOwnedStagedChatAttachments } from './file-browser/remote-file-cache';
import { createLogger } from './logger';

const log = createLogger('session-deletion-cleanup');

export interface SessionDeletionCleanupDependencies {
  removeLegacyImages(sessionId: string): Promise<void>;
  removeStagedAttachments(
    sessionId: string,
    shouldContinue?: () => Promise<boolean>,
  ): Promise<number>;
  removeMediaRefs(sessionId: string): Promise<number>;
  removeWechatAttachments(sessionId: string): Promise<void>;
}

export interface SessionDeletionCleanupOptions {
  dependencies?: SessionDeletionCleanupDependencies;
  shouldContinue?: () => Promise<boolean>;
  /** Captured database handle for startup reconciliation. */
  dbClient?: DbClient;
  /** Captured owner for staged attachment deletion. */
  ownerId?: string;
}

function createProductionDependencies(
  options: Pick<SessionDeletionCleanupOptions, 'dbClient' | 'ownerId' | 'shouldContinue'>,
): SessionDeletionCleanupDependencies {
  return {
    removeLegacyImages: (sessionId) => imageCacheStore.removeSession(sessionId),
    removeStagedAttachments: async (sessionId, shouldContinue) => {
      const ownerId = options.ownerId ?? getCurrentDbClientUserId();
      if (!ownerId) throw new Error('data owner unavailable for staged attachment cleanup');
      const dbClient = options.dbClient ?? getDbClient();
      const filePaths = await listDeletedSessionChatAttachmentPaths(sessionId, dbClient);
      return removeOwnedStagedChatAttachments({
        ownerId,
        filePaths,
        canRemove: shouldContinue,
      });
    },
    removeMediaRefs: (sessionId) =>
      removeSessionMediaRefs(sessionId, (options.dbClient ?? getDbClient()).drizzle),
    removeWechatAttachments: (sessionId) => removeWechatSessionAttachmentDir(sessionId),
  };
}

export async function cleanupDeletedSessionResources(
  sessionId: string,
  options: SessionDeletionCleanupOptions = {},
): Promise<boolean> {
  const dependencies = options.dependencies ?? createProductionDependencies(options);
  const tasks = [
    {
      name: 'legacy image cache',
      run: () => dependencies.removeLegacyImages(sessionId),
    },
    {
      name: 'staged chat attachments',
      run: async () => {
        const count = await dependencies.removeStagedAttachments(sessionId, options.shouldContinue);
        if (count > 0) log.info('session staged chat attachments removed', { sessionId, count });
      },
    },
    {
      name: 'media refs',
      run: async () => {
        const count = await dependencies.removeMediaRefs(sessionId);
        if (count > 0) log.info('session media refs removed', { sessionId, count });
      },
    },
    {
      name: 'WeChat attachments',
      run: () => dependencies.removeWechatAttachments(sessionId),
    },
  ];

  let allSucceeded = true;
  for (const task of tasks) {
    if (options.shouldContinue && !(await options.shouldContinue())) return false;
    try {
      await task.run();
    } catch (err) {
      allSucceeded = false;
      log.warn('deleted session resource cleanup failed', {
        sessionId,
        resource: task.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (options.shouldContinue && !(await options.shouldContinue())) return false;
  }
  return allSucceeded;
}
