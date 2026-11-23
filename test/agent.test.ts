import { describe, expect, it } from 'vitest';
import { priceToken0PerToken1, spreadBps, tickToUsdtPerWhsk, twap } from '../src/math.js';
import { scoreSignal } from '../src/signal.js';
import { sizePosition } from '../src/sizing.js';
import { checkRisk, newRiskState } from '../src/risk.js';
import { Journal } from '../src/journal.js';
import { buildEvents, replayEvents } from '../src/backtest.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SupraReader, type SupraContractLike } from '../src/supra.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// sqrtPrice for price 1.0 (token1 per token0) is 2^96.
const Q96 = 2n ** 96n;

describe('math', () => {
  it('sqrtPrice 2^96 -> price 1', () => {
    expect(priceToken0PerToken1(Q96)).toBeCloseTo(1, 10);
  });
  it('sqrtPrice for USDT/WHSK ~78.2 (live 0.05% pool value)', () => {
    // Live sqrtPrice 8957283375159976598289388791 -> ~78.2 USDT per WHSK.
    const p = priceToken0PerToken1(8957283375159976598289388791n);
    expect(p).toBeGreaterThan(70);
    expect(p).toBeLessThan(90);
  });
  it('spreadBps is symmetric-ish and zero for equal prices', () => {
    expect(spreadBps(100, 100)).toBe(0);
    expect(Math.abs(spreadBps(78.2, 54.2))).toBeGreaterThan(3000);
  });
  it('tick -43600 -> ~78.2 USDT/WHSK (matches live pool + swap amounts)', () => {
    // Live swap: -0.782 USDT in, +0.01 WHSK out at tick -43600 -> 78.2 USDT/WHSK.
    expect(tickToUsdtPerWhsk(-43600)).toBeCloseTo(78.2, 0);
  });
  it('twap weights by time (price held over each interval)', () => {
    // (0,100) held 0->100s, (100,100) held 100->200s; the final sample's price
    // has no duration, so TWAP = 100.
    const t = twap([
      { t: 0, price: 100 },
      { t: 100, price: 100 },
      { t: 200, price: 200 },
    ]);
    expect(t).toBeCloseTo(100, 6);
    const t2 = twap([
      { t: 0, price: 100 },
      { t: 100, price: 200 },
      { t: 200, price: 200 },
    ]);
    expect(t2).toBeCloseTo(150, 6);
  });
});

describe('signal', () => {
  it('large cross-fee spread scores high and buys WHSK', () => {
    const s = scoreSignal({ priceLowFee: 54.2, priceHighFee: 78.2, twapPrice: 60, volumeTrend: 1.5 });
    expect(s.score).toBeGreaterThanOrEqual(60);
    expect(s.direction).toBe('buy-whsk');
  });
  it('agreeing pools score low', () => {
    const s = scoreSignal({ priceLowFee: 60, priceHighFee: 60.1, twapPrice: 60, volumeTrend: 1 });
    expect(s.score).toBeLessThan(60);
    expect(s.direction).toBe('none');
  });
  it('missing TWAP does not crash and scores 0 on that component', () => {
    const s = scoreSignal({ priceLowFee: 54.2, priceHighFee: 78.2, twapPrice: 0, volumeTrend: 1 });
    expect(s.components.twap).toBe(0);
    expect(s.score).toBeGreaterThan(0);
  });
});

describe('sizing', () => {
  it('sizes within per-trade cap and scales with score', () => {
    const a = sizePosition({ equity: 1000, signalScore: 100, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 0, riskAppetite: 0.5, minScore: 60 });
    expect(a.blocked).toBe(false);
    expect(a.sizeUsdt).toBeLessThanOrEqual(100);
    const b = sizePosition({ equity: 1000, signalScore: 60, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 0, riskAppetite: 0.5, minScore: 60 });
    expect(b.sizeUsdt).toBeLessThan(a.sizeUsdt);
  });
  it('blocks below threshold', () => {
    const r = sizePosition({ equity: 1000, signalScore: 30, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 0, riskAppetite: 0.5, minScore: 60 });
    expect(r.blocked).toBe(true);
  });
  it('blocks when daily cap is exhausted', () => {
    const r = sizePosition({ equity: 1000, signalScore: 90, perTradeCap: 0.1, dailyCap: 0.3, deployedToday: 300, riskAppetite: 0.5, minScore: 60 });
    expect(r.blocked).toBe(true);
  });
});

