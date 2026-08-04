import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  exec: vi.fn(),
  warn: vi.fn(),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      optsOrCallback: unknown,
      maybeCallback?: (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ) => {
      const callback =
        typeof optsOrCallback === 'function'
          ? (optsOrCallback as typeof maybeCallback)
          : maybeCallback;
      callback?.(null, { stdout: 'self-process-start\n', stderr: '' });
      return {};
    },
  ),
}));

vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('../localDb/client/current.js', () => ({
  getDbClient: () => ({ queryOne: h.queryOne, exec: h.exec }),
}));
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: h.warn,
    error: vi.fn(),
  }),
}));

import {
  __testing,
  acquireSessionRuntimeOwnership,
  releaseSessionRuntimeOwnership,
  SessionRuntimeInactiveError,
  SessionRuntimeOwnedElsewhereError,
} from '../sessionRuntimeOwnership.js';

interface OwnerRow {
  status: string;
  runtime_owner_id: string | null;
  runtime_owner_pid: number | null;
  runtime_owner_process_start: string | null;
  runtime_owner_heartbeat_at: number | null;
}

const NOW = 2_000_000;

function ownerRow(overrides: Partial<OwnerRow> = {}): OwnerRow {
  return {
    status: 'active',
    runtime_owner_id: null,
    runtime_owner_pid: null,
    runtime_owner_process_start: null,
    runtime_owner_heartbeat_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  __testing.locallyOwnedSessionTokens.clear();
  h.exec.mockResolvedValue({ changes: 1 });
});

afterEach(async () => {
  for (const [sessionId, token] of [...__testing.locallyOwnedSessionTokens]) {
    h.exec.mockResolvedValue({ changes: 1 });
    await releaseSessionRuntimeOwnership(sessionId, token);
  }
  vi.useRealTimers();
});

