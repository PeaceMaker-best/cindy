import { describe, expect, it, afterEach } from 'vitest';

import { __resetActiveLedgerCurrencyForTesting } from '../ledgerCurrency';
import { detectOutputLag, type ModelUsageDeltaEntry } from '../modelUsageDelta';
import {
  computePriceQuoteTurnMoney,
  hasPricingVariantSuffix,
  normalizeModelIdForPricing,
  resolveTurnCost,
  type TurnPricingContext,
} from '../turnCostCalculator';
import type { ModelPriceQuote, ModelPricingCatalog } from '../../../shared/regionalMoney';

const XD_GATEWAY: TurnPricingContext = {
  providerId: 'xd',
  billingRoute: 'xd-gateway',
  region: 'global',
};

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 1_000,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

function gatewayQuote(modelId: string, overrides: Partial<ModelPriceQuote> = {}): ModelPriceQuote {
  return {
    providerId: 'xd',
    modelId,
    currency: 'USD',
    source: 'gateway',
    approximate: false,
    inputPerMtok: 10,
    outputPerMtok: 50,
    ...overrides,
  };
}

function catalog(...quotes: ModelPriceQuote[]): ModelPricingCatalog {
  const xd: Record<string, ModelPriceQuote> = {};
  for (const quote of quotes) xd[quote.modelId] = quote;
  return { xd };
}

afterEach(() => {
  __resetActiveLedgerCurrencyForTesting();
});

describe('inferred currency downgrades the money to an estimate', () => {
  it('marks money approximate when the quote currency was guessed locally', () => {
    // 报价数值来自服务端、币种由本地推断时,这一笔能不能和账单对上取决于猜得对不对。
    // 金额仍是真实计费(kind 保持 actual-cost,否则会被并进订阅价值统计),但不能再
    // 自称精确。
    const money = computePriceQuoteTurnMoney(
      TOKENS,
      gatewayQuote('claude-fable-5', { currencyInferred: true }),
      'USD',
    );
    expect(money).toMatchObject({
      currency: 'USD',
      approximate: true,
      kind: 'actual-cost',
    });
    expect(money?.estimateReasons).toContain('inferred-currency');
  });

  it('keeps a server-declared currency exact', () => {
    const money = computePriceQuoteTurnMoney(TOKENS, gatewayQuote('claude-fable-5'), 'USD');
    expect(money).toMatchObject({ approximate: false, kind: 'actual-cost' });
    expect(money?.estimateReasons).toBeUndefined();
  });
});

describe('context-variant models', () => {
  it('detects bracketed variant suffixes', () => {
    expect(hasPricingVariantSuffix('claude-fable-5[1m]')).toBe(true);
    expect(hasPricingVariantSuffix('claude-fable-5')).toBe(false);
    expect(hasPricingVariantSuffix(null)).toBe(false);
  });

  it('prefers an exact variant quote when the catalog registers one', () => {
    // 目录一旦登记 `xxx[1m]` 这样的独立计费档就自动生效,无需再改代码。
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5[1m]',
      tokens: TOKENS,
      pricing: catalog(
        gatewayQuote('claude-fable-5'),
        gatewayQuote('claude-fable-5[1m]', { inputPerMtok: 20, outputPerMtok: 75 }),
      ),
      context: XD_GATEWAY,
    });
    // 20 * 1000 + 75 * 1000 = 95_000 → 0.095
    expect(resolved.money?.amount).toBeCloseTo(0.095, 10);
    expect(resolved.money?.approximate).toBe(false);
  });

  it('falls back to the base tier but stops calling it exact', () => {
    // 变体档没有独立报价时不臆造倍率 —— 猜一个乘数会把"可能少算"变成"确定算错"。
    // 沿用基础档数值,但标记成不精确。
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5[1m]',
      tokens: TOKENS,
      pricing: catalog(gatewayQuote('claude-fable-5')),
      context: XD_GATEWAY,
    });
    expect(resolved.money?.amount).toBeCloseTo(0.06, 10);
    expect(resolved.money?.approximate).toBe(true);
    expect(resolved.model).toBe('claude-fable-5');
  });

  it('leaves plain models exact', () => {
    const resolved = resolveTurnCost({
      rawModel: 'claude-fable-5',
      tokens: TOKENS,
      pricing: catalog(gatewayQuote('claude-fable-5')),
      context: XD_GATEWAY,
    });
    expect(resolved.money?.approximate).toBe(false);
    expect(normalizeModelIdForPricing('claude-fable-5[1m]')).toBe('claude-fable-5');
  });
});

describe('output lag detection', () => {
  function delta(overrides: Partial<ModelUsageDeltaEntry>): ModelUsageDeltaEntry {
    return {
      model: 'claude-fable-5[1m]',
      costUsdDelta: 0,
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      cacheReadTokensDelta: 0,
      cacheCreateTokensDelta: 0,
      ...overrides,
    };
  }

  it('flags a huge input turn that reports almost no output', () => {
    // 实测形态:40 万 token 的上下文写进 cache,output 只报 7 —— 真实的长回复被上游
    // 结算延后到了下一轮。
    expect(
      detectOutputLag([delta({ inputTokensDelta: 131, cacheCreateTokensDelta: 404_534, outputTokensDelta: 7 })]),
    ).toBe(true);
  });

  it('does not flag a normal turn', () => {
    expect(
      detectOutputLag([delta({ cacheReadTokensDelta: 404_771, outputTokensDelta: 3_202 })]),
    ).toBe(false);
  });

  it('does not flag a genuinely tiny turn', () => {
    expect(detectOutputLag([delta({ inputTokensDelta: 120, outputTokensDelta: 4 })])).toBe(false);
  });
});
