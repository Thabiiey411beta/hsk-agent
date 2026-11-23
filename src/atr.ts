// ATR volatility-adjusted sizing (researcher D's rules). Pure functions.
//
//   1% equity risk per trade, stop = 2 x ATR(14) on daily log-return bars,
//   gap-aware true range: TR = max(high-low, |high-prevClose|, |low-prevClose|).
//
// DATA HONESTY: daily bars are built from subgraph swap ticks — the only price
// observations that exist. A day's high/low are the max/min OBSERVED swap
// prices that day (a lower bound on the true range; unobserved intra-day
// moves are invisible). With < 15 daily bars ATR(14) cannot be computed and
// the caller MUST fall back to the fixed 2% stop + cap sizing (sizePosition)
// and journal the fallback. The t-pool has 3 daily bars (Nov 2-4 2026), so
// live ATR is unavailable; the old pools' 101 swaps over 365d give only
// ~30-40 scattered daily closes, so the backtest also falls back most of the
// time. ATR is wired in and used whenever the data genuinely supports it —
// never extrapolated from 3 bars.
import { clamp } from './math.js';

export const ATR_PERIOD = 14;
/** Daily bars needed: 14 TR values need 15 closes (first TR needs a prior close). */
export const ATR_MIN_BARS = ATR_PERIOD + 1;
/** Equity risked per trade under ATR sizing (1%). */
export const ATR_RISK_FRACTION = 0.01;
/** Stop distance in ATR multiples (2x). */
export const ATR_STOP_MULTIPLIER = 2;

export interface PriceSample {
  t: number; // unix seconds
  price: number; // USDT per WHSK
}

export interface DailyBar {
  day: string; // YYYY-MM-DD (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Group swap-price samples into UTC daily bars (open = first, close = last,
 *  high/low = observed extremes). Returns bars sorted by day. */
export function buildDailyBars(samples: PriceSample[]): DailyBar[] {
  const byDay = new Map<string, PriceSample[]>();
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    if (!(s.price > 0)) continue;
    const day = new Date(s.t * 1000).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(s);
    byDay.set(day, arr);
  }
  const bars: DailyBar[] = [];
  for (const [day, arr] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    bars.push({
      day,
      open: arr[0].price,
      high: Math.max(...arr.map((x) => x.price)),
      low: Math.min(...arr.map((x) => x.price)),
      close: arr[arr.length - 1].price,
    });
  }
  return bars;
}

/** Gap-aware true range for one bar given the previous close. */
export function trueRange(bar: DailyBar, prevClose: number): number {
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** Wilder's ATR(14) over daily bars. Returns null when fewer than 15 bars
 *  (cannot form 14 true ranges) — the caller falls back, never guesses. */
export function computeAtr(bars: DailyBar[], period: number = ATR_PERIOD): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) trs.push(trueRange(bars[i], bars[i - 1].close));
  if (trs.length < period) return null;
  // Wilder's smoothing: first ATR = mean of first `period` TRs, then
  // ATR = (prevATR * (period-1) + TR) / period.
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

export interface AtrSizeInput {
  equity: number; // USDT
  entryPrice: number; // USDT per WHSK
  atr: number; // USDT per WHSK (same units as price)
  riskFraction?: number; // default 0.01 (1% of equity)
  stopMultiplier?: number; // default 2 (stop = 2x ATR below entry)
  perTradeCap: number; // fraction of equity (hard cap)
  dailyCap: number; // fraction of equity
  deployedToday: number; // USDT already deployed today
}

export interface AtrSizeResult {
  sizeUsdt: number;
  stopPrice: number;
  stopFraction: number;
  atr: number;
  blocked: boolean;
  reason: string;
}

/** Volatility-adjusted size: risk 1% of equity, stop 2x ATR below entry.
 *  size = riskUsdt / stopFraction, then capped by per-trade cap and daily
 *  headroom. A stop >= entry (ATR >= entry/2) or a non-positive size blocks. */
export function sizeByAtr(input: AtrSizeInput): AtrSizeResult {
  const riskFraction = input.riskFraction ?? ATR_RISK_FRACTION;
  const mult = input.stopMultiplier ?? ATR_STOP_MULTIPLIER;
  const atr = input.atr;
  if (!(atr > 0) || !(input.entryPrice > 0)) {
    return { sizeUsdt: 0, stopPrice: 0, stopFraction: 0, atr, blocked: true, reason: 'ATR sizing blocked: missing ATR or entry price' };
  }
  const stopDistance = mult * atr;
  if (stopDistance >= input.entryPrice) {
    return { sizeUsdt: 0, stopPrice: 0, stopFraction: 0, atr, blocked: true, reason: `ATR sizing blocked: 2x ATR (${stopDistance.toFixed(6)}) >= entry price — stop would be <= 0` };
  }
  const stopPrice = input.entryPrice - stopDistance;
  const stopFraction = stopDistance / input.entryPrice;
  const riskUsdt = riskFraction * input.equity;
  const rawSize = riskUsdt / stopFraction;
  const capSize = input.perTradeCap * input.equity;
  const dailyHeadroom = input.dailyCap * input.equity - input.deployedToday;
  if (dailyHeadroom <= 0) {
    return { sizeUsdt: 0, stopPrice, stopFraction, atr, blocked: true, reason: `ATR sizing blocked: daily cap reached (deployed ${input.deployedToday.toFixed(2)} of ${(input.dailyCap * input.equity).toFixed(2)} USDT)` };
  }
  const size = Math.min(rawSize, capSize, dailyHeadroom);
  if (size <= 0) {
    return { sizeUsdt: 0, stopPrice, stopFraction, atr, blocked: true, reason: 'ATR sizing blocked: computed size is zero' };
  }
  return {
    sizeUsdt: Math.round(size * 100) / 100,
    stopPrice,
    stopFraction,
    atr,
    blocked: false,
    reason: `ATR size ${size.toFixed(2)} USDT = risk ${(riskUsdt).toFixed(2)} / stop ${(stopFraction * 100).toFixed(2)}% (2x ATR ${atr.toFixed(6)}), capped at ${Math.min(capSize, dailyHeadroom).toFixed(2)}`,
  };
}

/** Clamp helper re-export for callers that scale ATR size by signal score. */
export function clampSize(size: number, max: number): number {
  return clamp(size, 0, max);
}
