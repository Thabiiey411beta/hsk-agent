// Backtest: replay real testnet subgraph swap history through the SAME
// signal / sizing / risk code as the live agent. Two-pool replay: each event
// is a 0.05%-pool swap paired with the latest known 0.3%-pool price, so the
// cross-fee spread scored here is the REAL spread, not a proxy.
// Results are token-denominated paper numbers — NEVER presented as live profit.
//
// INTEGRATION PASS (2026-11-23): replayEvents now applies the trend gate and
// ATR sizing by default (same rules as the live agent). The old-pool events
// carry only ONE trailing TWAP (20-swap window), so the gate uses it as the
// 7d proxy and treats the 24h-vs-7d slope as flat (both proxies equal) —
// documented approximation; the price-vs-TWAP leg is the real check.
// ATR is computed from daily closes built from the event prices; the 101
// swaps span 365d in scattered bursts, so ATR is usually unavailable and the
// replay falls back to the fixed 2% stop — reported in the result, not hidden.
// A separate t-pool replay (replayTPoolEvents) replays the t-pool's own swap
// history through scoreTPoolSignal with trailing-TWAP proxies (labelled as
// proxies — live observe() TWAPs have no historical series).
// WEIGHTS (2026-11-23 audit): replayEvents accepts opts.weights 'v1' | 'v2'.
// v1 = original pre-Supra weights (spread 50 + TWAP 30 + volume 20), no
// gate and no ATR sizing by default (v1 predates both — that combination
// reproduces the recorded v1 baseline exactly: 8 trades, −42.73 USDT);
// v2 = current weights (spread 40 + Supra 30 + TWAP 15 + volume 15), gate
// on and ATR sizing on by default. The CLI exposes --weights v1|v2 plus
// --gate/--no-gate and --atr/--no-atr so every before/after number is
// re-runnable from shipped code. The backtest passes NO Supra reference,
// so the supra component scores 0 in both variants — the v1/v2 replay
// difference is the rebalance only.
import { fetchSwaps, type SwapRecord } from './subgraph.js';
import { tickToUsdtPerWhsk, tickToUsdtPerWhskGeneral, twap } from './math.js';
import { scoreSignal, scoreTPoolSignal, V1_WEIGHTS, V2_WEIGHTS } from './signal.js';
import { sizePosition } from './sizing.js';
import { buildDailyBars, computeAtr, sizeByAtr } from './atr.js';
import { checkTrendGate } from './trend.js';
import { checkRisk, newRiskState, resetDay } from './risk.js';
import { T_POOL } from './config.js';
import type { AgentConfig } from './config.js';

export interface BacktestTrade {
  ts: number;
  entryPrice: number;
  exitPrice: number;
  sizeUsdt: number;
  pnlUsdt: number;
  pnlPct: number;
  reason: string;
}

export interface BacktestResult {
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRate: number;
  totalPnlUsdt: number;
  totalPnlPct: number;
  signalsSeen: number;
  blocked: number;
  swapsReplayed: number;
  /** Entries blocked by the trend gate (new in the integration pass). */
  gateBlocked: number;
  /** True when ATR sizing was available for at least one trade. */
  atrUsed: boolean;
  /** Daily bars the ATR computation saw (0 when none built). */
  dailyBars: number;
  /** Signal-weight variant this replay ran under (auditability). 'tpool'
   *  = the t-pool signal weights (supra 30 + TWAP 45 + volume 25). */
  weights: 'v1' | 'v2' | 'tpool';
  /** Whether the trend gate was applied in this replay. */
  trendGate: boolean;
  /** Whether ATR sizing was enabled for this replay (it still only applies
   *  when >= 15 daily bars exist — see atrUsed). */
  atrSizing: boolean;
}

export interface BacktestEvent {
  ts: number;
  priceLowFee: number;
  priceHighFee: number;
  twapPrice: number;
  volumeTrend: number;
}

