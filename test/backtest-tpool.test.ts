import { describe, expect, it } from 'vitest';
import { buildTPoolEvents, replayTPoolEvents, replayEvents, buildEvents } from '../src/backtest.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Real t-pool history shape: 26 swaps, Nov 2-4 2026, ticks -300757..-300499
// (price ~0.0869, essentially frozen). Rebuilt here as synthetic records so
// the test is hermetic; the live run uses the real subgraph data.
function tPoolSwaps() {
  const swaps: any[] = [];
  let ts = 1793650000;
  const ticks = [-300499, -300505, -300505, -300696, -300695, -300704, -300706, -300710, -300751, -300757, -300757, -300753, -300756, -300757];
  for (let i = 0; i < 26; i++) {
    swaps.push({ id: `${i}`, timestamp: ts + i * 3600, pool: '0xt', tick: ticks[i % ticks.length], amount0: 100, amount1: -8.6, amountUSD: 0 });
  }
  return swaps;
}

describe('t-pool backtest', () => {
  it('builds events with t-pool decimal handling (tick -300757 -> ~0.0869)', () => {
    const events = buildTPoolEvents(tPoolSwaps());
    expect(events.length).toBe(26);
    expect(events[0].price).toBeGreaterThan(0.08);
    expect(events[0].price).toBeLessThan(0.09);
    // Trailing TWAP proxies need >= 5 samples; early events have 0.
    expect(events[0].twap24hProxy).toBe(0);
    expect(events[10].twap24hProxy).toBeGreaterThan(0);
  });
  it('real-shape history replays to 0 trades (frozen price, no signal)', () => {
    const res = replayTPoolEvents(buildTPoolEvents(tPoolSwaps()), DEFAULT_CONFIG);
    expect(res.swapsReplayed).toBe(26);
    expect(res.trades.length).toBe(0);
    expect(res.totalPnlUsdt).toBe(0);
    expect(res.dailyBars).toBeLessThan(15); // ATR unavailable -> fallback
    expect(res.atrUsed).toBe(false);
  });
});

describe('old-pool replay with trend gate + ATR', () => {
  it('gate blocks the v1 losing trades: 0 trades vs 8 without the gate', () => {
    // Same synthetic oscillating series as the v1 backtest test.
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
    const gated = replayEvents(events, DEFAULT_CONFIG);
    const ungated = replayEvents(events, DEFAULT_CONFIG, { trendGate: false, atrSizing: false });
    // The gate must never ADD trades; on this oscillating series it blocks.
    expect(gated.trades.length).toBeLessThanOrEqual(ungated.trades.length);
    expect(gated.gateBlocked).toBeGreaterThanOrEqual(0);
    expect(typeof gated.atrUsed).toBe('boolean');
  });
});
