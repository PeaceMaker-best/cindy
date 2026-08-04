import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  const columns = tableColumnNames(db, 'sessions');
  if (columns.size === 0) return;

  if (!columns.has('im_logical_session_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN im_logical_session_id text');
    columns.add('im_logical_session_id');
  }
  if (!columns.has('im_generation')) {
    db.exec('ALTER TABLE sessions ADD COLUMN im_generation integer DEFAULT 0 NOT NULL');
    columns.add('im_generation');
  }
  if (!columns.has('runtime_owner_id')) {
    db.exec('ALTER TABLE sessions ADD COLUMN runtime_owner_id text');
    columns.add('runtime_owner_id');
  }
  if (!columns.has('runtime_owner_pid')) {
    db.exec('ALTER TABLE sessions ADD COLUMN runtime_owner_pid integer');
    columns.add('runtime_owner_pid');
  }
  if (!columns.has('runtime_owner_process_start')) {
    db.exec('ALTER TABLE sessions ADD COLUMN runtime_owner_process_start text');
    columns.add('runtime_owner_process_start');
  }
  if (!columns.has('runtime_owner_heartbeat_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN runtime_owner_heartbeat_at integer');
    columns.add('runtime_owner_heartbeat_at');
  }

  if (columns.has('source')) {
    db.prepare(
      `UPDATE sessions
       SET im_logical_session_id = id
       WHERE im_logical_session_id IS NULL
         AND source IN ('feishu', 'slack', 'x', 'discord', 'wechat', 'telegram', 'dingtalk', 'wecom')`,
    ).run();
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_sessions_im_logical_generation ON sessions (im_logical_session_id, im_generation)',
  );
  if (columns.has('status')) {
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_live_im_logical
       ON sessions (im_logical_session_id)
       WHERE im_logical_session_id IS NOT NULL AND status != 'deleted'`,
    );
  }
}

module.exports = { run };
