/**
 * main/im/shared/sessionRepo.ts
 * ---------------------------------------------------------------------------
 * IM 渠道的 sessions DB 层(渠道无关)。`sessions` 表与 desktop UI 会话共用
 * (见 localDb/schema.ts);按确定性 session id 查找/创建属于 (botContextId,
 * userId) 的会话行。渠道差异(id 格式 / source 列值 / 默认 title / workingDir
 * 策略 / 渠道专属列)收敛在 ImSessionNamespace, 由 adapter 注入。
 *
 * Manual INSERT (不走 maker 的 DesktopSessionStorage.create) — 为了预填渠道
 * 专属列。Maker 的 `createSession({ id })` 经 storage.get() 看到行已存在,
 * 只附加 SDK handle。
 */

import { and, desc, eq, or } from 'drizzle-orm';
import type { AgentKind, Effort, PermissionMode } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';

import { getDbClient } from '../../localDb/client/current';
import { normalizeDbAgentKind } from '../../../shared/agentKindConversion';
import { sessions } from '../../localDb/schema';
import { createLogger, maskPath } from '../../logger';
import { createBusinessSessionId } from '../../sessionIds';
import { setSessionEffort, setSessionFastMode } from '../../maker-host/session-effort-store';
import { setSessionProvider } from '../../maker-host/session-provider-store';
import { withFinalizedDeletedSession } from '../../localDb/ipc/sessions.js';
import { withSessionRouteLock } from '../../maker-ipc/sessionRouteLock.js';
import { bindingStore } from '../binding.js';
import {
  getImDefaultEffortFor,
  resolveImSessionDefaults,
  type ResolvedImSessionDefaults,
} from '../defaultSessionSettings';
import { broadcastSessionCreated } from './sessionBroadcast';
import type { ImOrchestratorConfig, ImSessionNamespace } from './types';

const log = createLogger('im:repo');

export function toCoreAgentKind(kind: string): AgentKind {
  return kind === 'codex' || kind === 'pi' ? kind : 'claude-code';
}

/** core AgentKind → sessions.agentKind 列的 legacy 存储值。 */
function toDbAgentKind(kind: AgentKind): string {
  return normalizeDbAgentKind(kind);
}

export interface ImSessionRow {
  id: string;
  agentKind: AgentKind;
  workingDir: string;
  model: string;
  /** Latest persisted effort (may be changed by user via /model card later). */
  effort: Effort;
  /** Latest persisted permission mode. */
  permissionMode: PermissionMode;
  fastMode: boolean;
  sdkSessionId: string | null;
  /**
   * 该会话显式选定的供应商 id(路由用,null = 跟随默认路由)。/model 卡片选行时一并持久化,
   * IM turn 启动前 hydrate 进 session-provider-store,保证按选中供应商路由。
   */
  providerId: string | null;
}

export interface SessionModelRouteSnapshot {
  model: string;
  effort: Effort;
  providerId: string | null;
}

/** 渠道维度的 session 查找/创建仓库 — per adapter 一个实例。 */
export interface ImSessionRepo {
  sessionIdFor(botContextId: string, userId: string, scopeKey?: string): string;
  findActiveSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<ImSessionRow | null>;
  prepareNewSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    providerSnapshot?: ProviderView[] | null,
  ): Promise<ImSessionRow>;
  createSession(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    prepared?: ImSessionRow,
  ): Promise<ImSessionRow>;
  /**
   * 该渠道语境下 model 的默认 effort:
   *   1. config.effortOverrides[modelId] — IM 产品决策
   *   2. ModelDescriptor.defaultEffort — agent 自身推荐
   *   3. 'high' — DB NOT NULL 兜底(到这说明上游有 bug)
   */
  getDefaultEffortFor(modelId: string, agentKind?: AgentKind): Effort;
}

