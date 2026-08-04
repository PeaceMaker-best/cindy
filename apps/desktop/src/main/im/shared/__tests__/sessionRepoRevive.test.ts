/**
 * 回归 #748:飞书/Slack 等 IM 渠道用确定性 logical session id,
 * 该行被桌面端归档/删除(行仍在库里)后,用户从 IM 侧继续发消息曾走
 * "findActiveSession 返 null → 同 id INSERT" 撞 UNIQUE(sessions.id),之后每条
 * 消息都稳定报错。修复:
 *   - archived 原地恢复并保留上下文;
 *   - deleted 先完成资源清理、关闭旧 runtime,再以新真实 id 插入下一代;
 *   - createSession 的 INSERT OR IGNORE 后统一回读同一状态机。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn(async (_where: unknown) => {});
  const updateSet = vi.fn((_set: unknown) => ({ where: updateWhere }));
  const insertConflict = vi.fn(async (_conflict: unknown) => {});
  const insertValues = vi.fn((_values: unknown) => ({ onConflictDoNothing: insertConflict }));
  const selectLimit = vi.fn(async (): Promise<unknown[]> => []);
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateSet,
    updateWhere,
    insertConflict,
    insertValues,
    selectLimit,
    withFinalizedDeletedSession: vi.fn(
      async (_sessionId: string, transition: () => Promise<unknown>) => transition(),
    ),
    setSessionProvider: vi.fn(),
    setSessionEffort: vi.fn(),
    setSessionFastMode: vi.fn(),
    tx: vi.fn(async (..._args: unknown[]) => 'fresh-generation'),
    bindingFindByTarget: vi.fn(() => null),
    bindingDetachIfTarget: vi.fn(async () => true),
    withSessionRouteLock: vi.fn(async (_sessionId: string, task: () => Promise<unknown>) => task()),
    webContentsSend: vi.fn(),
    tapWindowBroadcast: vi.fn(),
  };
});

// 用轻量 eq 替身让断言能直接核对 WHERE 的列与值(真 eq 返回不可比对的 SQL 对象)
vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  desc: (col: unknown) => ({ desc: col }),
  eq: (col: unknown, val: unknown) => ({ col, val }),
  or: (...conditions: unknown[]) => ({ or: conditions }),
}));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send: mocks.webContentsSend } },
    ],
  },
}));
vi.mock('../../../device-link/broadcast-tap', () => ({
  tapWindowBroadcast: mocks.tapWindowBroadcast,
}));
vi.mock('../../../logger', () => ({
  createLogger: () => mocks.logger,
  maskPath: (p: string) => p,
}));
vi.mock('../../../localDb/client/current', () => ({
  getDbClient: () => ({
    tx: mocks.tx,
    drizzle: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: mocks.selectLimit,
            orderBy: () => ({ limit: mocks.selectLimit }),
          }),
        }),
      }),
      update: () => ({ set: mocks.updateSet }),
      insert: () => ({ values: mocks.insertValues }),
    },
  }),
}));
vi.mock('../../../localDb/schema', () => ({
  sessions: {
    id: 'sessions.id',
    status: 'sessions.status',
    imLogicalSessionId: 'sessions.imLogicalSessionId',
    imGeneration: 'sessions.imGeneration',
    createdAt: 'sessions.createdAt',
  },
}));
vi.mock('../../../sessionIds', () => ({
  createBusinessSessionId: () => 'fresh-generation',
}));
vi.mock('../../../maker-host/session-provider-store', () => ({
  setSessionProvider: mocks.setSessionProvider,
}));
vi.mock('../../../maker-host/session-effort-store', () => ({
  setSessionEffort: mocks.setSessionEffort,
  setSessionFastMode: mocks.setSessionFastMode,
}));
vi.mock('../../../localDb/ipc/sessions', () => ({
  withFinalizedDeletedSession: mocks.withFinalizedDeletedSession,
}));
vi.mock('../../../maker-ipc/register', () => ({
  withSessionRouteLock: mocks.withSessionRouteLock,
}));
vi.mock('../../../maker-ipc/sessionRouteLock', () => ({
  withSessionRouteLock: mocks.withSessionRouteLock,
}));
vi.mock('../../binding', () => ({
  bindingStore: {
    findByTarget: mocks.bindingFindByTarget,
    detachIfTarget: mocks.bindingDetachIfTarget,
  },
}));
vi.mock('../../defaultSessionSettings', () => ({
  getImDefaultEffortFor: vi.fn(() => 'high'),
  resolveImSessionDefaults: vi.fn(async () => ({
    agentKind: 'claude-code',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    providerId: null,
  })),
}));

import { createImSessionRepo, type ImSessionRow } from '../sessionRepo';
import type { ImOrchestratorConfig, ImSessionNamespace } from '../types';

const ns: ImSessionNamespace = {
  source: 'feishu',
  sessionIdFor: (bot: string, user: string) => `feishu_${bot}_${user}`,
  defaultTitle: () => '飞书',
  ensureWorkingDir: () => '/tmp/im-working-dir/bot',
  extraInsertColumns: (bot: string, user: string) => ({
    feishuBotAppId: bot,
    feishuOpenId: user,
  }),
} as unknown as ImSessionNamespace;

function dbRow(status: 'active' | 'archived' | 'deleted') {
  return {
    id: 'feishu_bot_user',
    status,
    agentKind: 'cc',
    workingDir: '/tmp/im-working-dir/bot',
    model: 'claude-opus-4-8',
    effort: 'high',
    permissionMode: 'auto',
    fastMode: false,
    sdkSessionId: 'sdk-ctx-1',
    providerId: null,
    imLogicalSessionId: 'feishu_bot_user',
    imGeneration: 0,
    createdAt: 100,
    updatedAt: 200,
  };
}

function freshDbRow() {
  return {
    ...dbRow('active'),
    id: 'fresh-generation',
    sdkSessionId: null,
    imGeneration: 1,
    createdAt: 201,
    updatedAt: 201,
  };
}

function makeRepo() {
  return createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, ns);
}

describe('sessionRepo.findActiveSession 状态恢复(#748)', () => {
  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.updateWhere.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.webContentsSend.mockClear();
    mocks.tapWindowBroadcast.mockClear();
    mocks.withFinalizedDeletedSession.mockClear();
    mocks.withFinalizedDeletedSession.mockImplementation(
      async (_sessionId: string, transition: () => Promise<unknown>) => transition(),
    );
    mocks.setSessionProvider.mockClear();
    mocks.setSessionEffort.mockClear();
    mocks.setSessionFastMode.mockClear();
    mocks.tx.mockClear();
    mocks.tx.mockResolvedValue('fresh-generation');
    mocks.bindingFindByTarget.mockReset();
    mocks.bindingFindByTarget.mockReturnValue(null);
    mocks.bindingDetachIfTarget.mockClear();
    mocks.bindingDetachIfTarget.mockResolvedValue(true);
    mocks.withSessionRouteLock.mockClear();
    mocks.withSessionRouteLock.mockImplementation(
      async (_sessionId: string, task: () => Promise<unknown>) => task(),
    );
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('archived 残留行恢复 active 并保留 sdkSessionId 上下文', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([dbRow('archived')])
      .mockResolvedValueOnce([dbRow('archived')])
      .mockResolvedValueOnce([dbRow('active')]);

    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toMatchObject({ id: 'feishu_bot_user', sdkSessionId: 'sdk-ctx-1' });
    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', userSendAt: expect.any(Number) }),
    );
    const setArg = mocks.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('sdkSessionId');
    expect(setArg).not.toHaveProperty('model');
    expect(mocks.withFinalizedDeletedSession).not.toHaveBeenCalled();
    expect(mocks.withSessionRouteLock).toHaveBeenCalledWith(
      'feishu_bot_user',
      expect.any(Function),
    );
  });

  it('archived 恢复 CAS 输给并发删除时转入 deleted 全新上下文流程', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([dbRow('archived')])
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([freshDbRow()]);

    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toMatchObject({
      id: 'fresh-generation',
      sdkSessionId: null,
    });
    expect(mocks.withFinalizedDeletedSession).toHaveBeenCalledWith(
      'feishu_bot_user',
      expect.any(Function),
    );
  });

  it('deleted 残留行先清理旧资源和 runtime，再按默认值开启全新上下文', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([freshDbRow()]);

    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toMatchObject({
      id: 'fresh-generation',
      sdkSessionId: null,
    });
    expect(mocks.withFinalizedDeletedSession).toHaveBeenCalledWith(
      'feishu_bot_user',
      expect.any(Function),
    );
    expect(mocks.tx).toHaveBeenCalledWith(
      'session.replaceDeletedGeneration',
      expect.objectContaining({
        oldSessionId: 'feishu_bot_user',
        newSessionId: 'fresh-generation',
        logicalSessionId: 'feishu_bot_user',
        generation: 1,
        model: 'claude-opus-4-8',
        permissionMode: 'auto',
        feishuBotAppId: 'bot',
        feishuOpenId: 'user',
        now: expect.any(Number),
      }),
    );
    const replaceArgs = mocks.tx.mock.calls[0][1] as { newSessionId: string };
    expect(replaceArgs.newSessionId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    const imageUrl = new URL(`xdt-image://${replaceArgs.newSessionId}/file.bin`);
    expect(imageUrl.hostname).toBe(replaceArgs.newSessionId);
    expect(imageUrl.pathname).toBe('/file.bin');
    expect(mocks.setSessionProvider).toHaveBeenCalledWith('fresh-generation', null);
    expect(mocks.setSessionEffort).toHaveBeenCalledWith('fresh-generation', 'high');
    expect(mocks.setSessionFastMode).toHaveBeenCalledWith('fresh-generation', false);
    expect(mocks.webContentsSend).toHaveBeenCalledWith('local-db:sessions:created', {
      sessionId: 'fresh-generation',
    });
  });

  it('active 行直接返回,不发 update 不广播', async () => {
    mocks.selectLimit.mockResolvedValue([dbRow('active')]);
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).not.toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
    expect(mocks.webContentsSend).not.toHaveBeenCalled();
  });

  it('无行返回 null,不发 update', async () => {
    const row = await makeRepo().findActiveSession('bot', 'user');

    expect(row).toBeNull();
    expect(mocks.updateSet).not.toHaveBeenCalled();
  });
});

const preparedDefaults: ImSessionRow = {
  id: 'feishu_bot_user',
  agentKind: 'claude-code',
  workingDir: '/tmp/im-working-dir/bot',
  model: 'claude-opus-4-8',
  effort: 'high',
  permissionMode: 'auto',
  fastMode: false,
  sdkSessionId: null,
  providerId: null,
};

describe('sessionRepo.createSession 冲突兜底(#748)', () => {
  beforeEach(() => {
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.withFinalizedDeletedSession.mockClear();
    mocks.withFinalizedDeletedSession.mockImplementation(
      async (_sessionId: string, transition: () => Promise<unknown>) => transition(),
    );
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('INSERT 使用 onConflictDoNothing，冲突状态统一交给回读状态机', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(mocks.insertValues).toHaveBeenCalledTimes(1);
    expect(mocks.insertConflict).toHaveBeenCalledTimes(1);
    expect(mocks.insertConflict).toHaveBeenCalledWith();
  });

  it('冲突后以 DB 持久化行为准返回:active 行的上下文/设置不被 defaults 顶掉', async () => {
    mocks.selectLimit.mockResolvedValue([
      { ...dbRow('active'), model: 'old-model', effort: 'low', sdkSessionId: 'sdk-ctx-1' },
    ]);
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result.sdkSessionId).toBe('sdk-ctx-1');
    expect(result.model).toBe('old-model');
    expect(result.effort).toBe('low');
    expect(result.agentKind).toBe('claude-code');
  });

  it('冲突命中 deleted 行时也走清理后全新上下文，不直接复活', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([dbRow('deleted')])
      .mockResolvedValueOnce([freshDbRow()]);

    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result.sdkSessionId).toBeNull();
    expect(result.id).toBe('fresh-generation');
    expect(mocks.withFinalizedDeletedSession).toHaveBeenCalledWith(
      'feishu_bot_user',
      expect.any(Function),
    );
  });

  it('冲突命中 deleted 行但清理未完成时抛错，不用 prepared row 创建 runtime', async () => {
    mocks.selectLimit.mockResolvedValueOnce([dbRow('deleted')]);
    mocks.withFinalizedDeletedSession.mockResolvedValueOnce(null);

    await expect(
      makeRepo().createSession('bot', 'user', undefined, preparedDefaults),
    ).rejects.toThrow('Failed to activate persisted feishu session');
  });

  it('回读为空(极端竞态行被删)时回落 prepared defaults,不抛错', async () => {
    const result = await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    expect(result).toEqual(preparedDefaults);
  });
});

describe('sessionRepo workspaceKind(渠道声明 dialogue 归组时)', () => {
  const dialogueNs = { ...ns, workspaceKind: 'dialogue' } as unknown as ImSessionNamespace;

  function makeDialogueRepo() {
    return createImSessionRepo({ agentKind: 'claude-code' } as ImOrchestratorConfig, dialogueNs);
  }

  beforeEach(() => {
    mocks.updateSet.mockClear();
    mocks.insertValues.mockClear();
    mocks.insertConflict.mockClear();
    mocks.selectLimit.mockReset();
    mocks.selectLimit.mockResolvedValue([]);
  });

  it('INSERT values 落 workspaceKind=dialogue', async () => {
    await makeDialogueRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values.workspaceKind).toBe('dialogue');
  });

  it('软删行复活时一并校正 workspaceKind', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([dbRow('archived')])
      .mockResolvedValueOnce([dbRow('archived')])
      .mockResolvedValueOnce([{ ...dbRow('active'), workspaceKind: 'dialogue' }]);
    await makeDialogueRepo().findActiveSession('bot', 'user');

    expect(mocks.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', workspaceKind: 'dialogue' }),
    );
  });

  it('渠道未声明 workspaceKind 时不写该列(保持默认 project 语义)', async () => {
    await makeRepo().createSession('bot', 'user', undefined, preparedDefaults);

    const values = mocks.insertValues.mock.calls[0][0] as Record<string, unknown>;
    expect(values).not.toHaveProperty('workspaceKind');
  });
});