/** Build two-pool events from raw swaps of both pools. */
export function buildEvents(lowFeeSwaps: SwapRecord[], highFeeSwaps: SwapRecord[]): BacktestEvent[] {
  const low = [...lowFeeSwaps].sort((a, b) => a.timestamp - b.timestamp);
  const high = [...highFeeSwaps].sort((a, b) => a.timestamp - b.timestamp);
  const events: BacktestEvent[] = [];
  let hi = 0;
  let lastHighPrice = 0;
  for (let i = 0; i < low.length; i++) {
    const s = low[i];
    while (hi < high.length && high[hi].timestamp <= s.timestamp) {
      lastHighPrice = tickToUsdtPerWhsk(high[hi].tick);
      hi++;
    }
    if (lastHighPrice === 0) continue; // no high-fee price known yet
    const window = low.slice(Math.max(0, i - 20), i);
    const twapPrice = window.length >= 5 ? twap(window.map((w) => ({ t: w.timestamp, price: tickToUsdtPerWhsk(w.tick) }))) : 0;
    events.push({
      ts: s.timestamp,
      priceLowFee: tickToUsdtPerWhsk(s.tick),
      priceHighFee: lastHighPrice,
      twapPrice,
      volumeTrend: 1,
    });
  }
  return events;
}

/** Replay two-pool events through signal/sizing/risk.
 *  Integration pass: applies the trend gate (price >= trailing TWAP proxy;
 *  24h-vs-7d slope treated as flat — see header) and ATR sizing when the
 *  event series supports it, falling back to the fixed 2% stop otherwise.
 *  Options let a caller reproduce the pre-gate / pre-rebalance replay for
 *  comparison. `weights: 'v1'` is the ORIGINAL pre-Supra weights
 *  (spread 50 + TWAP 30 + volume 20, no Supra component) with the trend gate
 *  OFF and ATR sizing OFF by default — v1 predates both, and with those
 *  defaults the shipped code reproduces the recorded v1 baseline exactly
 *  (82 events, 8 trades, 0 wins, −42.73 USDT); `weights: 'v2'` (default)
 *  is the current weights (spread 40 + Supra 30 + TWAP 15 + volume 15)
 *  with the gate ON and ATR sizing ON by default. Pass `trendGate: false`
 *  explicitly with v2 to isolate the gate's effect (v2-no-gate), or
 *  `trendGate: true` with v1 to isolate the gate under the old weights,
 *  or `atrSizing: true` with v1 to see ATR sizing's effect on the v1
 *  baseline. The backtest passes NO Supra reference, so the supra
 *  component scores 0 in every variant — the v1/v2 difference in the
 *  replay is the spread/TWAP/volume rebalance only. */