export function createImSessionRepo(
  config: ImOrchestratorConfig,
  ns: ImSessionNamespace,
): ImSessionRepo {
  function defaultEffortFor(modelId: string, agentKind: AgentKind = config.agentKind): Effort {
    return getImDefaultEffortFor(agentKind, modelId, config.effortOverrides);
  }

  async function prepareSessionRow(
    botContextId: string,
    userId: string,
    scopeKey?: string,
    providerSnapshot?: ProviderView[] | null,
  ): Promise<ImSessionRow> {
    const id = ns.sessionIdFor(botContextId, userId, scopeKey);
    const workingDir = ns.ensureWorkingDir(botContextId);
    const row = rowFromDefaults(
      id,
      workingDir,
      await resolveImSessionDefaults(config, providerSnapshot, ns.source),
    );
    const tightened = ns.permissionModeFor?.(userId) ?? null;
    if (tightened) row.permissionMode = tightened;
    return row;
  }

  async function readSessionRow(id: string): Promise<typeof sessions.$inferSelect | null> {
    const rows = await getDbClient()
      .drizzle.select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async function readLatestLogicalSession(
    logicalSessionId: string,
  ): Promise<typeof sessions.$inferSelect | null> {
    const rows = await getDbClient()
      .drizzle.select()
      .from(sessions)
      .where(
        or(eq(sessions.imLogicalSessionId, logicalSessionId), eq(sessions.id, logicalSessionId)),
      )
      .orderBy(desc(sessions.imGeneration), desc(sessions.createdAt), desc(sessions.id))
      .limit(1);
    return rows[0] ?? null;
  }

  function toImSessionRow(
    row: typeof sessions.$inferSelect,
    fallbackWorkingDir: string,
  ): ImSessionRow {
    return {
      id: row.id,
      agentKind: toCoreAgentKind(row.agentKind),
      workingDir: row.workingDir ?? fallbackWorkingDir,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permissionMode,
      fastMode: row.fastMode,
      sdkSessionId: row.sdkSessionId,
      providerId: row.providerId ?? null,
    };
  }

  /**
   * Archived IM tasks resume their existing context. Deleted tasks are
   * permanent: finish old resource cleanup and close the old runtime first,
   * then publish a distinct session id for the next generation.
   */
  async function activatePersistedSession(
    row: typeof sessions.$inferSelect,
    botContextId: string,
    userId: string,
    scopeKey?: string,
  ): Promise<typeof sessions.$inferSelect | null> {
    if (row.status === 'active') return row;
    const db = getDbClient().drizzle;
    if (row.status === 'archived') {
      const refreshed = await withSessionRouteLock(row.id, async () => {
        const current = await readSessionRow(row.id);
        if (current?.status !== 'archived') return current;
        const restoredAt = Date.now();
        await db
          .update(sessions)
          .set({
            status: 'active',
            userSendAt: restoredAt,
            updatedAt: restoredAt,
            ...(ns.workspaceKind ? { workspaceKind: ns.workspaceKind } : {}),
          })
          .where(and(eq(sessions.id, row.id), eq(sessions.status, 'archived')));
        return readSessionRow(row.id);
      });
      if (refreshed?.status === 'active') {
        log.info(`revived archived ${ns.source} session id=${row.id}`);
        return refreshed;
      }
      if (refreshed?.status === 'deleted') {
        return activatePersistedSession(refreshed, botContextId, userId, scopeKey);
      }
      return null;
    }
    if (row.status !== 'deleted') return null;

    const logicalSessionId = ns.sessionIdFor(botContextId, userId, scopeKey);
    const prepared = await prepareSessionRow(botContextId, userId, scopeKey);
    const refreshed = await withFinalizedDeletedSession(row.id, async () => {
      const latest = await readLatestLogicalSession(logicalSessionId);
      if (latest?.id !== row.id) return latest?.status === 'deleted' ? null : latest;

      // Emit the local detach event before the transaction removes persisted
      // bindings. Other processes validate their cached binding against SQLite
      // before routing, so they also fail closed on this generation boundary.
      const identity = bindingStore.findByTarget(row.id);
      if (identity && !(await bindingStore.detachIfTarget(identity, row.id))) return null;

      const extra = ns.extraInsertColumns(botContextId, userId);
      const stringOrNull = (key: string): string | null =>
        typeof extra[key] === 'string' ? (extra[key] as string) : null;
      const generation = row.imGeneration + 1;
      const now = Math.max(Date.now(), row.createdAt + 1, row.updatedAt + 1);
      // Physical session ids are opaque storage/protocol keys. Keep the logical
      // IM identity exclusively in imLogicalSessionId so savepoint refs and
      // xdt-image URLs retain their safe, bounded id contract.
      const newSessionId = createBusinessSessionId();
      const activatedId = await getDbClient().tx('session.replaceDeletedGeneration', {
        oldSessionId: row.id,
        newSessionId,
        logicalSessionId,
        generation,
        title: ns.defaultTitle(userId),
        workingDir: prepared.workingDir,
        workspaceKind: ns.workspaceKind ?? 'project',
        model: prepared.model,
        effort: prepared.effort,
        permissionMode: prepared.permissionMode,
        providerId: prepared.providerId,
        fastMode: prepared.fastMode,
        agentKind: toDbAgentKind(prepared.agentKind),
        source: ns.source,
        feishuOpenId: stringOrNull('feishuOpenId'),
        feishuBotAppId: stringOrNull('feishuBotAppId'),
        imBotContextId: stringOrNull('imBotContextId'),
        imUserId: stringOrNull('imUserId'),
        now,
      });
      return activatedId ? readSessionRow(activatedId) : null;
    });
    if (refreshed?.status === 'active') {
      setSessionProvider(refreshed.id, refreshed.providerId ?? null);
      setSessionEffort(refreshed.id, refreshed.effort);
      setSessionFastMode(refreshed.id, refreshed.fastMode);
      log.info(
        `started fresh ${ns.source} session after permanent deletion ` +
          `oldId=${row.id} newId=${refreshed.id}`,
      );
      return refreshed;
    }
    return null;
  }

  return {
    sessionIdFor: (botContextId, userId, scopeKey) =>
      ns.sessionIdFor(botContextId, userId, scopeKey),
    getDefaultEffortFor: defaultEffortFor,

    /**
     * 查 (botContextId, userId, scopeKey) 的最新逻辑 generation。无行返回 null。
     *
     * archived 行保留 sdkSessionId 原地恢复。deleted 是永久删除,不能恢复旧上下文;
     * 完成旧资源清理并关闭旧 runtime 后，用新真实 id 插入下一代。旧行与旧消息
     * 永久留在 deleted 墓碑下，不依赖 clearedAt 隔离上下文。
     */
    async findActiveSession(botContextId, userId, scopeKey) {
      const logicalSessionId = ns.sessionIdFor(botContextId, userId, scopeKey);
      const row = await readLatestLogicalSession(logicalSessionId);
      if (!row) return null;
      const active = await activatePersistedSession(row, botContextId, userId, scopeKey);
      if (!active) return null;
      if (row.status !== 'active') {
        // 软删行已从 sidebar 消失,patched 增量对不存在的行无效;
        // created 触发 renderer 重拉列表,让会话重新出现。
        broadcastSessionCreated(active.id);
      }
      return toImSessionRow(active, ns.ensureWorkingDir(botContextId));
    },

    async prepareNewSession(botContextId, userId, scopeKey, providerSnapshot) {
      return prepareSessionRow(botContextId, userId, scopeKey, providerSnapshot);
    },

    /**
     * 首代用确定性 logical id 新建会话行。caller 随后 `maker.createSession({ id })` —
     * Maker 复用已有行(SDK 分配 sdkSessionId 后回写)。
     *
     * INSERT OR IGNORE 兜 find/create 竞态。冲突后按 logical id 回读并走上面的状态机:
     * active 复用、archived 恢复、deleted 清理后重开,绝不直接复活 deleted。
     */
    async createSession(botContextId, userId, scopeKey, prepared) {
      const db = getDbClient().drizzle;
      const row = prepared ?? (await this.prepareNewSession(botContextId, userId, scopeKey));
      const logicalSessionId = ns.sessionIdFor(botContextId, userId, scopeKey);
      const now = Date.now();
      await db
        .insert(sessions)
        .values({
          id: row.id,
          title: ns.defaultTitle(userId),
          ...(ns.workspaceKind ? { workspaceKind: ns.workspaceKind } : {}),
          workingDir: row.workingDir,
          model: row.model,
          effort: row.effort,
          permissionMode: row.permissionMode,
          fastMode: row.fastMode,
          status: 'active',
          agentKind: toDbAgentKind(row.agentKind),
          providerId: row.providerId,
          source: ns.source,
          imLogicalSessionId: logicalSessionId,
          imGeneration: 0,
          ...ns.extraInsertColumns(botContextId, userId),
          createdAt: now,
          updatedAt: now,
          // IM 会话由用户消息触发创建,插入时即设 userSendAt,
          // 避免广播后 renderer 重拉到 userSendAt=null 的行被误判为草稿。
          userSendAt: now,
        })
        .onConflictDoNothing();
      const existing = await readLatestLogicalSession(logicalSessionId);
      const persisted = existing
        ? await activatePersistedSession(existing, botContextId, userId, scopeKey)
        : null;
      if (existing && !persisted) {
        throw new Error(
          `Failed to activate persisted ${ns.source} session id=${row.id} status=${existing.status}`,
        );
      }
      const result: ImSessionRow = persisted ? toImSessionRow(persisted, row.workingDir) : row;
      log.info(
        `created ${ns.source} session id=${result.id} workingDir=${maskPath(result.workingDir)} ` +
          `agent=${result.agentKind} model=${result.model} effort=${result.effort} ` +
          `provider=${result.providerId ?? 'default'} permissionMode=${result.permissionMode}`,
      );
      // 通知 renderer sidebar / device-link 控制端有新会话行,否则要手动刷新才出现
      broadcastSessionCreated(result.id);
      return result;
    },
  };
}

function rowFromDefaults(
  id: string,
  workingDir: string,
  defaults: ResolvedImSessionDefaults,
): ImSessionRow {
  return {
    id,
    agentKind: defaults.agentKind,
    workingDir,
    model: defaults.model,
    effort: defaults.effort,
    permissionMode: defaults.permissionMode,
    fastMode: defaults.fastMode,
    sdkSessionId: null,
    providerId: defaults.providerId,
  };
}

// ── sessionId 维度的更新操作(渠道无关, 无需工厂) ─────────────────────────────

/** Bump userSendAt so sidebar (if ever surfaced) sorts IM sessions correctly. */
export async function touchUserSent(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  const now = Date.now();
  await db
    .update(sessions)
    .set({ userSendAt: now, updatedAt: now })
    .where(eq(sessions.id, sessionId));
}

/**
 * `/new` semantic: clear the conversation context but keep the session row.
 *
 * Implementation: null out `sdkSessionId` so the next `maker.createSession`
 * for this id starts a fresh SDK conversation thread (no resume). Caller is
 * responsible for disposing the in-process maker session (so the stale
 * conversation isn't reused) and removing it from sessionStates.
 */
export async function clearContext(sessionId: string): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ sdkSessionId: null, clearedAt: Date.now(), updatedAt: Date.now() })
    .where(eq(sessions.id, sessionId));
}

