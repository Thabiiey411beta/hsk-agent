// Trend gate (researcher D's rules, adapted to what exists on-chain).
// Pure functions — same code path in live agent and backtest.
//
// GATE (hard, before ANY long entry — a safety rule, NOT a user toggle):
//   1. price >= 7d observe() TWAP — the market is not below its long average.
//   2. 24h observe() TWAP >= 7d observe() TWAP — the recent average is not
//      falling below the long average (flat/rising slope proxy).
//
// ADAPTATIONS (documented, deliberate):
//   - D specified price > TWAP30 and slope(TWAP30) >= 0. A 30d window reverts
//     OLD on every pool (oldest observation ~22d; the t-pool is <30d old),
//     so 7d is the longest honest window. Comparing TWAP-now vs TWAP-7d-ago
//     is impossible from a single observe() window, so the slope is proxied
//     by 24h TWAP vs 7d TWAP: a falling market has 24h TWAP < 7d TWAP.
//   - The comparison is >=, not strict >. On a frozen pool price == TWAP
//     exactly; strict > could never pass until someone else trades and moves
//     the price, which would make the gate a permanent veto on a quiet
//     market. >= means "not in a downtrend" — flat counts as not-falling.
//     The gate is a veto on downtrends, not a momentum trigger.
//   - Missing TWAP data FAILS the gate (fail-closed): no reference, no entry.
//   - The signal's TWAP component scores price vs the 24h TWAP (short-term
//     mean reversion), NOT the 7d TWAP. Scoring vs 7d while gating on
//     price >= 7d TWAP would cap the score at 55 whenever the gate passes
//     (supra 30 + volume 25, twap <= 0) — threshold 60 unreachable by
//     construction. The 7d deviation is still reported as a diagnostic.
//     Coherent synthesis: buy a short-term dip (price < 24h TWAP) inside a
//     flat-or-rising long trend (price >= 7d TWAP, 24h TWAP >= 7d TWAP).
//
// ADX(14): D's rule also wants ADX(14) < 25 (no strong trend — mean reversion
// only makes sense when the market is not strongly trending). ADX needs >= 15
// daily bars. The t-pool has 3 days of swap history (26 swaps, Nov 2-4 2026),
// so ADX is NOT computable and is SKIPPED — never faked. canComputeAdx()
// is the check; when bars are available the gate additionally requires
// adx < 25. The agent journals the skip with the bar count.
import { twapDeviationBps } from './math.js';

export const ADX_PERIOD = 14;
/** Daily bars needed for ADX(14): 14 periods + 1 prior close. */
export const ADX_MIN_BARS = ADX_PERIOD + 1;
/** ADX below this = no strong trend (D's rule for mean-reversion entries). */
export const ADX_MAX_FOR_ENTRY = 25;

export interface TrendGateInput {
  /** Current spot price (USDT per WHSK). */
  price: number;
  /** 24h observe() TWAP, 0 / missing when unavailable. */
  twap24h: number;
  /** 7d observe() TWAP, 0 / missing when unavailable. */
  twap7d: number;
  /** ADX(14) when computable, null when skipped (too few bars). */
  adx?: number | null;
}

export interface TrendGateResult {
  pass: boolean;
  reasons: string[];
  /** Price vs 7d TWAP, bps (null when TWAP missing). */
  priceVsTwap7dBps: number | null;
  /** 24h TWAP vs 7d TWAP, bps (null when TWAP missing). */
  twapSlopeBps: number | null;
  /** Whether ADX was available and applied. */
  adxApplied: boolean;
}

/** Hard trend gate. Missing TWAP data fails closed. */
export function checkTrendGate(input: TrendGateInput): TrendGateResult {
  const reasons: string[] = [];
  if (!(input.twap7d > 0) || !(input.twap24h > 0) || !(input.price > 0)) {
    return {
      pass: false,
      reasons: ['trend gate BLOCKED: missing TWAP data (7d or 24h observe() unavailable) — fail-closed'],
      priceVsTwap7dBps: null,
      twapSlopeBps: null,
      adxApplied: false,
    };
  }
  const priceVsTwap7dBps = twapDeviationBps(input.price, input.twap7d);
  const twapSlopeBps = twapDeviationBps(input.twap24h, input.twap7d);
  const aboveLong = input.price >= input.twap7d;
  const slopeOk = input.twap24h >= input.twap7d;
  if (aboveLong) reasons.push(`price ${input.price.toFixed(6)} >= 7d TWAP ${input.twap7d.toFixed(6)} (${priceVsTwap7dBps.toFixed(0)} bps)`);
  else reasons.push(`price ${input.price.toFixed(6)} BELOW 7d TWAP ${input.twap7d.toFixed(6)} (${priceVsTwap7dBps.toFixed(0)} bps) — downtrend, no long entry`);
  if (slopeOk) reasons.push(`24h TWAP ${input.twap24h.toFixed(6)} >= 7d TWAP ${input.twap7d.toFixed(6)} (${twapSlopeBps.toFixed(0)} bps) — slope flat/rising`);
  else reasons.push(`24h TWAP ${input.twap24h.toFixed(6)} BELOW 7d TWAP ${input.twap7d.toFixed(6)} (${twapSlopeBps.toFixed(0)} bps) — falling, no long entry`);
  let adxApplied = false;
  let adxOk = true;
  if (input.adx !== undefined && input.adx !== null) {
    adxApplied = true;
    adxOk = input.adx < ADX_MAX_FOR_ENTRY;
    reasons.push(
      adxOk
        ? `ADX(14) ${input.adx.toFixed(1)} < ${ADX_MAX_FOR_ENTRY} — no strong trend`
        : `ADX(14) ${input.adx.toFixed(1)} >= ${ADX_MAX_FOR_ENTRY} — strongly trending, no mean-reversion entry`,
    );
  } else {
    reasons.push('ADX(14) skipped: too few daily bars to compute (need 15) — not faked');
  }
  return { pass: aboveLong && slopeOk && adxOk, reasons, priceVsTwap7dBps, twapSlopeBps, adxApplied };
}

/** True when enough daily bars exist to compute ADX(14). */
export function canComputeAdx(dailyBarCount: number): boolean {
  return dailyBarCount >= ADX_MIN_BARS;
}