export function replayEvents(
  events: BacktestEvent[],
  cfg: AgentConfig,
  opts: { trendGate?: boolean; atrSizing?: boolean; weights?: 'v1' | 'v2' } = {},
): BacktestResult {
  const weights = opts.weights ?? 'v2';
  // v1 predates the trend gate AND ATR sizing: default both OFF for v1,
  // ON for v2. An explicit option always wins over this default.
  const useGate = opts.trendGate ?? (weights === 'v2');
  const useAtr = opts.atrSizing ?? (weights === 'v2');
  const signalWeights = weights === 'v1' ? V1_WEIGHTS : V2_WEIGHTS;
  const risk = newRiskState(cfg.paperEquityUsdt);
  let equity = cfg.paperEquityUsdt;
  let day = new Date(events[0]?.ts * 1000 || Date.now()).toISOString().slice(0, 10);
  resetDay(risk, day);
  const trades: BacktestTrade[] = [];
  let blocked = 0;
  let gateBlocked = 0;
  let signalsSeen = 0;
  let atrUsed = false;
  const dailyBars = buildDailyBars(events.map((e) => ({ t: e.ts, price: e.priceLowFee })));
  const atr = useAtr ? computeAtr(dailyBars) : null;
  let open: { entryPrice: number; sizeUsdt: number; entryTs: number; age: number; stopFraction: number } | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const today = new Date(ev.ts * 1000).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      resetDay(risk, day);
      risk.equity = equity;
      risk.peakEquity = Math.max(risk.peakEquity, equity);
    }
    const price = ev.priceLowFee; // traded pool
    // NOTE: no historical Supra series exists, so the backtest calls
    // scoreSignal() WITHOUT a Supra reference — the supra component scores 0
    // (missing) for every event. Any backtest improvement comes from the
    // trend filter (separate work), NOT from Supra. Do not read Supra
    // benefit into backtest numbers.
    const signal = scoreSignal(
      {
        priceLowFee: ev.priceLowFee,
        priceHighFee: ev.priceHighFee,
        twapPrice: ev.twapPrice,
        volumeTrend: ev.volumeTrend,
      },
      signalWeights,
    );
    if (open) {
      open.age++;
      const pnlPct = (price - open.entryPrice) / open.entryPrice;
      const stopHit = pnlPct <= -open.stopFraction;
      const reverted = signal.score < cfg.minScore;
      const agedOut = open.age >= 50;
      if (stopHit || reverted || agedOut) {
        const pnl = open.sizeUsdt * pnlPct;
        equity += pnl;
        risk.equity = equity;
        risk.dailyPnl += pnl;
        risk.peakEquity = Math.max(risk.peakEquity, equity);
        trades.push({
          ts: ev.ts,
          entryPrice: open.entryPrice,
          exitPrice: price,
          sizeUsdt: open.sizeUsdt,
          pnlUsdt: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 10_000) / 100,
          reason: stopHit ? 'stop-loss' : reverted ? 'spread mean-reverted' : 'max holding window',
        });
        open = null;
      }
      continue;
    }
    if (signal.score < cfg.minScore) continue;
    signalsSeen++;
    // Trend gate (proxy: the event's trailing TWAP stands in for the 7d
    // observe() TWAP; slope leg is flat by construction — see header).
    if (useGate) {
      const gate = checkTrendGate({ price, twap24h: ev.twapPrice, twap7d: ev.twapPrice });
      if (!gate.pass) {
        gateBlocked++;
        continue;
      }
    }
    // Sizing: ATR when available (1% risk, stop = 2x ATR), else the fixed
    // 2% stop + cap sizing. ATR size is additionally capped by the
    // score-scaled cap size so a strong signal never overrules the caps.
    let sizeUsdt = 0;
    let stopFraction = cfg.stopLoss;
    if (atr !== null) {
      const a = sizeByAtr({
        equity,
        entryPrice: price,
        atr,
        perTradeCap: cfg.perTradeCap,
        dailyCap: cfg.dailyCap,
        deployedToday: risk.deployedToday,
      });
      if (!a.blocked) {
        atrUsed = true;
        const cap = sizePosition({
          equity,
          signalScore: signal.score,
          perTradeCap: cfg.perTradeCap,
          dailyCap: cfg.dailyCap,
          deployedToday: risk.deployedToday,
          riskAppetite: cfg.riskAppetite,
          minScore: cfg.minScore,
        });
        sizeUsdt = Math.min(a.sizeUsdt, cap.blocked ? a.sizeUsdt : cap.sizeUsdt);
        stopFraction = a.stopFraction;
      }
    }
    if (sizeUsdt <= 0) {
      const sizing = sizePosition({
        equity,
        signalScore: signal.score,
        perTradeCap: cfg.perTradeCap,
        dailyCap: cfg.dailyCap,
        deployedToday: risk.deployedToday,
        riskAppetite: cfg.riskAppetite,
        minScore: cfg.minScore,
      });
      if (sizing.blocked) {
        blocked++;
        continue;
      }
      sizeUsdt = sizing.sizeUsdt;
      stopFraction = cfg.stopLoss;
    }
    const gate = checkRisk(risk, cfg, { dataOk: true, today });
    if (!gate.pass) {
      blocked++;
      continue;
    }
    risk.deployedToday += sizeUsdt;
    open = { entryPrice: price, sizeUsdt, entryTs: ev.ts, age: 0, stopFraction };
  }
  if (open) {
    const last = events[events.length - 1].priceLowFee;
    const pnlPct = (last - open.entryPrice) / open.entryPrice;
    const pnl = open.sizeUsdt * pnlPct;
    equity += pnl;
    trades.push({
      ts: events[events.length - 1].ts,
      entryPrice: open.entryPrice,
      exitPrice: last,
      sizeUsdt: open.sizeUsdt,
      pnlUsdt: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 10_000) / 100,
      reason: 'mark-to-market at end of replay (not a real exit)',
    });
  }
  const wins = trades.filter((t) => t.pnlUsdt > 0).length;
  const losses = trades.filter((t) => t.pnlUsdt <= 0).length;
  return {
    trades,
    wins,
    losses,
    winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    totalPnlUsdt: Math.round((equity - cfg.paperEquityUsdt) * 100) / 100,
    totalPnlPct: Math.round(((equity - cfg.paperEquityUsdt) / cfg.paperEquityUsdt) * 10000) / 100,
    signalsSeen,
    blocked,
    swapsReplayed: events.length,
    gateBlocked,
    atrUsed,
    dailyBars: dailyBars.length,
    weights,
    trendGate: useGate,
    atrSizing: useAtr,
  };
}

