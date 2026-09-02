import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db
    .prepare("PRAGMA table_info('sessions')")
    .all()
    .map((row) => String((row as { name: unknown }).name));
  if (!columns.includes('maintenance_cleared_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN maintenance_cleared_at integer');
  }
}

module.exports = { run };
