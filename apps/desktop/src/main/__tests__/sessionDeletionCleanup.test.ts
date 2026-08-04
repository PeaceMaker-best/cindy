import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../imageCacheStore', () => ({ removeSession: vi.fn(async () => undefined) }));
vi.mock('../localDb/client/current', () => ({ getCurrentDbClientUserId: vi.fn(() => 'owner-1') }));
vi.mock('../localDb/ipc/messages', () => ({
  listDeletedSessionChatAttachmentPaths: vi.fn(async () => []),
}));
vi.mock('../file-browser/remote-file-cache', () => ({
  removeOwnedStagedChatAttachments: vi.fn(async () => 0),
}));
vi.mock('../cindy-media/ledger', () => ({
  removeSessionRefs: vi.fn(async () => 0),
}));
vi.mock('../im/wechat/mediaStaging', () => ({
  removeWechatSessionAttachmentDir: vi.fn(async () => undefined),
}));

import { cleanupDeletedSessionResources } from '../sessionDeletionCleanup';

describe('cleanupDeletedSessionResources', () => {
  it('runs every resource cleanup even when one family fails', async () => {
    const removeLegacyImages = vi.fn(() => {
      throw new Error('locked');
    });
    const removeStagedAttachments = vi.fn(async () => 1);
    const removeMediaRefs = vi.fn(async () => 2);
    const removeWechatAttachments = vi.fn(async () => undefined);

    await expect(
      cleanupDeletedSessionResources('session-1', {
        dependencies: {
          removeLegacyImages,
          removeStagedAttachments,
          removeMediaRefs,
          removeWechatAttachments,
        },
      }),
    ).resolves.toBe(false);

    expect(removeLegacyImages).toHaveBeenCalledWith('session-1');
    expect(removeStagedAttachments).toHaveBeenCalledWith('session-1', undefined);
    expect(removeMediaRefs).toHaveBeenCalledWith('session-1');
    expect(removeWechatAttachments).toHaveBeenCalledWith('session-1');
  });

  it('stops before the next resource family when the session is restored', async () => {
    const removeLegacyImages = vi.fn(async () => undefined);
    const removeStagedAttachments = vi.fn(async () => 1);
    const removeMediaRefs = vi.fn(async () => 0);
    const removeWechatAttachments = vi.fn(async () => undefined);
    const shouldContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(
      cleanupDeletedSessionResources('session-1', {
        dependencies: {
          removeLegacyImages,
          removeStagedAttachments,
          removeMediaRefs,
          removeWechatAttachments,
        },
        shouldContinue,
      }),
    ).resolves.toBe(false);

    expect(shouldContinue).toHaveBeenCalledTimes(2);
    expect(removeLegacyImages).toHaveBeenCalledWith('session-1');
    expect(removeStagedAttachments).not.toHaveBeenCalled();
    expect(removeMediaRefs).not.toHaveBeenCalled();
    expect(removeWechatAttachments).not.toHaveBeenCalled();
  });
});