describe('risk gates', () => {
  it('missing data always blocks (fail-closed)', () => {
    const st = newRiskState(1000);
    const r = checkRisk(st, DEFAULT_CONFIG, { dataOk: false, today: st.day });
    expect(r.pass).toBe(false);
  });
  it('passes on a clean state with data', () => {
    const st = newRiskState(1000);
    const r = checkRisk(st, DEFAULT_CONFIG, { dataOk: true, today: st.day });
    expect(r.pass).toBe(true);
  });
  it('blocks on daily loss breach and on drawdown breach', () => {
    const st = newRiskState(1000);
    st.dailyPnl = -60;
    expect(checkRisk(st, DEFAULT_CONFIG, { dataOk: true, today: st.day }).pass).toBe(false);
    const st2 = newRiskState(1000);
    st2.equity = 850;
    expect(checkRisk(st2, DEFAULT_CONFIG, { dataOk: true, today: st2.day }).pass).toBe(false);
  });
  it('stop-loss triggers on the open position', () => {
    const st = newRiskState(1000);
    const r = checkRisk(st, DEFAULT_CONFIG, { dataOk: true, positionPnlPct: -0.03, today: st.day });
    expect(r.pass).toBe(false);
  });
});

describe('journal', () => {
  it('appends and reads back JSONL entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hsk-journal-'));
    const j = new Journal(join(dir, 'j.jsonl'));
    j.append({ type: 'signal', score: 72 });
    j.append({ type: 'decision', action: 'no-trade' });
    const all = j.readAll();
    expect(all.length).toBe(2);
    expect(all[0].score).toBe(72);
    expect(j.tail(1)[0].type).toBe('decision');
  });
});

describe('backtest replay', () => {
  it('replays synthetic two-pool swaps and reports honest metrics', () => {
    // Synthetic: price oscillates 50 -> 80 -> 50 over 100 swaps in both pools
    // (tick for USDT/WHSK price p: tick = -ln(p)/ln(1.0001)).
    const mk = (offset: number) => {
      const swaps = [];
      for (let i = 0; i < 100; i++) {
        const price = 50 + 30 * Math.abs(Math.sin((i + offset) / 8));
        const tick = Math.round(-Math.log(price) / Math.log(1.0001));
        swaps.push({ id: `${i}`, timestamp: 1700000000 + i * 300, pool: '0xpool', tick, amount0: 10, amount1: 0.2, amountUSD: 0 });
      }
      return swaps;
    };
    const events = buildEvents(mk(0), mk(2));
    const res = replayEvents(events, DEFAULT_CONFIG);
    expect(res.swapsReplayed).toBeGreaterThan(0);
    expect(res.trades.length).toBeGreaterThanOrEqual(0);
    expect(res.winRate).toBeGreaterThanOrEqual(0);
    expect(res.winRate).toBeLessThanOrEqual(100);
  });
});

describe('supra reader', () => {
  // Fixed clock so age math is deterministic. NOW is a plausible "today" ms.
  const NOW = 1795430000000;
  const mkTuple = (over: Partial<{ round: bigint; decimals: bigint; time: bigint; price: bigint }> = {}) => ({
    round: 1794894663000n,
    decimals: 18n,
    time: BigInt(NOW - 3600_000), // 1h old
    price: 84260000000000000n, // 0.08426 * 1e18
    ...over,
  });
  const reader = (contract: SupraContractLike, maxAgeSec = 86400) =>
    new SupraReader(null, { contract, maxAgeSec, nowMs: () => NOW });

  it('fresh reading decodes correctly (decimals 18, time in ms)', async () => {
    const r = await reader({ getSvalue: async () => mkTuple() }).readPair(517);
    expect(r).not.toBeNull();
    expect(r!.pair).toBe(517);
    expect(r!.price).toBeCloseTo(0.08426, 5);
    expect(r!.decimals).toBe(18);
    expect(r!.timestampMs).toBe(NOW - 3600_000);
    expect(r!.ageSec).toBeCloseTo(3600, 0);
    expect(r!.fresh).toBe(true);
  });
  it('stale reading is flagged fresh=false, not dropped (caller treats as missing)', async () => {
    const r = await reader({ getSvalue: async () => mkTuple({ time: BigInt(NOW - 7 * 86400_000) }) }).readPair(517);
    expect(r).not.toBeNull();
    expect(r!.fresh).toBe(false);
    expect(r!.ageSec).toBeCloseTo(7 * 86400, 0);
    expect(r!.price).toBeCloseTo(0.08426, 5);
  });
  it('revert -> null', async () => {
    const r = await reader({ getSvalue: async () => { throw new Error('missing revert data'); } }).readPair(517);
    expect(r).toBeNull();
  });
  it('zero price -> null', async () => {
    const r = await reader({ getSvalue: async () => mkTuple({ price: 0n }) }).readPair(517);
    expect(r).toBeNull();
  });
  it('wrong decimals handled: 8-decimal feed decodes to the same human price', async () => {
    const r = await reader({ getSvalue: async () => mkTuple({ decimals: 8n, price: 8426000n }) }).readPair(517);
    expect(r).not.toBeNull();
    expect(r!.price).toBeCloseTo(0.08426, 5);
    expect(r!.decimals).toBe(8);
  });
  it('absurd decimals / future timestamp -> null', async () => {
    const badDec = await reader({ getSvalue: async () => mkTuple({ decimals: 100n }) }).readPair(517);
    expect(badDec).toBeNull();
    const future = await reader({ getSvalue: async () => mkTuple({ time: BigInt(NOW + 3600_000) }) }).readPair(517);
    expect(future).toBeNull();
  });
  it('custom maxAgeSec respected', async () => {
    const twoDays = { getSvalue: async () => mkTuple({ time: BigInt(NOW - 2 * 86400_000) }) };
    expect((await reader(twoDays, 86400).readPair(517))!.fresh).toBe(false);
    expect((await reader(twoDays, 7 * 86400).readPair(517))!.fresh).toBe(true);
  });
});

