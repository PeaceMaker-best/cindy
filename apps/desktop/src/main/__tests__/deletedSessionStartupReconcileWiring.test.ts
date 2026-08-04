import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8');

describe('deleted session startup reconciliation wiring', () => {
  it('runs after DbClient takeover and before account integrations can produce work', () => {
    const takeover = source.indexOf(
      'const dbClientTakeover = await ensureLifecycleDbClient(userId)',
    );
    const reconcile = source.indexOf('await reconcileDeletedSessionLifecycles({');
    const orcaReconcile = source.indexOf('await reconcileStrandedOrcaSessions({');
    const worktreeReconcile = source.indexOf('await reconcileWorktreesForDeletedSessions({');
    const savepointReconcile = source.indexOf('await reconcileSavepointRefsForDeletedSessions({');
    const integrations = source.indexOf('const providerScopeKey = activeOwnerScopeKey()');

    expect(takeover).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(takeover);
    expect(orcaReconcile).toBeGreaterThan(reconcile);
    expect(worktreeReconcile).toBeGreaterThan(orcaReconcile);
    expect(savepointReconcile).toBeGreaterThan(worktreeReconcile);
    expect(integrations).toBeGreaterThan(savepointReconcile);
    expect(source).not.toContain('void reconcileWorktreesForDeletedSessions()');
    expect(source).not.toContain('void reconcileSavepointRefsForDeletedSessions()');
    expect(source).toContain('dbClient: startupDbClient!');
    expect(source).toContain('canContinue: isStartupOwnerCurrent');
  });
});
