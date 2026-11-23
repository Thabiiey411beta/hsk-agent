import { describe, expect, it } from 'vitest';
import { buildDailyBars, trueRange, computeAtr, sizeByAtr, ATR_MIN_BARS } from '../src/atr.js';

const DAY = 86400;
const base = 1700006400; // 2023-11-15T00:00:00Z — start of a UTC day, so +1h/+2h stay in it

describe('buildDailyBars', () => {
  it('groups samples by UTC day: open first, close last, high/low observed extremes', () => {
    const bars = buildDailyBars([
      { t: base, price: 100 },
      { t: base + 3600, price: 110 },
      { t: base + 7200, price: 90 },
      { t: base + DAY, price: 95 },
      { t: base + DAY + 3600, price: 105 },
    ]);
    expect(bars.length).toBe(2);
    expect(bars[0]).toEqual({ day: new Date(base * 1000).toISOString().slice(0, 10), open: 100, high: 110, low: 90, close: 90 });
    expect(bars[1].open).toBe(95);
    expect(bars[1].close).toBe(105);
  });
  it('ignores non-positive prices', () => {
    expect(buildDailyBars([{ t: base, price: 0 }, { t: base + 60, price: 50 }]).length).toBe(1);
  });
});

describe('trueRange', () => {
  it('gap-aware: a gap up beyond the day range dominates', () => {
    const bar = { day: '2026-01-02', open: 105, high: 106, low: 104, close: 105 };
    expect(trueRange(bar, 100)).toBe(6); // |high - prevClose| = 6 > range 2
    expect(trueRange(bar, 105)).toBe(2); // no gap: high-low
  });
});

describe('computeAtr', () => {
  it('returns null with fewer than 15 bars (t-pool has 3)', () => {
    expect(ATR_MIN_BARS).toBe(15);
    const bars = buildDailyBars(
      Array.from({ length: 3 }, (_, i) => ({ t: base + i * DAY, price: 0.0869 })),
    );
    expect(computeAtr(bars)).toBeNull();
  });
  it('computes Wilder ATR on a flat-range synthetic series', () => {
    // 20 days, every day high 102 / low 98 / close 100, prev close 100:
    // every TR = 4, so ATR(14) = 4 exactly.
    const bars = Array.from({ length: 20 }, (_, i) => ({
      day: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 102, low: 98, close: 100,
    }));
    expect(computeAtr(bars)).toBeCloseTo(4, 10);
  });
  it('a gap day raises ATR (gap-aware TR)', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      day: `2026-01-${String(i + 1).padStart(2, '0')}`,
      open: 100, high: 102, low: 98, close: i === 10 ? 110 : 100,
    }));
    // Day 11 closes at 110; day 12's TR includes |high - 110| = 8.
    expect(computeAtr(bars)!).toBeGreaterThan(4);
  });
});

describe('sizeByAtr', () => {
  it('risks 1% of equity with a 2x ATR stop', () => {
    // Equity 1000, entry 100, ATR 1 -> stop 98 (2%), risk 10 USDT -> size 500.
    const r = sizeByAtr({ equity: 1000, entryPrice: 100, atr: 1, perTradeCap: 0.6, dailyCap: 1, deployedToday: 0 });
    expect(r.blocked).toBe(false);
    expect(r.stopPrice).toBeCloseTo(98, 10);
    expect(r.stopFraction).toBeCloseTo(0.02, 10);
    expect(r.sizeUsdt).toBeCloseTo(500, 2);
  });
  it('per-trade cap binds when the ATR size would exceed it', () => {
    const r = sizeByAtr({ equity: 1000, entryPrice: 100, atr: 0.5, perTradeCap: 0.1, dailyCap: 1, deployedToday: 0 });
    expect(r.blocked).toBe(false);
    expect(r.sizeUsdt).toBeLessThanOrEqual(100);
  });
  it('blocks when 2x ATR >= entry price (stop would be <= 0)', () => {
    const r = sizeByAtr({ equity: 1000, entryPrice: 0.0869, atr: 0.05, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 0 });
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/stop would be <= 0/);
  });
  it('blocks when the daily cap is exhausted', () => {
    const r = sizeByAtr({ equity: 1000, entryPrice: 100, atr: 1, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 300 });
    expect(r.blocked).toBe(true);
  });
  it('blocks on missing ATR', () => {
    const r = sizeByAtr({ equity: 1000, entryPrice: 100, atr: 0, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 0 });
    expect(r.blocked).toBe(true);
  });
});
