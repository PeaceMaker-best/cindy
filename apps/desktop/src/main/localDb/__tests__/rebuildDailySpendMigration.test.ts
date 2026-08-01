import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const migration0085 =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../drizzle/scripts/0085_skinny_iron_man.ts') as {
    run(db: Database.Database): void;
  };

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE daily_spend (
      day TEXT NOT NULL,
      cost_usd REAL NOT NULL DEFAULT 0,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT NOT NULL DEFAULT 'USD',
      cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, cost_currency)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      created_at INTEGER,
      rewind_at INTEGER,
      agent_meta TEXT
    );
  `);
  return db;
}

function dayTs(day: string, hour: number): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime();
}

let autoUuid = 0;

function insertMessage(
  db: Database.Database,
  id: string,
  ts: number,
  turnCost: unknown,
  opts: { rewindAt?: number | null; uuid?: string | null; meta?: Record<string, unknown> } = {},
): void {
  autoUuid += 1;
  const uuid = opts.uuid === undefined ? `uuid-${autoUuid}` : opts.uuid;
  db.prepare('INSERT INTO messages (id, created_at, rewind_at, agent_meta) VALUES (?, ?, ?, ?)').run(
    id,
    ts,
    opts.rewindAt ?? null,
    JSON.stringify({ turnCost, ...(uuid ? { uuid } : {}), ...(opts.meta ?? {}) }),
  );
}

const usd = (amount: number) => ({
  amount,
  currency: 'USD',
  approximate: false,
  kind: 'actual-cost',
});

const cny = (amount: number) => ({
  amount,
  currency: 'CNY',
  approximate: false,
  kind: 'actual-cost',
});

const estimate = (amount: number) => ({
  amount,
  currency: 'USD',
  approximate: true,
  kind: 'value-estimate',
});

function spendRows(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT day, cost_currency, cost_amount FROM daily_spend ORDER BY day, cost_currency')
    .all() as Array<Record<string, unknown>>;
}

describe('0085 daily_spend rebuild from message ledger', () => {
  it('fills a currency row the old single-row schema had overwritten away', () => {
    // 复现真实事故:当天先累计了 CNY,账本币种翻成 USD 后旧写入路径把整行覆盖成 USD,
    // CNY 那笔连同它的币种一起消失。消息级 turnCost 从未丢过,据此把空缺的币种行补回来。
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-31', 15.44, 'USD', 1);

    insertMessage(db, 'm1', dayTs('2026-07-31', 9), cny(100));
    insertMessage(db, 'm2', dayTs('2026-07-31', 10), cny(49.13));
    insertMessage(db, 'm3', dayTs('2026-07-31', 20), usd(15.44));

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-31', cost_currency: 'CNY', cost_amount: 149.13 },
      { day: '2026-07-31', cost_currency: 'USD', cost_amount: 15.44 },
    ]);
  });

  it('never touches a (day, currency) row that already carries an amount', () => {
    // 只填空缺，不上调已有值。消息侧无法还原两件事：这笔钱的**结算时刻**(daily_spend
    // 按 turn done 记账，消息只有 created_at，跨午夜的 turn 会落到前一天) 和这条消息
    // 是不是 fork 复制出的副本。上调已有值会让这两种误差永久写进账本且无法回退，
    // 而少记只是维持现状。
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-30', 500, 'USD', 1);
    insertMessage(db, 'm1', dayTs('2026-07-30', 9), usd(12));

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-30', cost_currency: 'USD', cost_amount: 500 },
    ]);
  });

  it('excludes value estimates from the real-spend ledger', () => {
    // daily_spend 只记真实供应商支出。订阅价值与参考价估算同样写在 agent_meta.turnCost
    // 里(kind=value-estimate)，正常写入路径明确不把它们放进日账 —— 重建也不能放。
    // 实测本机 2387 条带 turnCost 的消息里有 41% 是估值。
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-29', 9), usd(10));
    insertMessage(db, 'm2', dayTs('2026-07-29', 10), estimate(999));
    // 旧字段口径的估值标记同样要挡住。
    insertMessage(db, 'm3', dayTs('2026-07-29', 11), usd(888), {
      meta: { turnCostIsEstimate: true },
    });

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-29', cost_currency: 'USD', cost_amount: 10 },
    ]);
  });

  it('keeps spend from rewound messages', () => {
    // rewind 只把消息软隐藏，供应商费用已经发生，写入路径也不会冲销日账 ——
    // 按 rewind_at 过滤会让这些真实账单永远回不来。
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-28', 9), usd(10));
    insertMessage(db, 'm2', dayTs('2026-07-28', 10), usd(7), { rewindAt: 123 });

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-28', cost_currency: 'USD', cost_amount: 17 },
    ]);
  });

  it('counts a forked copy of the same turn only once', () => {
    // fork 会连同 agent_meta 与原 created_at 复制历史消息，同一笔 turnCost 于是在库里
    // 出现多份。按 SDK 消息 uuid 去重，否则父会话与每个 fork 各算一次。
    const db = setupDb();
    insertMessage(db, 'original', dayTs('2026-07-27', 9), usd(20), { uuid: 'sdk-uuid-1' });
    insertMessage(db, 'fork-copy', dayTs('2026-07-27', 9), usd(20), { uuid: 'sdk-uuid-1' });
    insertMessage(db, 'other', dayTs('2026-07-27', 10), usd(5), { uuid: 'sdk-uuid-2' });

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-27', cost_currency: 'USD', cost_amount: 25 },
    ]);
  });

  it('skips rows without a uuid instead of risking a double count', () => {
    // 没有 uuid 就无法判断是不是副本。宁可少记也不多记：多记会把不存在的花费永久写进
    // 账本且用户无法回退。
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-26', 9), usd(10), { uuid: null });
    insertMessage(db, 'm2', dayTs('2026-07-26', 10), usd(4));

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-26', cost_currency: 'USD', cost_amount: 4 },
    ]);
  });

  it('is idempotent', () => {
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-25', 9), usd(3));
    insertMessage(db, 'm2', dayTs('2026-07-25', 11), usd(4));

    migration0085.run(db);
    const first = spendRows(db);
    migration0085.run(db);

    expect(spendRows(db)).toEqual(first);
    expect(first).toEqual([{ day: '2026-07-25', cost_currency: 'USD', cost_amount: 7 }]);
  });

  it('ignores malformed or zero money without throwing', () => {
    const db = setupDb();
    insertMessage(db, 'm1', dayTs('2026-07-24', 9), { amount: 0, currency: 'USD', kind: 'actual-cost' });
    insertMessage(db, 'm2', dayTs('2026-07-24', 10), { amount: 'nope', currency: 'USD', kind: 'actual-cost' });
    insertMessage(db, 'm3', dayTs('2026-07-24', 11), { amount: 5, currency: 'JPY', kind: 'actual-cost' });
    insertMessage(db, 'm4', dayTs('2026-07-24', 12), usd(2));
    db.prepare('INSERT INTO messages (id, created_at, agent_meta) VALUES (?, ?, ?)').run(
      'm5',
      dayTs('2026-07-24', 13),
      '{"turnCost": not json',
    );

    expect(() => migration0085.run(db)).not.toThrow();
    expect(spendRows(db)).toEqual([
      { day: '2026-07-24', cost_currency: 'USD', cost_amount: 2 },
    ]);
  });

  it('does nothing when the messages table has no cost data', () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO daily_spend (day, cost_amount, cost_currency, updated_at) VALUES (?, ?, ?, ?)`,
    ).run('2026-07-23', 42, 'USD', 1);

    migration0085.run(db);

    expect(spendRows(db)).toEqual([
      { day: '2026-07-23', cost_currency: 'USD', cost_amount: 42 },
    ]);
  });
});
