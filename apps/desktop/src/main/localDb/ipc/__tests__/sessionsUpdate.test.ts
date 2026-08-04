/**
 * sessionsUpdate.test.ts — `local-db:sessions:update` handler 集成接线。
 * -------------------------------------------------------------------
 * 覆盖持久化后需要广播的增量字段，以及会话移动触发 CLI 转录迁移的边界：
 * workingDir 实际变化、且会话是本机 cc 会话时，必须在查询返回行之前调用
 * relocateClaudeTranscriptsForSessionMove(旧值 → 新值)，并把迁移中持久化的最新
 * sdkSessionId 并入返回行与广播 patch；其它会话或未实际移动时不得调用。
 *
 * 通过 mock electron ipcMain 捕获真实 handler + 内存 sqlite 全列 sessions 表做集成断言。
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { messages, sessions } from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as InstanceType<typeof import('better-sqlite3')> | null,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  relocate: vi.fn(async (): Promise<{ persistedSdkSessionId: string | null }> => ({
    persistedSdkSessionId: null,
  })),
  execDb: vi.fn(),
  tapWindowBroadcast: vi.fn(),
  summarizeSession: vi.fn(async () => undefined),
  prepareSessionRuntimeForPermanentDeletion: vi.fn(async () => undefined),
  clearGoal: vi.fn(async () => undefined),
  prepareDeletedLifecycle: vi.fn(async (_args?: unknown) => true),
  cleanupDeletedSessionResources: vi.fn(async () => true),
  closeSession: vi.fn(async () => undefined),
  sealSession: vi.fn(async () => undefined),
  unsealSession: vi.fn(async () => undefined),
  assertSessionRuntimeOwnedLocallyOrUnclaimed: vi.fn(async () => undefined),
  recycleWorktreeForRemovedSession: vi.fn(async () => undefined),
  withSendToSessionLock: vi.fn(async (_sessionId: string, run: () => Promise<unknown>) => run()),
  withCrossProcessLock: vi.fn(
    async (
      _path: string,
      _opts: unknown,
      run: (
        status: { held: true } | { held: false; reason: 'busy' | 'unavailable' },
      ) => Promise<unknown>,
    ) => run({ held: true }),
  ),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  app: { getPath: () => '/tmp/cindy-sessions-update-test' },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../client/current', () => ({
  getCurrentDbClientUserId: () => 'test-user',
  getDbClient: () => ({
    drizzle: h.db,
    query: async (sql: string, params: unknown[] = []) => h.sqlite!.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('lifecycleId')) {
        return h
          .sqlite!.prepare(
            'SELECT COALESCE(im_logical_session_id, id) AS lifecycleId FROM sessions WHERE id = ? LIMIT 1',
          )
          .get(params[0]) as { lifecycleId: string } | undefined;
      }
      if (sql.includes('session_deletion_finalizations')) {
        return h.sqlite!.prepare(sql).get(...params) as { finalized: number } | undefined;
      }
      return h
        .sqlite!.prepare('SELECT status FROM sessions WHERE id = ? LIMIT 1')
        .get(params[0]) as { status: string } | undefined;
    },
    exec: (sql: string, params: unknown[] = []) => h.execDb(sql, params),
    tx: async (name: string, args: unknown) => {
      if (name !== 'session.prepareDeletedLifecycle') {
        throw new Error(`unexpected tx: ${name}`);
      }
      return h.prepareDeletedLifecycle(args);
    },
  }),
}));
vi.mock('../../../device-link/crossProcessLock.js', () => ({
  withCrossProcessLock: h.withCrossProcessLock,
}));
vi.mock('../../../sessionRuntimeOwnership.js', () => ({
  assertSessionRuntimeOwnedLocallyOrUnclaimed: h.assertSessionRuntimeOwnedLocallyOrUnclaimed,
  getSessionRuntimeOwnerPrefix: () => 'test-runtime-owner',
}));
vi.mock('../../dialogueWorkspace', () => ({ ensureDialogueWorkspaceDir: vi.fn() }));
vi.mock('../../../git-context/prRefsStore', () => ({
  recomputePrRefsForSession: vi.fn(async () => undefined),
}));
vi.mock('../../../sessionDeletionCleanup', () => ({
  cleanupDeletedSessionResources: h.cleanupDeletedSessionResources,
}));
vi.mock('../sessionLifecycleRuntime.js', () => ({
  getSessionLifecycleRuntime: () => ({
    prepareSessionRuntimeForPermanentDeletion: h.prepareSessionRuntimeForPermanentDeletion,
    getMakerIfReady: () => ({
      closeSession: h.closeSession,
      sealSession: h.sealSession,
      unsealSession: h.unsealSession,
    }),
    getGoalController: () => ({ clearGoal: h.clearGoal }),
    isSessionStillRemovable: vi.fn(async () => false),
    recycleWorktreeForRemovedSession: h.recycleWorktreeForRemovedSession,
    drainPersistQueue: vi.fn(async () => undefined),
    notifyGhostSessionEvent: vi.fn(),
  }),
}));
vi.mock('../../../maker-host/index.js', () => ({
  getMakerIfReady: () => ({
    closeSession: h.closeSession,
    sealSession: h.sealSession,
    unsealSession: h.unsealSession,
  }),
}));
vi.mock('../../../worktree/sessionRemovalRecycle.js', () => ({
  isSessionStillRemovable: vi.fn(async () => false),
  recycleWorktreeForRemovedSession: h.recycleWorktreeForRemovedSession,
}));
vi.mock('../../../maker-ipc/register.js', () => ({
  withSendToSessionLock: h.withSendToSessionLock,
  prepareSessionRuntimeForPermanentDeletion: h.prepareSessionRuntimeForPermanentDeletion,
}));
vi.mock('../../../maker-ipc/sessionRouteLock.js', () => ({
  withSendToSessionLock: h.withSendToSessionLock,
}));
vi.mock('../../../goal-host/index.js', () => ({
  getGoalController: () => ({ clearGoal: h.clearGoal }),
}));
vi.mock('../recentWorkdirs', () => ({ upsertRecentWorkdir: vi.fn(async () => undefined) }));
vi.mock('../../../device-link/broadcast-tap.js', () => ({
  tapWindowBroadcast: h.tapWindowBroadcast,
}));
vi.mock('../../../sessionTaskSummary.js', () => ({
  maybeGenerateSessionTaskSummary: h.summarizeSession,
}));
vi.mock('../../agentIslandSessionPatch', () => ({ notifyAgentIslandSessionPatch: vi.fn() }));
vi.mock('../../../messagePersistBroadcaster', () => ({
  noteSessionClearBoundary: vi.fn(),
  drainPersistQueue: vi.fn(async () => undefined),
}));
vi.mock('../../../sessionIds', () => ({ resolveBusinessSessionId: (id: string) => id }));
vi.mock('../../../maker-host/claude-transcript-relocation.js', () => ({
  relocateClaudeTranscriptsForSessionMove: h.relocate,
}));

import {
  commitAndFinalizeSessionDeletion,
  finalizeDeletedSessionLifecycle,
  patchSessionMetaInDb,
  reconcileDeletedSessionLifecycles,
  registerSessionIpc,
  withFinalizedDeletedSession,
} from '../sessions';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createDb(): void {
  const sqlite = new Database(':memory:');
  // 与 schema.ts 的 sessions/messages 全列对齐(selectSessionWithCount select 全列)。
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New CCS',
      working_dir TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      user_send_at INTEGER,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      im_logical_session_id TEXT,
      im_generation INTEGER NOT NULL DEFAULT 0,
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      one_m INTEGER NOT NULL DEFAULT 0,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      orca_role TEXT,
      remote_host_id TEXT,
      codex_history_has_product_prompt INTEGER,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      summary TEXT,
      provider_id TEXT,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      runtime_owner_id TEXT,
      runtime_owner_pid INTEGER,
      runtime_owner_process_start TEXT,
      runtime_owner_heartbeat_at INTEGER
    );
    CREATE TABLE session_deletion_finalizations (
      session_id TEXT PRIMARY KEY NOT NULL,
      finalized_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
  `);
  const insert = sqlite.prepare(`
    INSERT INTO sessions (id, working_dir, agent_kind, remote_host_id, workspace_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `);
  insert.run('cc-local', '/old/dir', 'cc', null, 'dialogue');
  insert.run('codex-local', '/old/dir', 'codex', null, 'dialogue');
  insert.run('cc-remote', '/remote/dir', 'cc', 'host-1', 'project');
  h.sqlite = sqlite;
  h.db = drizzle(sqlite, { schema: { messages, sessions } });
}

async function invokeUpdate(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:update');
  if (!handler) throw new Error('update handler not registered');
  return handler({}, id, patch);
}

async function invokePatchMeta(id: string, patch: Record<string, unknown>): Promise<unknown> {
  const handler = h.handlers.get('local-db:sessions:patch-meta');
  if (!handler) throw new Error('patch-meta handler not registered');
  return handler({}, id, patch);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.relocate.mockImplementation(async () => ({ persistedSdkSessionId: null }));
  h.prepareSessionRuntimeForPermanentDeletion.mockResolvedValue(undefined);
  h.clearGoal.mockResolvedValue(undefined);
  h.prepareDeletedLifecycle.mockResolvedValue(true);
  h.cleanupDeletedSessionResources.mockResolvedValue(true);
  h.closeSession.mockResolvedValue(undefined);
  h.sealSession.mockResolvedValue(undefined);
  h.unsealSession.mockResolvedValue(undefined);
  h.recycleWorktreeForRemovedSession.mockResolvedValue(undefined);
  h.withSendToSessionLock.mockImplementation(
    async (_sessionId: string, run: () => Promise<unknown>) => run(),
  );
  h.withCrossProcessLock.mockImplementation(
    async (
      _path: string,
      _opts: unknown,
      run: (
        status: { held: true } | { held: false; reason: 'busy' | 'unavailable' },
      ) => Promise<unknown>,
    ) => run({ held: true }),
  );
  h.execDb.mockImplementation(async (sql: string, params: unknown[] = []) =>
    h.sqlite!.prepare(sql).run(...params),
  );
  h.handlers.clear();
  createDb();
  registerSessionIpc();
});

describe('local-db:sessions:update handler wiring', () => {
  it('persists and broadcasts title-only patches to device-link subscribers', async () => {
    await invokeUpdate('codex-local', { title: '排查远程标题同步' });

    const persisted = h
      .sqlite!.prepare('SELECT title FROM sessions WHERE id = ?')
      .get('codex-local') as { title: string };
    expect(persisted.title).toBe('排查远程标题同步');
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: expect.objectContaining({ title: '排查远程标题同步' }),
      }),
    );
  });

  it('broadcasts permission setting patches to every mounted client', async () => {
    await invokeUpdate('codex-local', { permissionMode: 'ask' });

    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'codex-local',
        patch: { permissionMode: 'ask' },
      }),
    );
  });

  it('broadcasts pin and unpin patches to device-link subscribers', async () => {
    const pinnedAt = '2026-08-03T04:08:26.000Z';
    await invokeUpdate('codex-local', { pinnedAt });
    await vi.dynamicImportSettled();

    const pinned = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null };
    expect(pinned.pinnedAt).toBe(Date.parse(pinnedAt));
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt, status: 'active' },
    });
    expect(h.summarizeSession).toHaveBeenCalledWith('codex-local');

    h.tapWindowBroadcast.mockClear();
    h.summarizeSession.mockClear();
    await invokeUpdate('codex-local', { pinnedAt: null });

    const unpinned = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null };
    expect(unpinned.pinnedAt).toBeNull();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt: null },
    });
    expect(h.summarizeSession).not.toHaveBeenCalled();
  });

  it('broadcasts the stored value and skips summary generation for an invalid pin date', async () => {
    await invokeUpdate('codex-local', { pinnedAt: 'not-a-date' });
    await vi.dynamicImportSettled();

    const persisted = h
      .sqlite!.prepare('SELECT pinned_at AS pinnedAt FROM sessions WHERE id = ?')
      .get('codex-local') as { pinnedAt: number | null };
    expect(persisted.pinnedAt).toBeNull();
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith('local-db:sessions:patched', {
      sessionId: 'codex-local',
      patch: { pinnedAt: null },
    });
    expect(h.summarizeSession).not.toHaveBeenCalled();
  });

  it('relocates transcripts when workingDir actually changes on a local cc session', async () => {
    await invokeUpdate('cc-local', { workingDir: '/new/dir', workspaceKind: 'project' });

    expect(h.relocate).toHaveBeenCalledTimes(1);
    expect(h.relocate).toHaveBeenCalledWith('cc-local', '/old/dir', '/new/dir');
  });

  it('returns and broadcasts the sdkSessionId persisted during relocation', async () => {
    const liveId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    // 模拟真实编排:迁移把内存 id 持久化进 DB 并上报;handler 必须在迁移后才查
    // 返回行,并把该 id 并入广播 patch,renderer 才不会留着旧 resume id。
    h.relocate.mockImplementation(async () => {
      h.sqlite!.prepare('UPDATE sessions SET sdk_session_id = ? WHERE id = ?').run(
        liveId,
        'cc-local',
      );
      return { persistedSdkSessionId: liveId };
    });

    const updated = (await invokeUpdate('cc-local', {
      workingDir: '/new/dir',
      workspaceKind: 'project',
    })) as { sdkSessionId: string | null };

    expect(updated.sdkSessionId).toBe(liveId);
    expect(h.tapWindowBroadcast).toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({
        sessionId: 'cc-local',
        patch: expect.objectContaining({ sdkSessionId: liveId }),
      }),
    );
  });

  it('does nothing when the patched workingDir equals the current one', async () => {
    await invokeUpdate('cc-local', { workingDir: '/old/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when a legacy Windows spelling normalizes to the patched workingDir', async () => {
    h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(
      'D:\\repo\\project',
      'cc-local',
    );

    await invokeUpdate('cc-local', { workingDir: 'D:/repo/project' });

    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing when the patch has no workingDir (move back to dialogue)', async () => {
    await invokeUpdate('cc-local', { workspaceKind: 'dialogue' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing for codex sessions', async () => {
    await invokeUpdate('codex-local', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('does nothing for remote sessions', async () => {
    await invokeUpdate('cc-remote', { workingDir: '/new/dir' });
    expect(h.relocate).not.toHaveBeenCalled();
  });

  it('routes local and remote permanent deletion through the same Main cleanup', async () => {
    await invokeUpdate('cc-local', { status: 'deleted' });
    await vi.waitFor(() => {
      expect(h.cleanupDeletedSessionResources).toHaveBeenCalledWith('cc-local', {
        shouldContinue: expect.any(Function),
      });
    });

    h.cleanupDeletedSessionResources.mockClear();
    await invokePatchMeta('cc-remote', { status: 'deleted' });
    await vi.waitFor(() => {
      expect(h.cleanupDeletedSessionResources).toHaveBeenCalledWith('cc-remote', {
        shouldContinue: expect.any(Function),
      });
    });
  });

  it('does not run permanent resource cleanup for archive', async () => {
    await invokeUpdate('cc-local', { status: 'archived' });
    await vi.dynamicImportSettled();
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
  });

  it('skips a stale compatibility cleanup call after the session is active again', async () => {
    await finalizeDeletedSessionLifecycle('cc-local');
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
  });

  it('startup reconciliation isolates one failed tombstone and finalizes the rest', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.sqlite!.prepare(
      `INSERT INTO sessions (id, status, created_at, updated_at)
       VALUES ('zz-deleted', 'deleted', 2, 2)`,
    ).run();
    h.assertSessionRuntimeOwnedLocallyOrUnclaimed
      .mockRejectedValueOnce(new Error('foreign runtime still owns cc-local'))
      .mockResolvedValue(undefined);

    await expect(reconcileDeletedSessionLifecycles()).resolves.toEqual({
      scanned: 2,
      completed: 1,
      pending: 1,
    });
    expect(h.assertSessionRuntimeOwnedLocallyOrUnclaimed).toHaveBeenNthCalledWith(1, 'cc-local');
    expect(h.assertSessionRuntimeOwnedLocallyOrUnclaimed).toHaveBeenNthCalledWith(2, 'zz-deleted');
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalledTimes(1);
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalledWith(
      'zz-deleted',
      expect.objectContaining({ shouldContinue: expect.any(Function) }),
    );
    expect(
      h.sqlite!.prepare('SELECT session_id FROM session_deletion_finalizations').all(),
    ).toEqual([{ session_id: 'zz-deleted' }]);

    h.assertSessionRuntimeOwnedLocallyOrUnclaimed.mockRejectedValueOnce(
      new Error('foreign runtime still owns cc-local'),
    );
    h.cleanupDeletedSessionResources.mockClear();
    await expect(reconcileDeletedSessionLifecycles()).resolves.toEqual({
      scanned: 1,
      completed: 0,
      pending: 1,
    });
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
  });

  it('does not repeat cleanup for a finalized tombstone but still runs a fresh-generation transition', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.sqlite!.prepare(
      'INSERT INTO session_deletion_finalizations (session_id, finalized_at) VALUES (?, ?)',
    ).run('cc-local', Date.now());
    const transition = vi.fn(async () => 'fresh');

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBe('fresh');
    expect(h.prepareDeletedLifecycle).not.toHaveBeenCalled();
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledOnce();
  });

  it('retries marker persistence after cleanup succeeds but marker commit fails', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.execDb.mockRejectedValueOnce(new Error('marker write failed'));

    await expect(finalizeDeletedSessionLifecycle('cc-local')).resolves.toBe(false);
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalledTimes(1);
    expect(
      h.sqlite!.prepare('SELECT 1 FROM session_deletion_finalizations WHERE session_id = ?').get(
        'cc-local',
      ),
    ).toBeUndefined();

    await expect(finalizeDeletedSessionLifecycle('cc-local')).resolves.toBe(true);
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalledTimes(2);
    expect(
      h.sqlite!.prepare('SELECT 1 FROM session_deletion_finalizations WHERE session_id = ?').get(
        'cc-local',
      ),
    ).toEqual({ 1: 1 });
  });

  it('holds the send-route lock while preparing relations, cleaning resources, and transitioning', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    const events: string[] = [];
    h.withSendToSessionLock.mockImplementation(async (_sessionId, run) => {
      events.push('lock:start');
      const result = await run();
      events.push('lock:end');
      return result;
    });
    h.prepareDeletedLifecycle.mockImplementation(async () => {
      events.push('lifecycle:prepared');
      return true;
    });
    h.recycleWorktreeForRemovedSession.mockImplementation(async () => {
      events.push('worktree:cleaned');
    });
    h.cleanupDeletedSessionResources.mockImplementation(async () => {
      events.push('resources:cleaned');
      return true;
    });
    const transition = vi.fn(async () => {
      events.push('transition');
      h.sqlite!.prepare(
        `INSERT INTO sessions (id, status, created_at, updated_at)
           VALUES ('fresh', 'active', 2, 2)`,
      ).run();
      return 'fresh';
    });

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBe('fresh');
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalledWith('cc-local', {
      shouldContinue: expect.any(Function),
    });
    expect(transition).toHaveBeenCalledOnce();
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local')).toEqual({
      status: 'deleted',
    });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('fresh')).toEqual({
      status: 'active',
    });
    expect(events).toEqual([
      'lock:start',
      'lifecycle:prepared',
      'worktree:cleaned',
      'resources:cleaned',
      'transition',
      'lock:end',
    ]);
  });

  it('serializes different tombstone ids that share one logical IM lifecycle identity', async () => {
    h.sqlite!.prepare(
      `UPDATE sessions
         SET status = 'deleted', im_logical_session_id = ?, im_generation = 0
         WHERE id = ?`,
    ).run('logical-im', 'cc-local');
    h.sqlite!.prepare(
      `INSERT INTO sessions (
           id, status, im_logical_session_id, im_generation, created_at, updated_at
         ) VALUES (?, 'deleted', ?, 1, 2, 2)`,
    ).run('cc-local-next', 'logical-im');

    let releaseCleanup!: () => void;
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    h.cleanupDeletedSessionResources
      .mockImplementationOnce(async () => {
        markCleanupStarted();
        await cleanupGate;
        return true;
      })
      .mockResolvedValueOnce(true);

    const first = finalizeDeletedSessionLifecycle('cc-local');
    await cleanupStarted;
    const second = finalizeDeletedSessionLifecycle('cc-local-next');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.withCrossProcessLock).toHaveBeenCalledTimes(1);

    releaseCleanup();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(h.withCrossProcessLock).toHaveBeenCalledTimes(2);
    expect(h.withCrossProcessLock.mock.calls[0][0]).toBe(h.withCrossProcessLock.mock.calls[1][0]);
  });

  it('lets deletion win before overwrite import and exposes the stale CAS only afterward', async () => {
    const cleanupStarted = deferred<void>();
    const releaseCleanup = deferred<void>();
    h.cleanupDeletedSessionResources.mockImplementationOnce(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
      return true;
    });
    const deletion = invokeUpdate('cc-local', { status: 'deleted' });
    await cleanupStarted.promise;

    const commit = vi.fn(async () => {
      const row = h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local') as {
        status: string;
      };
      if (row.status !== 'active') {
        throw Object.assign(new Error('stale overwrite status'), { code: 'PRECONDITION_FAILED' });
      }
      return { value: 'fresh', deleted: null };
    });
    const imported = commitAndFinalizeSessionDeletion('cc-local', commit);
    await Promise.resolve();
    expect(commit).not.toHaveBeenCalled();

    releaseCleanup.resolve();
    await deletion;
    await expect(imported).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local')).toEqual({
      status: 'deleted',
    });
  });

  it('keeps deletion waiting for overwrite commit and never targets the new generation', async () => {
    const commitStarted = deferred<void>();
    const releaseCommit = deferred<void>();
    const commit = vi.fn(async () => {
      commitStarted.resolve();
      await releaseCommit.promise;
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'cc-local'").run();
      h.sqlite!.prepare(
        `INSERT INTO sessions
          (id, status, working_dir, workspace_kind, agent_kind, created_at, updated_at)
         VALUES ('fresh-import', 'active', '/fresh', 'dialogue', 'cc', 2, 2)`,
      ).run();
      return {
        value: 'fresh-import',
        deleted: {
          sessionId: 'cc-local',
          title: 'New CCS',
          workingDir: '/old/dir',
          workspaceKind: 'dialogue',
        },
      };
    });
    const imported = commitAndFinalizeSessionDeletion('cc-local', commit);
    await commitStarted.promise;

    let deletionSettled = false;
    const deletion = invokeUpdate('cc-local', { status: 'deleted' }).then(() => {
      deletionSettled = true;
    });
    await Promise.resolve();
    expect(deletionSettled).toBe(false);
    expect(
      h.sqlite!.prepare('SELECT id FROM sessions WHERE id = ?').get('fresh-import'),
    ).toBeUndefined();

    releaseCommit.resolve();
    await expect(imported).resolves.toBe('fresh-import');
    await deletion;
    expect(
      h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('fresh-import'),
    ).toEqual({
      status: 'active',
    });
  });

  it('does not start a fresh context when deleted cleanup stops early', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.cleanupDeletedSessionResources.mockResolvedValueOnce(false);
    const transition = vi.fn(async () => 'fresh');

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBeNull();
    expect(transition).not.toHaveBeenCalled();
  });

  it('fails closed before irreversible cleanup when durable relation preparation loses its CAS', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.prepareDeletedLifecycle.mockResolvedValueOnce(false);
    const transition = vi.fn(async () => 'fresh');

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBeNull();
    expect(h.prepareDeletedLifecycle).toHaveBeenCalledWith({
      sessionId: 'cc-local',
      now: expect.any(Number),
    });
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('fails closed when another process owns the deleted-session lifecycle lock', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.withCrossProcessLock.mockImplementationOnce(
      async (
        _path: string,
        _opts: unknown,
        run: (
          status: { held: true } | { held: false; reason: 'busy' | 'unavailable' },
        ) => Promise<unknown>,
      ) => run({ held: false, reason: 'busy' }),
    );
    const transition = vi.fn(async () => 'fresh');

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBeNull();
    expect(h.prepareDeletedLifecycle).not.toHaveBeenCalled();
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not commit deletion when the old runtime cannot be sealed', async () => {
    h.sealSession.mockRejectedValueOnce(new Error('still running'));

    await expect(invokeUpdate('cc-local', { status: 'deleted' })).rejects.toThrow('still running');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local')).toEqual({
      status: 'active',
    });
    expect(h.recycleWorktreeForRemovedSession).not.toHaveBeenCalled();
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
    expect(h.prepareDeletedLifecycle).not.toHaveBeenCalled();
  });

  it('rolls back the Maker deletion seal when the status commit fails', async () => {
    h.sqlite!.exec(`
      CREATE TRIGGER fail_deleted_status_update
      BEFORE UPDATE OF status ON sessions
      WHEN NEW.status = 'deleted'
      BEGIN
        SELECT RAISE(ABORT, 'status commit failed');
      END;
    `);

    await expect(invokeUpdate('cc-local', { status: 'deleted' })).rejects.toThrow(
      'status commit failed',
    );
    expect(h.sealSession).toHaveBeenCalledWith('cc-local');
    expect(h.unsealSession).toHaveBeenCalledWith('cc-local');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local')).toEqual({
      status: 'active',
    });
  });

  it('rolls back the Maker deletion seal when an overwrite commit fails', async () => {
    const commit = vi.fn(async () => {
      throw new Error('overwrite commit failed');
    });

    await expect(commitAndFinalizeSessionDeletion('cc-local', commit)).rejects.toThrow(
      'overwrite commit failed',
    );
    expect(h.sealSession).toHaveBeenCalledWith('cc-local');
    expect(h.unsealSession).toHaveBeenCalledWith('cc-local');
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local')).toEqual({
      status: 'active',
    });
  });

  it('continues resource cleanup but does not reactivate when worktree cleanup fails', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');
    h.recycleWorktreeForRemovedSession.mockRejectedValueOnce(new Error('git busy'));
    const transition = vi.fn(async () => 'fresh');

    await expect(withFinalizedDeletedSession('cc-local', transition)).resolves.toBeNull();
    expect(h.cleanupDeletedSessionResources).toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it('does not let the local update path revive a permanently deleted session', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-local');

    await expect(invokeUpdate('cc-local', { status: 'active' })).rejects.toThrow(
      '[PRECONDITION_FAILED]',
    );
    expect(
      (
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-local') as {
          status: string;
        }
      ).status,
    ).toBe('deleted');
    expect(h.cleanupDeletedSessionResources).not.toHaveBeenCalled();
  });

  it('does not let remote patch-meta revive a permanently deleted session', async () => {
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = ?").run('cc-remote');

    await expect(invokePatchMeta('cc-remote', { status: 'archived' })).rejects.toThrow(
      '[PRECONDITION_FAILED]',
    );
    expect(
      (
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get('cc-remote') as {
          status: string;
        }
      ).status,
    ).toBe('deleted');
    expect(h.tapWindowBroadcast).not.toHaveBeenCalledWith(
      'local-db:sessions:patched',
      expect.objectContaining({ sessionId: 'cc-remote' }),
    );
  });
});
