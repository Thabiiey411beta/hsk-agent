import { describe, expect, it } from 'vitest';
import { scoreSignal, V1_WEIGHTS, V2_WEIGHTS } from '../src/signal.js';
import { replayEvents, type BacktestEvent } from '../src/backtest.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// Fixture: cheap pool far below the expensive pool AND far below TWAP.
// spread ~-4400 bps (full spread component), cheap-vs-TWAP ~-1667 bps
// (full TWAP component), flat volume (0 pts), no Supra reference (0 pts).
//   v1: 50 + 30 = 80  (>= 60 threshold — trades)
//   v2: 40 + 15 = 55  (< 60 threshold — no trade)
// The ONLY difference is the weights: same input, same formulas.
const STRONG_INPUT = {
  priceLowFee: 50,
  priceHighFee: 78.24,
  twapPrice: 60,
  volumeTrend: 1,
};

describe('scoreSignal weights option', () => {
  it('v1 and v2 give different scores on the same fixture (80 vs 55)', () => {
    const v1 = scoreSignal(STRONG_INPUT, V1_WEIGHTS);
    const v2 = scoreSignal(STRONG_INPUT, V2_WEIGHTS);
    expect(v1.score).toBe(80);
    expect(v2.score).toBe(55);
    expect(v1.components).toEqual({ spread: 50, supra: 0, twap: 30, volume: 0 });
    expect(v2.components).toEqual({ spread: 40, supra: 0, twap: 15, volume: 0 });
  });

  it('default weights are v2 (current)', () => {
    expect(scoreSignal(STRONG_INPUT).score).toBe(55);
    expect(scoreSignal(STRONG_INPUT).components.spread).toBe(40);
  });

  it('v1 has no supra component even with a fresh oracle reading', () => {
    const withSupra = { ...STRONG_INPUT, supraPrice: 0.08426, supraStatus: 'fresh' as const };
    // Cheap pool (50) is far ABOVE the oracle (0.08426): supra saturates
    // negative under v2, but under v1 the component does not exist.
    expect(scoreSignal(withSupra, V1_WEIGHTS).components.supra).toBe(0);
    expect(scoreSignal(withSupra, V1_WEIGHTS).score).toBe(80);
    expect(scoreSignal(withSupra, V2_WEIGHTS).components.supra).toBe(-30);
    expect(scoreSignal(withSupra, V2_WEIGHTS).score).toBe(25);
  });

  it('v1 weights sum to 100 and v2 weights sum to 100', () => {
    const sum = (w: typeof V1_WEIGHTS) => w.spread + w.supra + w.twap + w.volume;
    expect(sum(V1_WEIGHTS)).toBe(100);
    expect(sum(V2_WEIGHTS)).toBe(100);
  });
});

// Synthetic falling series: price slides 78 -> 50 while the trailing TWAP
// proxy stays 25% above the price (price below its long average — a
// collapsing market, the shape of the real v1 losing trades). The spread
// vs the 78.24 pool grows as the price falls, so the score clears 60
// under v1 but caps at 55 under v2.
function fallingEvents(): BacktestEvent[] {
  const events: BacktestEvent[] = [];
  for (let i = 0; i < 30; i++) {
    const price = 78 - (28 * i) / 29;
    events.push({
      ts: 1700000000 + i * 3600,
      priceLowFee: price,
      priceHighFee: 78.24,
      twapPrice: price * 1.25,
      volumeTrend: 1,
    });
  }
  return events;
}

describe('replayEvents weights + gate options', () => {
  it('v1 (no gate by default) trades on the falling series; v2 does not', () => {
    const events = fallingEvents();
    const v1 = replayEvents(events, DEFAULT_CONFIG, { weights: 'v1' });
    const v2 = replayEvents(events, DEFAULT_CONFIG, { weights: 'v2' });
    expect(v1.weights).toBe('v1');
    expect(v1.trendGate).toBe(false);
    expect(v1.signalsSeen).toBeGreaterThan(0);
    expect(v1.trades.length).toBeGreaterThan(0);
    expect(v2.weights).toBe('v2');
    expect(v2.trendGate).toBe(true);
    expect(v2.signalsSeen).toBe(0);
    expect(v2.trades.length).toBe(0);
  });

  it('v1 + gate ON: the gate vetoes every v1 signal (synthetic demo of the veto)', () => {
    const events = fallingEvents();
    const gated = replayEvents(events, DEFAULT_CONFIG, { weights: 'v1', trendGate: true });
    const ungated = replayEvents(events, DEFAULT_CONFIG, { weights: 'v1', trendGate: false });
    expect(gated.trendGate).toBe(true);
    // The gated run never opens a position, so it evaluates (and counts)
    // every signal event; the ungated run opens positions, and events while
    // a position is open are exits, not new signals — so gated counts MORE.
    expect(gated.signalsSeen).toBeGreaterThanOrEqual(ungated.signalsSeen);
    expect(gated.signalsSeen).toBeGreaterThan(0);
    // Price is below its TWAP proxy on every signal event -> gate blocks all.
    expect(gated.gateBlocked).toBe(gated.signalsSeen);
    expect(gated.trades.length).toBe(0);
    expect(ungated.trades.length).toBeGreaterThan(0);
  });

  it('v2-no-gate isolates the gate: same 0 trades as v2-with-gate (nothing reaches the gate)', () => {
    const events = fallingEvents();
    const gated = replayEvents(events, DEFAULT_CONFIG, { weights: 'v2', trendGate: true });
    const noGate = replayEvents(events, DEFAULT_CONFIG, { weights: 'v2', trendGate: false });
    expect(noGate.trendGate).toBe(false);
    expect(noGate.signalsSeen).toBe(0);
    expect(noGate.gateBlocked).toBe(0);
    expect(noGate.trades.length).toBe(0);
    expect(gated.trades.length).toBe(0);
    // On THIS fixture the gate is untestable under v2: the rebalance alone
    // already keeps the score below threshold. The gate's veto is only
    // demonstrable under v1 weights (test above) or in trend.test.ts.
  });

  it('default replay (no opts) is v2 with the gate on', () => {
    const res = replayEvents(fallingEvents(), DEFAULT_CONFIG);
    expect(res.weights).toBe('v2');
    expect(res.trendGate).toBe(true);
    expect(res.atrSizing).toBe(true);
    expect(res.trades.length).toBe(0);
  });

  it('v1 defaults are gate OFF and ATR sizing OFF (v1 predates both)', () => {
    const res = replayEvents(fallingEvents(), DEFAULT_CONFIG, { weights: 'v1' });
    expect(res.weights).toBe('v1');
    expect(res.trendGate).toBe(false);
    expect(res.atrSizing).toBe(false);
  });
});
