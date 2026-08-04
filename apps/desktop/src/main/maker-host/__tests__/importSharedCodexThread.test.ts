/**
 * importSharedCodexThread / removeSharedCodexThread:
 * 用 temp desktop codex home + 真 state sqlite 验证落位、列交集容忍、回滚清理。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const electronMock = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => electronMock.userData) },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  finalizeSharedCodexThreadImport,
  importSharedCodexThread,
  removeSharedCodexThread,
} from '../codex-local-sessions';

const THREAD_ID = '019dcd5a-6e54-7960-95e0-aa68117a28f1';

let rootDir = '';
let codexHome = '';
let stateDbPath = '';

/** 直接查 state DB 断言 thread 行存在与否(原 hasDesktopCodexThread 已随生产调用方清零而删除)。 */
function desktopThreadExists(threadId: string): boolean {
  const db = new Database(stateDbPath, { readonly: true });
  try {
    return db.prepare('SELECT id FROM threads WHERE id = ?').get(threadId) !== undefined;
  } finally {
    db.close();
  }
}

function createStateDb(): void {
  const db = new Database(stateDbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      rollout_path TEXT,
      source TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE thread_dynamic_tools (thread_id TEXT, tool_name TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
  `);
  db.close();
}

describe('importSharedCodexThread', () => {
  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdtshare-codex-import-'));
    electronMock.userData = rootDir;
    codexHome = path.join(rootDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    stateDbPath = path.join(codexHome, 'state_1.sqlite');
    createStateDb();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const stateRows = () => ({
    threads: [
      {
        id: THREAD_ID,
        cwd: '/old/machine/proj',
        rollout_path: '/old/machine/rollout.jsonl',
        source: 'desktop',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        // 目标表没有的列:必须被列交集丢弃而不是报错
        future_column: 'ignored',
      },
    ],
    threadDynamicTools: [{ thread_id: THREAD_ID, tool_name: 'browser' }],
    threadSpawnEdges: [],
  });

  it('stages rollout/state, then publishes pointers and session index after commit', async () => {
    const params = {
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"session_meta":{}}\n'),
      rolloutFilename: `rollout-2026-01-01-${THREAD_ID}.jsonl`,
      newCwd: '/new/machine/proj',
      title: '分享的 codex 会话',
      updatedAt: Date.now(),
    };
    const staged = await importSharedCodexThread(params);
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    expect(fs.existsSync(indexPath)).toBe(false);

    const result = await finalizeSharedCodexThreadImport(params, staged);
    expect(result.stateWritten).toBe(true);
    expect(result.statePresent).toBe(true);
    expect(result.stateFinalized).toBe(true);
    expect(result.rolloutPath).toBeTruthy();
    expect(result.rolloutWritten).toBe(true);
    expect(fs.readFileSync(result.rolloutPath!, 'utf-8')).toContain('session_meta');

    const db = new Database(stateDbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(THREAD_ID) as Record<
      string,
      unknown
    >;
    const tools = db
      .prepare('SELECT * FROM thread_dynamic_tools WHERE thread_id = ?')
      .all(THREAD_ID);
    db.close();
    expect(row.cwd).toBe('/new/machine/proj');
    expect(row.rollout_path).toBe(result.rolloutPath);
    expect(tools).toHaveLength(1);

    const indexContent = fs.readFileSync(indexPath, 'utf-8');
    expect(indexContent).toContain(THREAD_ID);

    expect(desktopThreadExists(THREAD_ID)).toBe(true);
  });

  it('skips state write when no state db exists (fresh machine), still lands rollout', async () => {
    fs.rmSync(stateDbPath);
    const result = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(result.stateWritten).toBe(false);
    expect(result.statePresent).toBe(false);
    expect(result.stateFinalized).toBe(false);
    expect(result.rolloutPath).toBeTruthy();
    expect(fs.existsSync(result.rolloutPath!)).toBe(true);
  });

  it('decodes base64 blob markers back to Buffer columns', async () => {
    const db = new Database(stateDbPath);
    db.exec('ALTER TABLE threads ADD COLUMN blob_col BLOB');
    db.close();
    const rows = stateRows();
    (rows.threads[0] as Record<string, unknown>).blob_col = {
      __xdtshareBlobB64: Buffer.from('binary').toString('base64'),
    };
    await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: rows,
      rolloutBuffer: null,
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    const check = new Database(stateDbPath, { readonly: true });
    const row = check.prepare('SELECT blob_col FROM threads WHERE id = ?').get(THREAD_ID) as {
      blob_col: Buffer;
    };
    check.close();
    expect(Buffer.isBuffer(row.blob_col)).toBe(true);
    expect(row.blob_col.toString()).toBe('binary');
  });

  it('refuses to write rollout when fallback filename would escape sessions dir (P0 second gate)', async () => {
    const evilThreadId = '../../../../tmp/evil';
    const result = await importSharedCodexThread({
      threadId: evilThreadId,
      stateRows: { threads: [], threadDynamicTools: [], threadSpawnEdges: [] },
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null, // 触发 threadId 兜底分支
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    expect(result.rolloutPath).toBeNull();
    expect(fs.existsSync(path.join(rootDir, '..', 'tmp', 'evil.jsonl'))).toBe(false);
  });

  it('re-import keeps existing pointers/index unchanged until commit, then publishes them', async () => {
    const firstParams = {
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"v":1}\n'),
      rolloutFilename: `rollout-${THREAD_ID}.jsonl`,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    };
    const firstStaged = await importSharedCodexThread(firstParams);
    const first = await finalizeSharedCodexThreadImport(firstParams, firstStaged);
    expect(first.rolloutWritten).toBe(true);
    expect(first.stateWritten).toBe(true);
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    const indexBefore = fs.readFileSync(indexPath, 'utf-8');

    // 同一分享包重导(Maker 会话已删但盘上残留),且用户换了 workingDir:
    // prepare 阶段文件不覆盖、child 表不重插,也不能提前修改既有 thread 指针
    // 或追加 index；Cindy DB CAS 成功后才发布新 cwd / rollout_path。
    const secondParams = {
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"v":2}\n'),
      rolloutFilename: `rollout-${THREAD_ID}.jsonl`,
      newCwd: '/new/proj-relocated',
      title: 't',
      updatedAt: Date.now(),
    };
    const secondStaged = await importSharedCodexThread(secondParams);
    expect(secondStaged.rolloutPath).toBe(first.rolloutPath);
    expect(secondStaged.rolloutWritten).toBe(false);
    expect(secondStaged.stateWritten).toBe(false); // 无新插入行
    expect(secondStaged.statePresent).toBe(true); // 行仍在,不该触发降档提示
    expect(secondStaged.stateFinalized).toBe(false); // 旧指针尚未在 Cindy DB commit 后刷新
    expect(fs.readFileSync(secondStaged.rolloutPath!, 'utf-8')).toBe('{"v":1}\n'); // 未被覆盖

    let db = new Database(stateDbPath, { readonly: true });
    let row = db.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID) as {
      cwd: string;
      rollout_path: string;
    };
    expect(row.cwd).toBe('/new/proj');
    expect(row.rollout_path).toBe(first.rolloutPath);
    db.close();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(indexBefore);

    const second = await finalizeSharedCodexThreadImport(secondParams, secondStaged);
    expect(second.stateFinalized).toBe(true);
    db = new Database(stateDbPath, { readonly: true });
    row = db.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID) as {
      cwd: string;
      rollout_path: string;
    };
    const toolCount = db
      .prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id = ?')
      .get(THREAD_ID) as { n: number };
    db.close();
    expect(row.cwd).toBe('/new/proj-relocated');
    expect(row.rollout_path).toBe(second.rolloutPath);
    expect(toolCount.n).toBe(1); // child 表未翻倍
    expect(fs.readFileSync(indexPath, 'utf-8')).not.toBe(indexBefore);

    // 复用态 rollback 仍不得误删第一次落下的文件与 state 行。
    await removeSharedCodexThread(THREAD_ID, second);
    expect(fs.existsSync(first.rolloutPath!)).toBe(true);
    expect(desktopThreadExists(THREAD_ID)).toBe(true);
  });

  it('rollback after a failed app DB CAS leaves an existing thread and index byte-identical', async () => {
    const db = new Database(stateDbPath);
    db.prepare(
      `INSERT INTO threads (id, cwd, rollout_path, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      THREAD_ID,
      '/existing/proj',
      '/existing/rollout.jsonl',
      'desktop',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    db.prepare('INSERT INTO thread_dynamic_tools (thread_id, tool_name) VALUES (?, ?)').run(
      THREAD_ID,
      'browser',
    );
    db.close();
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    const indexBefore = '{"id":"existing","thread_name":"Existing"}\n';
    fs.writeFileSync(indexPath, indexBefore, 'utf-8');
    const params = {
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"new":true}\n'),
      rolloutFilename: `rollout-new-${THREAD_ID}.jsonl`,
      newCwd: '/replacement/proj',
      title: 'Replacement',
      updatedAt: Date.now(),
    };

    const staged = await importSharedCodexThread(params);
    expect(staged.stateDbPath).toBe(stateDbPath);
    expect(staged.stateWritten).toBe(false);
    expect(staged.rolloutWritten).toBe(true);
    expect(fs.existsSync(staged.rolloutPath!)).toBe(true);
    let check = new Database(stateDbPath, { readonly: true });
    expect(
      check.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID),
    ).toEqual({
      cwd: '/existing/proj',
      rollout_path: '/existing/rollout.jsonl',
    });
    expect(
      check
        .prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id = ?')
        .get(THREAD_ID),
    ).toEqual({ n: 1 });
    check.close();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(indexBefore);

    await removeSharedCodexThread(THREAD_ID, staged);
    expect(fs.existsSync(staged.rolloutPath!)).toBe(false);
    check = new Database(stateDbPath, { readonly: true });
    expect(
      check.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID),
    ).toEqual({
      cwd: '/existing/proj',
      rollout_path: '/existing/rollout.jsonl',
    });
    expect(
      check
        .prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools WHERE thread_id = ?')
        .get(THREAD_ID),
    ).toEqual({ n: 1 });
    check.close();
    expect(fs.readFileSync(indexPath, 'utf-8')).toBe(indexBefore);
  });

  it('reports an existing pointer update failure instead of claiming finalized state', async () => {
    const db = new Database(stateDbPath);
    db.prepare(
      `INSERT INTO threads (id, cwd, rollout_path, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      THREAD_ID,
      '/old/proj',
      '/old/rollout.jsonl',
      'desktop',
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
    );
    db.close();

    const params = {
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{"new":true}\n'),
      rolloutFilename: `rollout-new-${THREAD_ID}.jsonl`,
      newCwd: '/new/proj',
      title: 'Replacement',
      updatedAt: Date.now(),
    };
    const staged = await importSharedCodexThread(params);
    expect(staged.statePresent).toBe(true);
    expect(staged.stateFinalized).toBe(false);

    const blocked = new Database(stateDbPath);
    blocked.exec(`
      CREATE TRIGGER block_thread_pointer_update
      BEFORE UPDATE OF cwd, rollout_path ON threads
      BEGIN
        SELECT RAISE(ABORT, 'pointer update blocked');
      END;
    `);
    blocked.close();

    const finalized = await finalizeSharedCodexThreadImport(params, staged);
    expect(finalized.statePresent).toBe(true);
    expect(finalized.stateFinalized).toBe(false);
    const check = new Database(stateDbPath, { readonly: true });
    expect(check.prepare('SELECT cwd, rollout_path FROM threads WHERE id = ?').get(THREAD_ID)).toEqual({
      cwd: '/old/proj',
      rollout_path: '/old/rollout.jsonl',
    });
    check.close();
  });

  it('removeSharedCodexThread rolls back rollout file and state rows', async () => {
    const result = await importSharedCodexThread({
      threadId: THREAD_ID,
      stateRows: stateRows(),
      rolloutBuffer: Buffer.from('{}\n'),
      rolloutFilename: null,
      newCwd: '/new/proj',
      title: 't',
      updatedAt: Date.now(),
    });
    await removeSharedCodexThread(THREAD_ID, result);
    expect(fs.existsSync(result.rolloutPath!)).toBe(false);
    expect(desktopThreadExists(THREAD_ID)).toBe(false);
    const db = new Database(stateDbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM thread_dynamic_tools').get()).toEqual({ n: 0 });
    db.close();
  });
});
