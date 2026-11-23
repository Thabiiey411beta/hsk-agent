import { describe, expect, it } from 'vitest';
import { checkTrendGate, canComputeAdx, ADX_MIN_BARS, ADX_MAX_FOR_ENTRY } from '../src/trend.js';

describe('checkTrendGate', () => {
  it('passes when price >= 7d TWAP and 24h TWAP >= 7d TWAP (flat/rising)', () => {
    const g = checkTrendGate({ price: 0.09, twap24h: 0.087, twap7d: 0.0869 });
    expect(g.pass).toBe(true);
    expect(g.priceVsTwap7dBps).toBeGreaterThan(0);
    expect(g.twapSlopeBps).toBeGreaterThan(0);
  });
  it('passes on a frozen pool (price == TWAPs exactly) — flat is not a downtrend', () => {
    const g = checkTrendGate({ price: 0.0868845, twap24h: 0.0868845, twap7d: 0.0868845 });
    expect(g.pass).toBe(true);
    expect(g.priceVsTwap7dBps).toBe(0);
    expect(g.twapSlopeBps).toBe(0);
  });
  it('fails when price is below the 7d TWAP', () => {
    const g = checkTrendGate({ price: 0.08, twap24h: 0.087, twap7d: 0.0869 });
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/BELOW 7d TWAP/);
  });
  it('fails when the 24h TWAP is below the 7d TWAP (falling slope)', () => {
    const g = checkTrendGate({ price: 0.09, twap24h: 0.086, twap7d: 0.0869 });
    expect(g.pass).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/falling/);
  });
  it('missing TWAP fails closed', () => {
    for (const input of [
      { price: 0.09, twap24h: 0, twap7d: 0.0869 },
      { price: 0.09, twap24h: 0.087, twap7d: 0 },
      { price: 0, twap24h: 0.087, twap7d: 0.0869 },
    ]) {
      const g = checkTrendGate(input);
      expect(g.pass).toBe(false);
      expect(g.reasons.join(' ')).toMatch(/missing TWAP/);
    }
  });
  it('ADX is applied when available: >= 25 blocks, < 25 passes', () => {
    const blocked = checkTrendGate({ price: 0.09, twap24h: 0.087, twap7d: 0.0869, adx: 30 });
    expect(blocked.pass).toBe(false);
    expect(blocked.adxApplied).toBe(true);
    const ok = checkTrendGate({ price: 0.09, twap24h: 0.087, twap7d: 0.0869, adx: 12 });
    expect(ok.pass).toBe(true);
    expect(ok.adxApplied).toBe(true);
  });
  it('ADX skipped when unavailable (null) — gate still decides on TWAPs', () => {
    const g = checkTrendGate({ price: 0.09, twap24h: 0.087, twap7d: 0.0869, adx: null });
    expect(g.pass).toBe(true);
    expect(g.adxApplied).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/ADX\(14\) skipped/);
  });
});

describe('canComputeAdx', () => {
  it('needs 15 daily bars; the t-pool has 3', () => {
    expect(ADX_MIN_BARS).toBe(15);
    expect(ADX_MAX_FOR_ENTRY).toBe(25);
    expect(canComputeAdx(3)).toBe(false);
    expect(canComputeAdx(14)).toBe(false);
    expect(canComputeAdx(15)).toBe(true);
  });
});