/**
 * `/new` 语义:保留同一个 IM 会话行,但按当前渠道的 IM 默认重新开始一条新对话。
 *
 * 这会同时重置 agent/model/effort/provider/permission/fast 和 sdkSessionId。也就是说
 * 用户把飞书默认从 Claude Code 改成 Codex 后,在飞书里执行 `/new` 会按 Codex 开始，
 * 不影响 Discord 的下一条新会话。
 */
export async function resetSessionToDefaults(
  sessionId: string,
  config: ImOrchestratorConfig,
  prepared?: ImSessionRow,
  channel?: ImSessionNamespace['source'],
): Promise<void> {
  const defaults =
    prepared ??
    rowFromDefaults(sessionId, '', await resolveImSessionDefaults(config, undefined, channel));
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      agentKind: toDbAgentKind(defaults.agentKind),
      model: defaults.model,
      effort: defaults.effort,
      providerId: defaults.providerId,
      permissionMode: defaults.permissionMode,
      fastMode: defaults.fastMode,
      // Personal WeChat exposes a user-selected channel working directory.
      // It applies only at the explicit `/new` boundary; existing context is
      // never moved silently.
      ...(channel === 'wechat' && defaults.workingDir ? { workingDir: defaults.workingDir } : {}),
      sdkSessionId: null,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
  setSessionProvider(sessionId, defaults.providerId);
}