// --- T-pool replay (integration pass) ---------------------------------------

export interface TPoolEvent {
  ts: number;
  price: number; // USDT per WHSK (tUSDT per tWHSK)
  /** Trailing 5-swap TWAP proxy for the 24h observe() TWAP, 0 if <5 samples. */
  twap24hProxy: number;
  /** Trailing 20-swap TWAP proxy for the 7d observe() TWAP, 0 if <5 samples. */
  twap7dProxy: number;
  volumeTrend: number;
}

/** Build t-pool events from raw t-pool swaps. Prices come from the tick with
 *  the t-pool's token order/decimals (token0 tWHSK 18 dec, token1 tUSDT 6 dec).
 *  TWAPs are trailing-swap proxies — the live observe() TWAP has no history
 *  to replay. Volume trend is 1 (sparse history; hourly buckets are empty). */
export function buildTPoolEvents(swaps: SwapRecord[]): TPoolEvent[] {
  const sorted = [...swaps].sort((a, b) => a.timestamp - b.timestamp);
  const events: TPoolEvent[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const price = tickToUsdtPerWhskGeneral(sorted[i].tick, false, 18, 6);
    const w5 = sorted.slice(Math.max(0, i - 4), i + 1);
    const w20 = sorted.slice(Math.max(0, i - 19), i + 1);
    const twapOf = (w: SwapRecord[]): number =>
      w.length >= 5
        ? twap(w.map((s) => ({ t: s.timestamp, price: tickToUsdtPerWhskGeneral(s.tick, false, 18, 6) })))
        : 0;
    events.push({ ts: sorted[i].timestamp, price, twap24hProxy: twapOf(w5), twap7dProxy: twapOf(w20), volumeTrend: 1 });
  }
  return events;
}

/** Replay t-pool events through scoreTPoolSignal + trend gate + ATR/fallback
 *  sizing. Expected honest outcome on the real history (26 swaps, 3 days):
 *  score 0 on every event (frozen price => TWAP deviation 0, no volume, no
 *  fresh Supra) => 0 trades. A 0-trade result here is the filter working,
 *  not a bug — do not tune parameters to manufacture trades. */