describe('supra signal component', () => {
  const base = { priceLowFee: 0.08, priceHighFee: 0.084, twapPrice: 0.082, volumeTrend: 1 };
  it('fresh reference below the pool adds points in the right direction', () => {
    // Mainnet-realistic: cheap pool 0.080 vs oracle 0.08426 -> -506 bps -> +~15 pts.
    const withSupra = scoreSignal({ ...base, supraPrice: 0.08426, supraStatus: 'fresh' });
    const without = scoreSignal({ ...base });
    expect(withSupra.components.supra).toBeGreaterThan(0);
    expect(withSupra.score).toBeGreaterThan(without.score);
    expect(withSupra.supraDeviationBps).toBeCloseTo(-506, 0);
  });
  it('fresh reference above the pool subtracts points', () => {
    // Cheap pool 0.090 vs oracle 0.08426 -> +681 bps -> ~-20 pts.
    const s = scoreSignal({ ...base, priceLowFee: 0.09, priceHighFee: 0.095, supraPrice: 0.08426, supraStatus: 'fresh' });
    expect(s.components.supra).toBeLessThan(0);
    expect(s.supraDeviationBps).toBeCloseTo(681, 0);
  });
  it('stale reference adds exactly 0 and says so', () => {
    const s = scoreSignal({ ...base, supraPrice: 0.08426, supraStatus: 'stale' });
    expect(s.components.supra).toBe(0);
    expect(s.supraDeviationBps).toBeNull();
    expect(s.reasons.join(' ')).toMatch(/STALE/);
  });
  it('missing reference adds exactly 0', () => {
    const s = scoreSignal({ ...base, supraPrice: 0, supraStatus: 'missing' });
    expect(s.components.supra).toBe(0);
    expect(s.supraDeviationBps).toBeNull();
  });
  it('testnet saturation: ~643x cheap-pool gap clamps at -30, raw bps journaled', () => {
    // Live testnet numbers 2026-11-23: 0.05% pool 78.24, 0.3% pool 54.18,
    // Supra HSK/USD 0.08426. Cheap pool is 643x the oracle.
    const s = scoreSignal({ priceLowFee: 78.24, priceHighFee: 54.18, twapPrice: 60, volumeTrend: 1, supraPrice: 0.08426, supraStatus: 'fresh' });
    expect(s.components.supra).toBe(-30);
    expect(s.supraDeviationBps).toBeCloseTo(6420374, -3); // ~6.42M bps, unclamped
    expect(s.reasons.join(' ')).toMatch(/SATURATED/);
    expect(s.reasons.join(' ')).toMatch(/643x/);
  });
  it('rebalanced weights still sum to a 0-100 score and spread alone cannot trade', () => {
    // Max spread (40) + max twap (15) + max volume (15) = 70 without supra;
    // spread alone (40) < 60 threshold.
    const spreadOnly = scoreSignal({ priceLowFee: 50, priceHighFee: 80, twapPrice: 0, volumeTrend: 1 });
    expect(spreadOnly.components.spread).toBe(40);
    expect(spreadOnly.score).toBe(40);
    expect(spreadOnly.score).toBeLessThan(60);
  });
});