describe('session runtime ownership', () => {
  it('uses a timezone-stable process start fingerprint on Unix', async () => {
    await __testing.readProcessStartFingerprint(4242);
    if (process.platform === 'win32') {
      expect(h.execFile).toHaveBeenLastCalledWith(
        'powershell.exe',
        expect.any(Array),
        expect.any(Function),
      );
      return;
    }
    expect(h.execFile).toHaveBeenLastCalledWith(
      'ps',
      ['-p', '4242', '-o', 'lstart='],
      expect.objectContaining({
        env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }),
      }),
      expect.any(Function),
    );
  });

  it('rejects missing and inactive sessions before claiming a runtime', async () => {
    h.queryOne.mockResolvedValueOnce(undefined);
    await expect(acquireSessionRuntimeOwnership('missing')).rejects.toBeInstanceOf(
      SessionRuntimeInactiveError,
    );

    h.queryOne.mockResolvedValueOnce(ownerRow({ status: 'deleted' }));
    await expect(acquireSessionRuntimeOwnership('deleted')).rejects.toMatchObject({
      name: 'SessionRuntimeInactiveError',
      message: expect.stringContaining('(deleted)'),
    });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('refuses a fresh foreign owner without attempting a CAS takeover', async () => {
    h.queryOne.mockResolvedValue(
      ownerRow({
        runtime_owner_id: 'foreign-token',
        runtime_owner_pid: 4242,
        runtime_owner_process_start: 'foreign-start',
        runtime_owner_heartbeat_at: NOW - 1,
      }),
    );

    await expect(acquireSessionRuntimeOwnership('fresh-foreign')).rejects.toBeInstanceOf(
      SessionRuntimeOwnedElsewhereError,
    );
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('refuses a stale lease when the recorded PID still has the same fingerprint', async () => {
    h.queryOne.mockResolvedValue(
      ownerRow({
        runtime_owner_id: 'foreign-token',
        runtime_owner_pid: process.pid,
        runtime_owner_process_start: 'self-process-start',
        runtime_owner_heartbeat_at: NOW - __testing.staleMs - 1,
      }),
    );

    await expect(acquireSessionRuntimeOwnership('stale-live')).rejects.toBeInstanceOf(
      SessionRuntimeOwnedElsewhereError,
    );
    expect(h.exec).not.toHaveBeenCalled();
  });

  it('takes over a stale lease when a reused PID has a different process fingerprint', async () => {
    h.queryOne.mockResolvedValue(
      ownerRow({
        runtime_owner_id: 'foreign-token',
        runtime_owner_pid: process.pid,
        runtime_owner_process_start: 'previous-process-start',
        runtime_owner_heartbeat_at: NOW - __testing.staleMs - 1,
      }),
    );

    const release = await acquireSessionRuntimeOwnership('pid-reused');
    const claim = h.exec.mock.calls[0];
    expect(String(claim[0])).toContain('runtime_owner_id = ?');
    expect(claim[1]).toEqual([
      expect.stringMatching(new RegExp(`^${process.pid}:`)),
      process.pid,
      'self-process-start',
      NOW,
      'pid-reused',
      'foreign-token',
      NOW - __testing.staleMs - 1,
    ]);

    await release();
  });

  it('fails closed when the fingerprint is unavailable but the PID probe says alive', async () => {
    const alive = await __testing.isSameOwnerProcessStillAlive(
      ownerRow({ runtime_owner_pid: 77 }),
      async () => null,
      () => true,
    );
    expect(alive).toBe(true);
  });

  it('heartbeats exact session/token pairs and never overlaps an in-flight heartbeat', async () => {
    h.queryOne.mockResolvedValue(ownerRow());
    const releaseA = await acquireSessionRuntimeOwnership('session-a');
    const releaseB = await acquireSessionRuntimeOwnership('session-b');
    const tokenA = __testing.locallyOwnedSessionTokens.get('session-a');
    const tokenB = __testing.locallyOwnedSessionTokens.get('session-b');
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();

    let resolveHeartbeat!: (value: { changes: number }) => void;
    const heartbeat = new Promise<{ changes: number }>((resolve) => {
      resolveHeartbeat = resolve;
    });
    h.exec.mockClear();
    h.exec.mockReturnValueOnce(heartbeat);

    await vi.advanceTimersByTimeAsync(__testing.heartbeatMs);
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(h.exec.mock.calls[0][1]).toEqual([NOW + __testing.heartbeatMs, 'session-a', tokenA, 'session-b', tokenB]);

    await vi.advanceTimersByTimeAsync(__testing.heartbeatMs);
    expect(h.exec).toHaveBeenCalledTimes(1);

    resolveHeartbeat({ changes: 2 });
    await heartbeat;
    await Promise.resolve();
    h.exec.mockResolvedValue({ changes: 1 });
    await releaseA();
    await releaseB();
  });

  it('does not let an old release clear a replacement runtime token', async () => {
    let row = ownerRow();
    h.queryOne.mockImplementation(async () => row);
    h.exec.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SET runtime_owner_id = NULL')) {
        const token = params[1] as string;
        if (row.runtime_owner_id === token) {
          row = ownerRow();
          return { changes: 1 };
        }
        return { changes: 0 };
      }
      const nextToken = params[0] as string;
      row = ownerRow({
        runtime_owner_id: nextToken,
        runtime_owner_pid: process.pid,
        runtime_owner_process_start: 'self-process-start',
        runtime_owner_heartbeat_at: NOW,
      });
      return { changes: 1 };
    });

    const releaseOld = await acquireSessionRuntimeOwnership('replacement');
    const oldToken = row.runtime_owner_id;
    const releaseNew = await acquireSessionRuntimeOwnership('replacement');
    const newToken = row.runtime_owner_id;
    expect(newToken).not.toBe(oldToken);

    await releaseOld();
    expect(row.runtime_owner_id).toBe(newToken);
    expect(__testing.locallyOwnedSessionTokens.get('replacement')).toBe(newToken);

    await releaseNew();
    expect(row.runtime_owner_id).toBeNull();
  });

  it('keeps renewing after release persistence fails and allows an exact-token retry', async () => {
    h.queryOne.mockResolvedValue(ownerRow());
    const release = await acquireSessionRuntimeOwnership('release-failure');
    const token = __testing.locallyOwnedSessionTokens.get('release-failure');
    h.exec.mockClear();
    h.exec.mockRejectedValue(new Error('database unavailable'));

    await expect(release()).resolves.toBeUndefined();
    expect(h.exec).toHaveBeenCalledTimes(3);
    expect(__testing.locallyOwnedSessionTokens.get('release-failure')).toBe(token);

    h.exec.mockClear();
    h.exec.mockResolvedValue({ changes: 1 });
    await vi.advanceTimersByTimeAsync(__testing.heartbeatMs);
    expect(h.exec).toHaveBeenCalledWith(
      expect.stringContaining('runtime_owner_heartbeat_at'),
      [NOW + __testing.heartbeatMs, 'release-failure', token],
    );
    expect(h.warn).toHaveBeenCalledWith(
      'failed to release session runtime ownership',
      expect.objectContaining({ sessionId: 'release-failure' }),
    );

    h.exec.mockClear();
    await expect(release()).resolves.toBeUndefined();
    expect(h.exec).toHaveBeenCalledWith(
      expect.stringContaining('SET runtime_owner_id = NULL'),
      ['release-failure', token],
    );
    expect(__testing.locallyOwnedSessionTokens.has('release-failure')).toBe(false);
  });
});
