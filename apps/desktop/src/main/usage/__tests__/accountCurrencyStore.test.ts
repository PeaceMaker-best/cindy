import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  getCurrentDbClientUserId: vi.fn(() => 'user-a' as string | null),
  electronAppGetPath: vi.fn(() => ''),
}));

vi.mock('electron', () => ({
  app: { getPath: mocks.electronAppGetPath },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('../../localDb/client/current', () => ({
  getCurrentDbClientUserId: mocks.getCurrentDbClientUserId,
}));

import {
  __resetAccountCurrencyStoreForTesting,
  hydrateAccountCurrency,
  noteActiveAccount,
  rememberAccountCurrency,
} from '../accountCurrencyStore';
import {
  __resetActiveLedgerCurrencyForTesting,
  currentLedgerCurrency,
  isLedgerCurrencyKnown,
} from '../ledgerCurrency';

let tempUserDataDir: string | null = null;

function storeFile(): string {
  if (!tempUserDataDir) throw new Error('temp userData is not initialized');
  return path.join(tempUserDataDir, 'cache', 'ledger-currency.json');
}

async function writeStore(entries: Record<string, string>): Promise<void> {
  const file = storeFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, entries }), 'utf8');
}

/** 等 rememberAccountCurrency 的串行写链跑完（它是 fire-and-forget）。 */
async function flushWrites(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(async () => {
  tempUserDataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-ledger-currency-'));
  mocks.electronAppGetPath.mockReturnValue(tempUserDataDir);
  mocks.getCurrentDbClientUserId.mockReturnValue('user-a');
  __resetAccountCurrencyStoreForTesting();
  __resetActiveLedgerCurrencyForTesting();
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempUserDataDir) {
    await rm(tempUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    tempUserDataDir = null;
  }
});

describe('hydrate across an account switch', () => {
  it('discards a hydrate that lands after the account already switched away', async () => {
    // 回归护栏。落盘读取是异步的：A 的读还在途中就切到 B，切号逻辑先清空 lastKnown，
    // 若 A 的读回来不复核当前账号就把旧币种写回，B 的目录没声明 currency 时会按 A 的
    // 口径记账 —— 跨账号错账。
    await writeStore({ 'user-a': 'CNY', 'user-b': 'USD' });

    const pending = hydrateAccountCurrency('user-a');
    // await 期间账号切走（真实链路里是 replaceGatewayModelPricing 的同步 noteActiveAccount）。
    noteActiveAccount('user-b');
    await expect(pending).resolves.toBeNull();

    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('hydrates normally when the account stays put', async () => {
    await writeStore({ 'user-a': 'CNY' });
    await expect(hydrateAccountCurrency('user-a')).resolves.toBe('CNY');
    expect(currentLedgerCurrency()).toBe('CNY');
  });

  it('drops the previous account currency on switch', async () => {
    await writeStore({ 'user-a': 'CNY' });
    await hydrateAccountCurrency('user-a');
    expect(currentLedgerCurrency()).toBe('CNY');

    noteActiveAccount('user-b');
    expect(isLedgerCurrencyKnown()).toBe(false);
    expect(currentLedgerCurrency()).toBe('USD');
  });

  it('returns null without touching the ledger when no user is known', async () => {
    mocks.getCurrentDbClientUserId.mockReturnValue(null);
    await expect(hydrateAccountCurrency()).resolves.toBeNull();
    expect(isLedgerCurrencyKnown()).toBe(false);
  });
});

describe('persistence durability', () => {
  it('writes atomically and leaves no temp file behind', async () => {
    // 直接覆盖写会在崩溃 / 断电时留下截断 JSON，readEntries 解析失败后把 entries 当空，
    // 整份币种快照丢失 —— 冷启动退回兜底币种，正是本 PR 要修的那类错账。
    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();

    const raw = await readFile(storeFile(), 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, entries: { 'user-a': 'CNY' } });

    const leftovers = (await readdir(path.dirname(storeFile()))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps other accounts when appending a new one', async () => {
    await writeStore({ 'user-b': 'USD' });
    rememberAccountCurrency('user-a', 'CNY');
    await flushWrites();

    expect(JSON.parse(await readFile(storeFile(), 'utf8')).entries).toEqual({
      'user-b': 'USD',
      'user-a': 'CNY',
    });
  });

  it('treats a truncated store as empty instead of throwing', async () => {
    const file = storeFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"version":1,"entr', 'utf8');

    await expect(hydrateAccountCurrency('user-a')).resolves.toBeNull();
    expect(isLedgerCurrencyKnown()).toBe(false);
  });

  it('ignores a store written by a future version', async () => {
    await mkdir(path.dirname(storeFile()), { recursive: true });
    await writeFile(
      storeFile(),
      JSON.stringify({ version: 99, entries: { 'user-a': 'CNY' } }),
      'utf8',
    );
    await expect(hydrateAccountCurrency('user-a')).resolves.toBeNull();
  });
});
