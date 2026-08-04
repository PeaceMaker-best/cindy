/**
 * F-COLLAB:启动时幂等修复被中途打断的「关闭协同」遗留的悬空 orca 状态。
 *
 * 背景:关闭协同的唯一入口 `disableOrcaInternal` 是一段**非原子**的多步串行 DB 写
 * (`markTeamEnded` → `markWorkersStatusByTeam` → `archiveWorkersByTeam` →
 * `setSessionOrcaRole(null)`)。如果进程在中途退出 / 崩溃,会留下两类悬空态:
 *
 *  1. **悬空 Lead**:team 已非 active,但 Lead 的 `orca_role` 还停在 `'lead'`。renderer 的
 *     `collabEnabled` 只看 `orca_role`(见 `CCAgentSessionView.tsx`),会把会话永久困在空的
 *     split view(「等待 Worker」);再点 X 关闭又会在 `disableOrcaInternal` 的「no active team」
 *     早返回里 no-op —— 坏态自锁。
 *  2. **孤儿 Worker**:若打断发生在 `archiveWorkersByTeam` 之前,team 已非 active 但 worker
 *     session 仍停在 `status='active'` + `orca_role='worker'` —— 既被 sidebar 的 worker 过滤
 *     隐藏,又因为 `listWorkersByLead` 只看 active team 而无法触达,成为永远收不回来的孤儿。
 *
 * 这里在每次启动 `ensureReady` 时用一个事务做幂等兜底:
 *  - 归档「属于非 active team」且尚未归档的 worker session(`orca_role` 保留 `'worker'` 作历史)。
 *  - 把非 active team 的 `orca_workers` 收敛 `'done'`(对齐 `markWorkersStatusByTeam`)。
 *  - 清掉「`orca_role='lead'` 且无 active team」的悬空 Lead。
 * 三者都只命中非 active team;有 active team 的健康协同会话原样保留。幂等:已收敛的行不会再被
 * 命中,重复跑是 no-op。跑挂了不阻塞启动,只 log。
 *
 * 注意:本进程内通过 UI / MCP 关闭协同的**实时**修复由 `disableOrcaInternal` 自身完成(其
 * 「no active team」分支会 reconcile 悬空 lead + 孤儿 worker);本 sweep 负责「上一次会话遗留、
 * 本次启动前就已经悬空」的历史坏态。
 */

import type Database from 'better-sqlite3';
import type { DbClient } from './client/DbClient.js';

import { createLogger } from '../logger';
import { withSessionLifecycleLocks } from '../sessionLifecycleLock.js';
import { getDbClient } from './client/current.js';

const log = createLogger('orca-stranded-lead-reconcile');

/**
 * 启动早期同步执行的 metadata cleanup。在 `ensureReady` 的 runMigrations + schemaDriftRepair
 * + cleanupStaleOrcaLeadIndex 之后调用(此时 schema 已是 HEAD,`orca_teams` / `orca_workers`
 * 表一定存在)。这里故意不写 `sessions.status`:DbClient 尚未 takeover,无法与删除生命周期锁
 * 协同；需要归档的 session 由 `reconcileStrandedOrcaSessions` 在 DbClient ready 后补齐。
 * 不抛错 —— 任何异常都吞掉记日志,不让兜底修复把启动卡死。
 */
export function reconcileStrandedOrcaLeads(db: Database.Database): void {
  try {
    const run = db.transaction(() => {
      // 1) 把非 active team 的 orca_workers 收敛 done(对齐 markWorkersStatusByTeam)。
      const doneWorkers = db
        .prepare(
          `UPDATE orca_workers SET status = 'done'
           WHERE status != 'done'
             AND team_id IN (SELECT id FROM orca_teams WHERE status != 'active')`,
        )
        .run().changes;

      // 2) 清掉「orca_role='lead' 且无 active team」的悬空 Lead。
      const clearedLeads = db
        .prepare(
          `UPDATE sessions SET orca_role = NULL
           WHERE orca_role = 'lead'
             AND id NOT IN (
               SELECT lead_session_id FROM orca_teams WHERE status = 'active'
             )`,
        )
        .run().changes;

      return { doneWorkers, clearedLeads };
    });

    const res = run();
    if (res.doneWorkers > 0 || res.clearedLeads > 0) {
      log.warn(
        JSON.stringify({
          event: 'localDb.reconcile.strandedOrcaState.cleared',
          ...res,
          reason:
            'an interrupted disableOrcaInternal left a stranded lead and/or orphaned workers from a non-active team; reconciled to a clean state',
        }),
      );
    }
  } catch (err) {
    log.warn(
      JSON.stringify({
        event: 'localDb.reconcile.strandedOrcaState.failed',
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * DbClient takeover 后的 session-status reconcile。每个 lead 的 worker session 集合先稳定
 * 读取，再按逻辑 session lifecycle lock 串行化；事务内再次校验 team/status，并只更新这次
 * snapshot 命中的行。这样启动 sweep 不会在账号切换或 deleted finalizer 期间复活/误归档 session。
 */
export async function reconcileStrandedOrcaSessions(options?: {
  /** Capture the startup owner DbClient so an account switch cannot redirect writes. */
  dbClient?: DbClient;
  /** Return false when the startup owner/account boundary is no longer current. */
  canContinue?: () => boolean;
}): Promise<{ archivedWorkerSessions: number; stopped: boolean }> {
  const canContinue = options?.canContinue ?? (() => true);
  if (!canContinue()) return { archivedWorkerSessions: 0, stopped: true };
  const client = options?.dbClient ?? getDbClient();
  if (!canContinue()) return { archivedWorkerSessions: 0, stopped: true };
  const rows = await client.query<{ leadSessionId: string; sessionId: string }>(
    `SELECT DISTINCT ot.lead_session_id AS leadSessionId, ow.session_id AS sessionId
     FROM orca_workers AS ow
     INNER JOIN orca_teams AS ot ON ot.id = ow.team_id
     WHERE ot.status != 'active'
     ORDER BY ot.lead_session_id, ow.session_id`,
  );
  if (!canContinue()) return { archivedWorkerSessions: 0, stopped: true };
  const byLead = new Map<string, string[]>();
  for (const row of rows) {
    const ids = byLead.get(row.leadSessionId) ?? [];
    if (!ids.includes(row.sessionId)) ids.push(row.sessionId);
    byLead.set(row.leadSessionId, ids);
  }

  let archivedWorkerSessions = 0;
  for (const [leadSessionId, sessionIds] of byLead) {
    if (!canContinue()) return { archivedWorkerSessions, stopped: true };
    const locked = await withSessionLifecycleLocks(sessionIds, async () =>
      canContinue()
        ? client.tx('orca.reconcileInactiveTeamWorkersForLead', {
            leadSessionId,
            sessionIds,
            now: Date.now(),
          })
        : null,
    );
    if (!canContinue()) return { archivedWorkerSessions, stopped: true };
    if (!locked.acquired) {
      log.warn('stranded Orca session reconcile skipped because lifecycle locks were unavailable', {
        leadSessionId,
        sessionIds,
        reason: locked.reason,
      });
      continue;
    }
    if (locked.value) archivedWorkerSessions += locked.value.length;
  }
  return { archivedWorkerSessions, stopped: false };
}
