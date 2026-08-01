import { sql } from 'drizzle-orm';

import {
  addCompatibleRegionalMoney,
  addRegionalMoney,
  legacyUsdMoney,
  normalizeRegionalMoney,
  zeroUsageMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { dailySpend } from './schema.js';
import { getDbClient } from './client/current.js';
import { createLogger } from '../logger.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';

const log = createLogger('localDb/dailySpend');

export function localDayKey(ts: number = Date.now()): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

interface SpendRow {
  costUsd: number;
  costAmount: number;
  costCurrency: 'CNY' | 'USD' | null;
  costIsApproximate: boolean;
}

function rowMoney(row: SpendRow | undefined): RegionalMoney {
  const legacy = legacyUsdMoney(row?.costUsd ?? 0);
  const current =
    row?.costCurrency && row.costAmount > 0
      ? normalizeRegionalMoney({
          amount: row.costAmount,
          currency: row.costCurrency,
          approximate: row.costIsApproximate,
          kind: 'actual-cost',
        })
      : undefined;
  if (legacy.amount > 0 && current) {
    return legacy.currency === current.currency ? addRegionalMoney([legacy, current]) : current;
  }
  return current ?? (legacy.amount > 0 ? legacy : zeroUsageMoney());
}

/**
 * 空账本的零值。币种取账本币种而不是构建区域 —— 否则以 USD 结算的账号在 CN 构建上
 * 会看到 ¥0.00，而同一界面上有金额时显示的是 $，空/非空之间货币符号会跳。
 */
function zeroLedgerMoney(): RegionalMoney {
  return {
    amount: 0,
    currency: currentLedgerCurrency(),
    approximate: false,
    kind: 'actual-cost',
  };
}

/**
 * 一天可能有多个币种行(换号 / 跨租户 / 上游漏发币种)。展示侧仍是单币种，按当前账本
 * 币种挑那一行；账本币种缺席时 addCompatibleRegionalMoney 会挑真实计费里的第一种。
 *
 * 不做跨币种求和 —— 汇率是估算，混加会把两笔精确账单变成一个谁也对不上的数。挑不中的
 * 行留在库里，账本币种切回去时自然重新可见。
 */
function rowsMoney(rows: readonly SpendRow[]): RegionalMoney {
  const values = rows.map(rowMoney).filter((money) => money.amount > 0);
  if (values.length === 0) return zeroLedgerMoney();
  return addCompatibleRegionalMoney(values, currentLedgerCurrency()) ?? zeroLedgerMoney();
}

async function getSpendForDay(day: string): Promise<RegionalMoney> {
  const rows = await getDbClient()
    .drizzle.select({
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .where(sql`${dailySpend.day} = ${day}`)
    .all();
  return rowsMoney(rows);
}

export async function incrementDailySpend(
  money: RegionalMoney,
  ts: number = Date.now(),
): Promise<{ day: string; money: RegionalMoney }> {
  const day = localDayKey(ts);
  const normalized = normalizeRegionalMoney(money);
  if (!normalized || normalized.amount < 1e-10) {
    return { day, money: await getSpendForDay(day) };
  }
  // 每天每币种一行，各自累加。异币种不再拒收，也不再覆盖当天累计 —— 那两种做法一个
  // 丢当笔、一个丢全天，而账本币种会因为完全正常的原因(换号、跨租户、上游漏发币种)
  // 发生切换。如实入到它自己的币种行，展示侧再按当前账本币种挑。
  const ledgerCurrency = currentLedgerCurrency();
  if (normalized.currency !== ledgerCurrency) {
    // 不是错误，但值得留痕:出现异币种通常意味着账本币种刚切换过，或上游报价口径变了。
    log.warn(
      `daily spend currency differs from ledger: ${normalized.currency} != ${ledgerCurrency}; ` +
        'recording into its own currency row',
    );
  }
  const db = getDbClient().drizzle;
  await db
    .insert(dailySpend)
    .values({
      day,
      costAmount: normalized.amount,
      costCurrency: normalized.currency,
      costIsApproximate: normalized.approximate,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [dailySpend.day, dailySpend.costCurrency],
      set: {
        costAmount: sql`${dailySpend.costAmount} + ${normalized.amount}`,
        costIsApproximate: sql`(${dailySpend.costIsApproximate} OR ${normalized.approximate ? 1 : 0})`,
        updatedAt: ts,
      },
    })
    .run();
  const persisted = await getSpendForDay(day);
  return { day, money: persisted };
}

export function getTodaySpend(): Promise<RegionalMoney> {
  return getSpendForDay(localDayKey());
}

export async function getAllSpendDays(): Promise<Array<{ day: string; money: RegionalMoney }>> {
  const rows = await getDbClient()
    .drizzle.select({
      day: dailySpend.day,
      costUsd: dailySpend.costUsd,
      costAmount: dailySpend.costAmount,
      costCurrency: dailySpend.costCurrency,
      costIsApproximate: dailySpend.costIsApproximate,
    })
    .from(dailySpend)
    .orderBy(dailySpend.day)
    .all();
  // 主键含币种后同一天可能有多行；调用方要的仍是「这天花了多少」，在这里收敛成单值。
  const byDay = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const bucket = byDay.get(row.day);
    if (bucket) bucket.push(row);
    else byDay.set(row.day, [row]);
  }
  return [...byDay.entries()].map(([day, dayRows]) => ({ day, money: rowsMoney(dayRows) }));
}