/**
 * `/project` 语义: 把该 IM 会话行切到指定工作目录并重开上下文(sdkSessionId
 * 归零)。模型/权限/供应商等设置保留 — 换目录不该顺手改路由。workspaceKind
 * 随目录性质切换: 项目目录落 'project'(sidebar 按项目归组), 托管对话目录落
 * 'dialogue'。广播 created 让 sidebar 重拉 — 行会跨分组移动, patched 增量
 * 覆盖不了归组变化。
 */
export async function switchSessionWorkingDir(
  sessionId: string,
  workingDir: string,
  workspaceKind: 'project' | 'dialogue',
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      workingDir,
      workspaceKind,
      sdkSessionId: null,
      clearedAt: Date.now(),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
  broadcastSessionCreated(sessionId);
}

/** 读取 `/model` 修改前的持久化路由快照，用于失败时恢复运行态。 */
export async function readModelRouteSnapshot(
  sessionId: string,
): Promise<SessionModelRouteSnapshot | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      model: sessions.model,
      effort: sessions.effort,
      providerId: sessions.providerId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    model: row.model,
    effort: row.effort as Effort,
    providerId: row.providerId ?? null,
  };
}

/**
 * Update model/effort columns (for /model picker)。
 *
 * `providerId` 可选,语义对齐 renderer 的 SET_MODEL 路径:
 *   - undefined → 不动 providerId 列(老调用兼容);
 *   - string    → 显式选定该供应商(路由按它走);
 *   - null      → 清除显式选择,回落默认路由。
 * 显式传入(含 null)时一并写列,使 IM 选模型与应用内一样能锁定路由源、跨重启 hydrate 仍生效。
 */
export async function updateModelEffort(
  sessionId: string,
  model: string,
  effort: Effort,
  providerId?: string | null,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({
      model,
      effort,
      ...(providerId !== undefined ? { providerId } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(sessions.id, sessionId));
}

/** Update permissionMode column (for /permission picker). */
export async function updatePermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ permissionMode: mode, updatedAt: Date.now() })
    .where(eq(sessions.id, sessionId));
}

/** 读取 /permission 切换前的持久化权限；非法历史值按 ask 处理。 */
export async function readPermissionMode(sessionId: string): Promise<PermissionMode | null> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ permissionMode: sessions.permissionMode })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0] ? permissionModeOrAsk(rows[0].permissionMode) : null;
}