export function replayTPoolEvents(events: TPoolEvent[], cfg: AgentConfig): BacktestResult {
  const risk = newRiskState(cfg.paperEquityUsdt);
  let equity = cfg.paperEquityUsdt;
  let day = new Date(events[0]?.ts * 1000 || Date.now()).toISOString().slice(0, 10);
  resetDay(risk, day);
  const trades: BacktestTrade[] = [];
  let blocked = 0;
  let gateBlocked = 0;
  let signalsSeen = 0;
  let atrUsed = false;
  const dailyBars = buildDailyBars(events.map((e) => ({ t: e.ts, price: e.price })));
  const atr = computeAtr(dailyBars);
  let open: { entryPrice: number; sizeUsdt: number; entryTs: number; age: number; stopFraction: number } | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const today = new Date(ev.ts * 1000).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      resetDay(risk, day);
      risk.equity = equity;
      risk.peakEquity = Math.max(risk.peakEquity, equity);
    }
    const signal = scoreTPoolSignal({
      price: ev.price,
      twap24h: ev.twap24hProxy,
      twap7d: ev.twap7dProxy,
      volumeTrend: ev.volumeTrend,
    });
    if (open) {
      open.age++;
      const pnlPct = (ev.price - open.entryPrice) / open.entryPrice;
      const stopHit = pnlPct <= -open.stopFraction;
      const reverted = signal.score < cfg.minScore;
      const agedOut = open.age >= 50;
      if (stopHit || reverted || agedOut) {
        const pnl = open.sizeUsdt * pnlPct;
        equity += pnl;
        risk.equity = equity;
        risk.dailyPnl += pnl;
        risk.peakEquity = Math.max(risk.peakEquity, equity);
        trades.push({
          ts: ev.ts,
          entryPrice: open.entryPrice,
          exitPrice: ev.price,
          sizeUsdt: open.sizeUsdt,
          pnlUsdt: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 10_000) / 100,
          reason: stopHit ? 'stop-loss' : reverted ? 'spread mean-reverted' : 'max holding window',
        });
        open = null;
      }
      continue;
    }
    if (signal.score < cfg.minScore) continue;
    signalsSeen++;
    const gate = checkTrendGate({ price: ev.price, twap24h: ev.twap24hProxy, twap7d: ev.twap7dProxy });
    if (!gate.pass) {
      gateBlocked++;
      continue;
    }
    let sizeUsdt = 0;
    let stopFraction = cfg.stopLoss;
    if (atr !== null) {
      const a = sizeByAtr({ equity, entryPrice: ev.price, atr, perTradeCap: cfg.perTradeCap, dailyCap: cfg.dailyCap, deployedToday: risk.deployedToday });
      if (!a.blocked) {
        atrUsed = true;
        sizeUsdt = a.sizeUsdt;
        stopFraction = a.stopFraction;
      }
    }
    if (sizeUsdt <= 0) {
      const sizing = sizePosition({
        equity,
        signalScore: signal.score,
        perTradeCap: cfg.perTradeCap,
        dailyCap: cfg.dailyCap,
        deployedToday: risk.deployedToday,
        riskAppetite: cfg.riskAppetite,
        minScore: cfg.minScore,
      });
      if (sizing.blocked) {
        blocked++;
        continue;
      }
      sizeUsdt = sizing.sizeUsdt;
    }
    const riskGate = checkRisk(risk, cfg, { dataOk: true, today });
    if (!riskGate.pass) {
      blocked++;
      continue;
    }
    risk.deployedToday += sizeUsdt;
    open = { entryPrice: ev.price, sizeUsdt, entryTs: ev.ts, age: 0, stopFraction };
  }
  if (open) {
    const last = events[events.length - 1].price;
    const pnlPct = (last - open.entryPrice) / open.entryPrice;
    const pnl = open.sizeUsdt * pnlPct;
    equity += pnl;
    trades.push({
      ts: events[events.length - 1].ts,
      entryPrice: open.entryPrice,
      exitPrice: last,
      sizeUsdt: open.sizeUsdt,
      pnlUsdt: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 10_000) / 100,
      reason: 'mark-to-market at end of replay (not a real exit)',
    });
  }
  const wins = trades.filter((t) => t.pnlUsdt > 0).length;
  const losses = trades.filter((t) => t.pnlUsdt <= 0).length;
  return {
    trades,
    wins,
    losses,
    winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : 0,
    totalPnlUsdt: Math.round((equity - cfg.paperEquityUsdt) * 100) / 100,
    totalPnlPct: Math.round(((equity - cfg.paperEquityUsdt) / cfg.paperEquityUsdt) * 10000) / 100,
    signalsSeen,
    blocked,
    swapsReplayed: events.length,
    gateBlocked,
    atrUsed,
    dailyBars: dailyBars.length,
    weights: 'tpool',
    trendGate: true,
    atrSizing: true,
  };
}

/** Fetch the t-pool's full swap history and replay it (see replayTPoolEvents). */
export async function runTPoolBacktest(cfg: AgentConfig): Promise<BacktestResult> {
  const all: SwapRecord[] = [];
  let skip = 0;
  for (;;) {
    const batch = await fetchSwaps(T_POOL.id, 1000, skip);
    if (batch.length === 0) break;
    all.push(...batch);
    skip += batch.length;
    if (batch.length < 1000) break;
  }
  return replayTPoolEvents(buildTPoolEvents(all), cfg);
}

export async function runBacktest(
  cfg: AgentConfig,
  poolId: string,
  days = 30,
  opts: { trendGate?: boolean; atrSizing?: boolean; weights?: 'v1' | 'v2' } = {},
): Promise<BacktestResult> {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  async function fetchAll(id: string): Promise<SwapRecord[]> {
    const all: SwapRecord[] = [];
    let skip = 0;
    for (;;) {
      const batch = await fetchSwaps(id, 1000, skip);
      if (batch.length === 0) break;
      all.push(...batch);
      skip += batch.length;
      if (batch.length < 1000 || skip > 5000) break;
    }
    return all.filter((s) => s.timestamp >= since);
  }
  const lowFee = await fetchAll(poolId);
  // Second pool: the other USDT/WHSK pool.
  const otherId =
    poolId === '0xff2b7e501c870980bf5641b4a70d0f9fb0f6f6ab'
      ? '0xc076fb478b77633736738579c7f48d2539604a50'
      : '0xff2b7e501c870980bf5641b4a70d0f9fb0f6f6ab';
  const highFee = await fetchAll(otherId);
  const events = buildEvents(lowFee, highFee);
  return replayEvents(events, cfg, opts);
}
