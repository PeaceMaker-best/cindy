import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ client: null as any }));

// createLogger 的输出最终走 emit()（文件写入 / dev terminal 流），测试环境不经过 console.warn,
// 所以直接 mock 掉 logger,让 reconcile 内部的 warn 成为 no-op（既消除 vitest 输出噪声,也避免
// 误以为 spy console.warn 能拦住它）。
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../sessionLifecycleLock', () => ({
  withSessionLifecycleLocks: async (
    sessionIds: string[],
    run: (identities: unknown[]) => Promise<unknown>,
  ) => ({
    acquired: true,
    identity: {
      requestedSessionId: sessionIds[0] ?? '',
      logicalSessionId: sessionIds[0] ?? '',
    },
    value: await run(
      sessionIds.map((sessionId) => ({ requestedSessionId: sessionId, logicalSessionId: sessionId })),
    ),
  }),
}));
vi.mock('../localDb/client/current', () => ({
  getDbClient: () => h.client,
}));

import { reconcileStrandedOrcaLeads } from '../localDb/orcaStrandedLeadReconcile';
import { reconcileStrandedOrcaSessions } from '../localDb/orcaStrandedLeadReconcile';

// Minimum surface of better-sqlite3 Database we touch: a synchronous transaction wrapper
// plus prepare().run() returning { changes }. Mocking avoids loading the native module under
// vitest (Electron-ABI bound), mirroring orcaStaleIndexCleanup.test.ts.
function makeDb(opts: { changesBySql?: (sql: string) => number; throwOnRun?: boolean }) {
  const runSqls: string[] = [];
  const db = {
    transaction: (fn: () => unknown) => () => fn(),
    prepare: (sql: string) => ({
      run: () => {
        runSqls.push(sql);
        if (opts.throwOnRun) throw new Error('boom');
        return { changes: opts.changesBySql ? opts.changesBySql(sql) : 0 };
      },
    }),
  };
  return { db: db as unknown as import('better-sqlite3').Database, runSqls };
}

describe('reconcileStrandedOrcaLeads', () => {
  it('runs metadata-only reconcile statements, each scoped to NON-active teams only', () => {
    const { db, runSqls } = makeDb({ changesBySql: () => 1 });
    reconcileStrandedOrcaLeads(db);

    expect(runSqls).toHaveLength(2);
    const [doneWorkers, clearLeads] = runSqls;

    // 1) converge orca_workers to done: only not-yet-done rows, scoped to non-active teams.
    //    (Pin the team-scope predicate explicitly via its `orca_teams` subquery so it can't be
    //    confused with the orca_workers `status != 'done'` guard.)
    expect(doneWorkers).toContain("UPDATE orca_workers SET status = 'done'");
    expect(doneWorkers).toContain("status != 'done'");
    expect(doneWorkers).toContain("orca_teams WHERE status != 'active'");

    // 2) clear stranded leads (lead role + no active team)
    expect(clearLeads).toContain('UPDATE sessions SET orca_role = NULL');
    expect(clearLeads).toContain("orca_role = 'lead'");
    expect(clearLeads).toContain('NOT IN');
    expect(clearLeads).toContain("SELECT lead_session_id FROM orca_teams WHERE status = 'active'");
  });

  it('still runs the idempotent statements when nothing is stranded (changes=0, no throw)', () => {
    const { db, runSqls } = makeDb({ changesBySql: () => 0 });
    expect(() => reconcileStrandedOrcaLeads(db)).not.toThrow();
    expect(runSqls).toHaveLength(2);
  });

  it('does not propagate errors (must not block ensureReady)', () => {
    const { db } = makeDb({ throwOnRun: true });
    expect(() => reconcileStrandedOrcaLeads(db)).not.toThrow();
  });

  it('reconciles status only after DbClient takeover and stops at an owner boundary', async () => {
    const tx = vi.fn().mockResolvedValue(['worker-1']);
    h.client = {
      query: vi.fn().mockResolvedValue([{ leadSessionId: 'lead-1', sessionId: 'worker-1' }]),
      tx,
    };

    await expect(
      reconcileStrandedOrcaSessions({ canContinue: () => true }),
    ).resolves.toEqual({ archivedWorkerSessions: 1, stopped: false });
    expect(tx).toHaveBeenCalledWith('orca.reconcileInactiveTeamWorkersForLead', {
      leadSessionId: 'lead-1',
      sessionIds: ['worker-1'],
      now: expect.any(Number),
    });

    h.client = {
      query: vi.fn(),
      tx: vi.fn(),
    };
    await expect(
      reconcileStrandedOrcaSessions({ canContinue: () => false }),
    ).resolves.toEqual({ archivedWorkerSessions: 0, stopped: true });
    expect(h.client.query).not.toHaveBeenCalled();
  });
});
