import type { SessionSendOptions, SessionSendResult, UserMessage } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import {
  createOrcaInterAgentDispatcher,
  type OrcaInterAgentDispatcherDeps,
} from '../orcaInterAgentDispatcher.js';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => mocks.logger,
}));

interface TestSessionMeta {
  agentKind: 'codex';
  workDir: string;
  model: string;
}

function createLiveSession(
  send: (message: UserMessage, opts?: SessionSendOptions) => Promise<SessionSendResult>,
) {
  return {
    id: 'target-session',
    agentKind: 'codex' as const,
    isTurnRunning: vi.fn(() => false),
    send: vi.fn(send),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides: Partial<OrcaInterAgentDispatcherDeps<TestSessionMeta>> = {}) {
  const order: string[] = [];
  const queuedItems: AgentInputQueuedMessage[] = [];
  const createOpts = {
    agentKind: 'codex' as const,
    workingDir: 'C:\\repo',
    model: 'gpt-5.4',
    permissionMode: 'bypassPermissions',
  };
  const meta: TestSessionMeta = {
    agentKind: 'codex',
    workDir: 'C:\\repo',
    model: 'gpt-5.4',
  };
  const dbRow = {
    title: 'Target Session',
    status: 'active',
    userSendAt: Date.parse('2026-06-12T01:02:03.000Z'),
  };
  const liveSession = createLiveSession(async (_message, opts) => {
    order.push('send-called');
    await opts?.onAccepted?.();
    order.push('vendor-released');
    return { accepted: true };
  });
  const deps: OrcaInterAgentDispatcherDeps<TestSessionMeta> = {
    createId: vi.fn(() => 'client-1'),
    getSessionMeta: vi.fn(async () => meta),
    getSessionRowSnapshot: vi.fn(async () => dbRow),
    getLiveSession: vi.fn(() => liveSession),
    shouldQueueNewTurn: vi.fn(() => false),
    withSessionLock: vi.fn(async (_sessionId, task) => task()),
    buildCreateOptsForQueuedSession: vi.fn(async () => createOpts),
    enqueueQueuedMessage: vi.fn(async (_sessionId, item) => {
      queuedItems.push(item);
    }),
    sendToSessionInternal: vi.fn(async () => ({
      ok: true,
      targetSessionId: 'target-session',
      agentKind: 'codex',
      wakeKind: 'resumed',
      targetTitle: dbRow.title,
      targetLastUserSendAt: new Date(dbRow.userSendAt).toISOString(),
    } as const)),
    createDbMessage: vi.fn(async () => {
      order.push('db');
    }),
    resolveWorkerSenderLabel: vi.fn(async (_workerId, fallback) => fallback),
    isSessionRunningError: vi.fn((err) =>
      err instanceof Error && (err as { code?: string }).code === 'SESSION_RUNNING'
    ),
    log: mocks.logger,
    ...overrides,
  };
  const dispatcher = createOrcaInterAgentDispatcher(deps);
  return { dispatcher, deps, order, queuedItems, liveSession };
}

function firstQueuedItem(items: AgentInputQueuedMessage[]): AgentInputQueuedMessage {
  const item = items[0];
  expect(item).toBeDefined();
  if (!item) throw new Error('expected a queued item');
  return item;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Orca lead/worker dispatcher', () => {
  it('does not inspect or mutate the target when deletion wins the lifecycle lock', async () => {
    const withSessionLock = vi.fn(async () => {
      throw new Error('delete acquired lifecycle lock first');
    });
    const h = createHarness({ withSessionLock });

    await expect(h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Too late',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'delete-first' },
    })).rejects.toThrow(/delete acquired lifecycle lock first/);

    expect(h.deps.getSessionMeta).not.toHaveBeenCalled();
    expect(h.deps.getSessionRowSnapshot).not.toHaveBeenCalled();
    expect(h.deps.getLiveSession).not.toHaveBeenCalled();
    expect(h.deps.enqueueQueuedMessage).not.toHaveBeenCalled();
    expect(h.deps.createDbMessage).not.toHaveBeenCalled();
    expect(h.deps.sendToSessionInternal).not.toHaveBeenCalled();
  });

  it('holds the lifecycle lock through direct send acceptance', async () => {
    const order: string[] = [];
    const sendGate = deferred();
    const live = createLiveSession(async (_message, opts) => {
      order.push('send-start');
      await opts?.onAccepted?.();
      order.push('accepted-settled');
      await sendGate.promise;
      return { accepted: true };
    });
    const h = createHarness({
      getLiveSession: vi.fn(() => live),
      withSessionLock: vi.fn(async (_sessionId, task) => {
        order.push('lock-acquired');
        const value = await task();
        order.push('lock-released');
        return value;
      }),
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Direct',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'direct-lock-order' },
      onAccepted: async () => {
        order.push('accepted-side-effect');
      },
    });

    await vi.waitFor(() => expect(order).toContain('accepted-settled'));
    expect(order).not.toContain('lock-released');
    sendGate.resolve();
    await expect(dispatch).resolves.toMatchObject({ ok: true, mode: 'dispatched' });
    expect(order).toEqual([
      'lock-acquired',
      'send-start',
      'accepted-side-effect',
      'accepted-settled',
      'lock-released',
    ]);
  });

  it('holds the lifecycle lock until queued mutation commits', async () => {
    const order: string[] = [];
    const enqueueGate = deferred();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      withSessionLock: vi.fn(async (_sessionId, task) => {
        order.push('lock-acquired');
        const value = await task();
        order.push('lock-released');
        return value;
      }),
      enqueueQueuedMessage: vi.fn(async () => {
        order.push('enqueue-start');
        await enqueueGate.promise;
        order.push('enqueue-committed');
      }),
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queue me',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queue-lock-order' },
    });

    await vi.waitFor(() => expect(order).toContain('enqueue-start'));
    expect(order).not.toContain('lock-released');
    enqueueGate.resolve();
    await expect(dispatch).resolves.toMatchObject({ ok: true, mode: 'queued' });
    expect(order).toEqual([
      'lock-acquired',
      'enqueue-start',
      'enqueue-committed',
      'lock-released',
    ]);
  });

  it('keeps fallback resume/create/send inside the lifecycle lock', async () => {
    const order: string[] = [];
    const fallbackGate = deferred();
    const h = createHarness({
      getLiveSession: vi.fn(() => null),
      withSessionLock: vi.fn(async (_sessionId, task) => {
        order.push('lock-acquired');
        const value = await task();
        order.push('lock-released');
        return value;
      }),
      sendToSessionInternal: vi.fn(async (params) => {
        order.push('fallback-start');
        await params.onAccepted?.();
        order.push('fallback-accepted');
        await fallbackGate.promise;
        return {
          ok: true,
          targetSessionId: 'target-session',
          agentKind: 'codex',
          wakeKind: 'resumed',
          targetTitle: 'Target Session',
          targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
        } as const;
      }),
    });

    const dispatch = h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Wake target',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'fallback-lock-order' },
      onAccepted: async () => {
        order.push('accepted-side-effect');
      },
    });

    await vi.waitFor(() => expect(order).toContain('fallback-accepted'));
    expect(order).not.toContain('lock-released');
    fallbackGate.resolve();
    await expect(dispatch).resolves.toMatchObject({ ok: true, mode: 'dispatched' });
    expect(order).toEqual([
      'lock-acquired',
      'fallback-start',
      'accepted-side-effect',
      'fallback-accepted',
      'lock-released',
    ]);
  });

  it('runs direct accepted side effects after DB persistence and before vendor turn release', async () => {
    const h = createHarness();

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Implement feature',
      source: 'lead',
      senderLabel: 'Lead',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'direct-test' },
      onAccepted: async () => {
        h.order.push('accepted');
      },
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'dispatched',
      clientId: 'client-1',
      dispatchOutcome: { kind: 'session-dispatch', source: 'orca', dispatched: true },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.order).toEqual(['send-called', 'db', 'accepted', 'vendor-released']);
    expect(h.deps.createDbMessage).toHaveBeenCalledWith('target-session', {
      clientId: 'client-1',
      role: 'user',
      content: '{"orcaSource":"lead","content":"Implement feature"}',
    });
    expect(h.liveSession.send).toHaveBeenCalledWith(
      {
        type: 'user',
        content:
          '[From Orca Lead]\nImplement feature\n\n---\n(Bridge note: your worker_id for tool calls is worker-1.)',
      },
      expect.objectContaining({ throwOnStartFailure: true }),
    );
  });

  it('delays queued accepted side effects until the coordinator accepted hook runs', async () => {
    const accepted = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queued task',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-test' },
      onAccepted: accepted,
    });

    expect(result).toMatchObject({ ok: true, mode: 'queued' });
    expect(accepted).not.toHaveBeenCalled();
    expect(h.queuedItems).toHaveLength(1);

    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', firstQueuedItem(h.queuedItems));

    expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('discards queued accepted callbacks without rollback when the queued item never ran', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Discard me',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'discard-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    const queued = firstQueuedItem(h.queuedItems);
    h.dispatcher.discardQueuedOrcaInterAgentAcceptedCallback(queued.clientId);
    await h.dispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback('target-session', queued.clientId);

    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('does not roll back direct dispatch failures before accepted runs', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async () => {
          h.order.push('send-called');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Will fail before accepted',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'pre-accept-failure-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual(['send-called']);
    expect(h.deps.createDbMessage).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back direct accepted side effects when dispatch fails after accepted', async () => {
    const accepted = vi.fn(() => {
      h.order.push('accepted');
    });
    const rollback = vi.fn(() => {
      h.order.push('rollback');
    });
    const h = createHarness({
      getLiveSession: vi.fn(() =>
        createLiveSession(async (_message, opts) => {
          h.order.push('send-called');
          await opts?.onAccepted?.();
          h.order.push('send-returned-cancelled');
          return { accepted: false, reason: 'cancelled-before-dispatch' };
        })
      ),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Will cancel',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    expect(result).toMatchObject({
      ok: false,
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
      },
    });
    expect(h.order).toEqual(['send-called', 'db', 'accepted', 'send-returned-cancelled', 'rollback']);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('rolls back queued accepted side effects when dispatch settles as not dispatched', async () => {
    const accepted = vi.fn();
    const rollback = vi.fn();
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
    });

    await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Queued failure',
      source: 'lead',
      senderLabel: 'Lead',
      meta: { source: 'orca', context: 'queued-rollback-test' },
      onAccepted: accepted,
      onAcceptedRollback: rollback,
    });

    const queued = firstQueuedItem(h.queuedItems);
    await h.dispatcher.runQueuedOrcaInterAgentAcceptedCallback('target-session', queued);
    await h.dispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
      'target-session',
      {
        persistUserMessage: {
          clientId: queued.clientId,
          content: queued.persistedContent,
          delivery: 'turn',
        },
      },
      {
        kind: 'session-dispatch',
        source: 'maker-ipc',
        dispatched: false,
        reason: 'cancelled-before-dispatch',
        context: 'queued-rollback-test',
        message: 'Session send was cancelled before vendor dispatch: queued-rollback-test',
      },
    );

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  it('returns receipt fields and preserves queued Orca origin metadata', async () => {
    const h = createHarness({
      shouldQueueNewTurn: vi.fn(() => true),
      resolveWorkerSenderLabel: vi.fn(async () => 'Reviewer'),
    });

    const result = await h.dispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: 'target-session',
      rawContent: 'Done',
      source: 'worker',
      senderLabel: 'Worker',
      workerId: 'worker-1',
      meta: { source: 'orca', context: 'receipt-test' },
    });

    expect(result).toEqual({
      ok: true,
      mode: 'queued',
      clientId: 'client-1',
      dispatchOutcome: {
        kind: 'session-dispatch',
        source: 'orca',
        dispatched: true,
        wakeKind: 'queued',
      },
      targetTitle: 'Target Session',
      targetLastUserSendAt: '2026-06-12T01:02:03.000Z',
    });
    expect(h.queuedItems[0]).toMatchObject({
      clientId: 'client-1',
      text: '[From Orca Worker]\nDone',
      persistedContent: '{"orcaSource":"worker","content":"Done"}',
      origin: {
        kind: 'orca',
        senderLabel: 'Reviewer',
        displayText: 'Done',
      },
    });
  });
});
