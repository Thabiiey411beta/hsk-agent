// Signal scoring: cross-fee-tier spread + Supra oracle reference + TWAP deviation
// + volume trend. Pure function — same code path in live agent and backtest.
//
// WEIGHTS (rebalanced 2026-11-23 when the Supra component was added; total 100):
//   spread 40 — the primary, directly tradable edge: the same pair priced
//     differently in the two fee tiers. Kept largest because it is measured
//     between two live pools, not against any external assumption.
//   supra  30 — external anchor: is the cheap pool actually cheap vs the
//     wider market (Supra HSK/USD), or just cheap vs the other pool? A fresh
//     oracle reading that agrees the pool is underpriced adds conviction;
//     one that says the pool is overpriced subtracts it. Only scores when
//     the reading is FRESH — stale/missing scores 0 (fail-closed).
//   twap   15 — on-chain history is sparse on testnet (last swap ~Nov 1),
//     so TWAP is a weak, slow signal; demoted from 30.
//   volume 15 — rising swap activity is weak confirmation; demoted from 20.
// Threshold 60 stays meaningful: spread alone (max 40) can never trigger a
// trade — at least one conviction component must agree.
//
// V1 WEIGHTS (pre-2026-11-23, before Supra existed): spread 50 + twap 30 +
// volume 20 = 100, no Supra component. Source: the phase-2 upgrade report
// (§1, §7) and DESIGN.md — there is NO git history in this repo to check
// against, so the v1 reconstruction is: the SAME component formulas as
// below, only the maxima differ (50/30/20) and the Supra component is
// absent (weight 0). The backtest reproduces the recorded v1 baseline
// (8 trades, −42.73 USDT) with these weights — see backtest-audit-20261123.md
// — which corroborates the reconstruction, but it is a reconstruction,
// not a checkout of v1 code. Do not present it as otherwise.
export interface SignalWeights {
  spread: number;
  supra: number;
  twap: number;
  volume: number;
}

/** Pre-Supra weights: spread 50 + TWAP 30 + volume 20, no oracle component. */
export const V1_WEIGHTS: SignalWeights = { spread: 50, supra: 0, twap: 30, volume: 20 };
/** Current weights: spread 40 + Supra 30 + TWAP 15 + volume 15. */
export const V2_WEIGHTS: SignalWeights = { spread: 40, supra: 30, twap: 15, volume: 15 };
//
// SUPRA SATURATION (testnet, verified 2026-11-23): pool WHSK trades at
// ~54.18 USDT/WHSK (0.3% pool) to ~78.24 USDT/WHSK (0.05% pool) while Supra
// HSK/USD reads $0.08426 — a ~643x gap on the cheap pool (~6,420,000 bps)
// and ~928x on the expensive pool (~9,280,000 bps). Testnet WHSK is
// synthetic and detached from the real HSK price (consistent with the v1
// backtest: WHSK "collapsed" 6,363 -> 78 USDT/WHSK and is still ~928x off).
// The deviation is CLAMPED, so the component saturates at its max magnitude
// (-30 on testnet, because the pool is far ABOVE the oracle: buying at 643x
// fair value is the wrong side). Do NOT retune this to look reasonable on
// testnet numbers: on mainnet, where pool and oracle agree within a few %,
// the same code behaves normally (small deviations -> small scores). The raw
// deviation in bps is journaled unclamped so the saturation is visible,
// not hidden.
// Unit check: 1.0001^tick is WHSK per USDT (tick -43600 -> 0.0128), and the
// agent inverts it to USDT per WHSK (78.24). A "0.012781 USDT per WHSK"
// TWAP is that same inversion error — the agent's price handling is correct.
import { clamp, spreadBps, twapDeviationBps } from './math.js';

export interface SignalInput {
  /** USDT per WHSK in the 0.05% pool */
  priceLowFee: number;
  /** USDT per WHSK in the 0.3% pool */
  priceHighFee: number;
  /** TWAP (USDT per WHSK) over the lookback window, 0 if unavailable */
  twapPrice: number;
  /** swaps in the last hour vs previous hour, as a ratio (1.0 = flat) */
  volumeTrend: number;
  /**
   * FRESH Supra HSK/USD reference price (USD per HSK). Pass 0 / omit when the
   * reading is stale or missing — the component then scores 0. HSK ≈ WHSK
   * 1:1 and USDT ≈ USD 1:1, so the pool price (USDT/WHSK) is directly
   * comparable to this reference (documented approximation).
   */
  supraPrice?: number;
  /** Freshness of the Supra reading; anything other than 'fresh' scores 0. */
  supraStatus?: 'fresh' | 'stale' | 'missing';
}

export interface Signal {
  score: number; // 0-100
  direction: 'buy-whsk' | 'sell-whsk' | 'none';
  components: { spread: number; supra: number; twap: number; volume: number };
  reasons: string[];
  spreadBps: number;
  twapDeviationBps: number;
  /** Raw pool-vs-Supra deviation in bps (unclamped; null when no reference). */
  supraDeviationBps: number | null;
}

export function scoreSignal(input: SignalInput, weights: SignalWeights = V2_WEIGHTS): Signal {
  const reasons: string[] = [];
  const spread = spreadBps(input.priceLowFee, input.priceHighFee);
  // Spread component: 0 at <100bps, full points at >=2000bps (20%).
  const spreadScore = clamp((Math.abs(spread) - 100) / (2000 - 100), 0, 1) * weights.spread;

  // Supra component: up to +/-`weights.supra` pts. Deviation in the SAME direction as the
  // spread adds conviction; against it subtracts. Only when the reading is
  // FRESH — stale/missing scores exactly 0 and the reason says why.
  // Full `weights.supra` pts at >=1000bps (10%) deviation; clamps beyond that, so the
  // ~6,420,000 bps testnet gap (cheap pool vs oracle) saturates at -30
  // (pool far above oracle).
  let supraScore = 0;
  let supraDev: number | null = null;
  const cheapPrice = Math.min(input.priceLowFee, input.priceHighFee);
  const supraFresh =
    (input.supraPrice ?? 0) > 0 && (input.supraStatus ?? 'fresh') === 'fresh';
  if (supraFresh) {
    supraDev = twapDeviationBps(cheapPrice, input.supraPrice as number);
    // Cheap pool below the oracle reference = underpriced vs the wider
    // market -> mean-reversion upside, adds up to `weights.supra` pts.
    supraScore = clamp(-supraDev / 1000, -1, 1) * weights.supra;
  }

  // TWAP component: up to `weights.twap` pts. Deviation in the SAME direction as the
  // spread adds conviction; against it subtracts.
  let twapScore = 0;
  const cheapDev = twapDeviationBps(cheapPrice, input.twapPrice);
  if (input.twapPrice > 0) {
    // Cheap pool below TWAP = mean-reversion upside -> adds up to `weights.twap` pts.
    twapScore = clamp(-cheapDev / 1000, -1, 1) * weights.twap;
  }

  // Volume component: up to `weights.volume` pts for rising activity.
  const volumeScore = clamp((input.volumeTrend - 1) / 1, 0, 1) * weights.volume;

  const score = clamp(Math.round(spreadScore + supraScore + twapScore + volumeScore), 0, 100);

  if (Math.abs(spread) >= 100) {
    reasons.push(
      `cross-fee spread ${spread.toFixed(0)} bps between 0.05% pool (${input.priceLowFee.toFixed(2)} USDT/WHSK) and 0.3% pool (${input.priceHighFee.toFixed(2)} USDT/WHSK)`,
    );
  } else {
    reasons.push(`cross-fee spread only ${spread.toFixed(0)} bps — pools agree, no edge`);
  }
  if (supraFresh) {
    reasons.push(
      `cheaper pool deviates ${supraDev!.toFixed(0)} bps from fresh Supra HSK/USD ${(input.supraPrice as number).toFixed(5)}` +
        (Math.abs(supraDev!) >= 100_000
          ? ` — SATURATED: testnet pool price is synthetic, ${(cheapPrice / (input.supraPrice as number)).toFixed(0)}x the oracle reference`
          : ''),
    );
  } else if (input.supraStatus === 'stale') {
    reasons.push('Supra HSK/USD reading STALE (>24h old) — reference treated as missing, component scored 0');
  } else {
    reasons.push('no fresh Supra HSK/USD reference available — supra component scored 0');
  }
  if (input.twapPrice > 0) {
    reasons.push(`cheaper pool deviates ${cheapDev.toFixed(0)} bps from TWAP ${input.twapPrice.toFixed(2)}`);
  } else {
    reasons.push('no TWAP history available — TWAP component scored 0');
  }
  reasons.push(`swap volume trend ${input.volumeTrend.toFixed(2)}x vs previous hour`);

  // Direction: buy WHSK where it is cheap (the lower USDT/WHSK price).
  // The journal records which pool was cheaper; execution always routes to it.
  const direction: Signal['direction'] =
    Math.abs(spread) >= 100 ? 'buy-whsk' : 'none';
  return {
    score,
    direction,
    components: {
      // `+ 0` normalises -0 to 0 (a v1 supra weight of 0 makes the raw
      // component -0 when the deviation clamps to -1 — same convention as
      // scoreTPoolSignal below).
      spread: Math.round(spreadScore) + 0,
      supra: Math.round(supraScore) + 0,
      twap: Math.round(twapScore) + 0,
      volume: Math.round(volumeScore) + 0,
    },
    reasons,
    spreadBps: spread,
    twapDeviationBps: cheapDev,
    supraDeviationBps: supraDev,
  };
}

// ---------------------------------------------------------------------------
// T-POOL SIGNAL (integration pass, 2026-11-23): the primary market is now the
// single fairly-priced tWHSK/tUSDT pool (0x840fa6e4...), NOT the two synthetic
// USDT/WHSK pools. The old cross-fee spread is DROPPED as a scored component
// — there is only one t-pool fee tier, so there is no spread to score — and
// is kept only as a logged diagnostic (oldSpreadBps, never scored), with the
// reason string explaining the old pools are synthetic (~643-928x the oracle)
// and frozen since ~Nov 1.
//
// WEIGHTS (total 100) — justified, not tuned to testnet outcomes:
//   supra 30 — external anchor, same weight/formula as before: a FRESH oracle
//     reading that says the pool is cheap vs the wider market adds conviction;
//     stale/missing scores 0 (fail-closed). On the fairly-priced t-pool a
//     fresh reading behaves normally (pool 0.0869 vs oracle 0.08426 = +3.1%,
//     ~-9 pts), unlike the saturated -30 on the synthetic pools.
//     FALLBACK: while Supra is stale, the reference median (src/referenceMedian.ts
//     — CoinGecko+Kraken+Gate+MEXC, explicitly NOT an oracle) may fill this
//     same slot, CAPPED at 14 pts (REFERENCE_MEDIAN_MAX_POINTS). 14 is the
//     largest integer such that median(14) + twap(45) = 59 < threshold 60:
//     the median can never be the component that pushes the score over
//     threshold — a trade always needs at least one more point from volume
//     (or a fresh Supra). A fresh Supra always wins over the median; the
//     median never overrides it. See DESIGN.md (reference median section).
//   twap  45 — the primary mean-reversion signal, now measured on-chain via
//     observe() instead of dead subgraph swaps: price vs the 24h TWAP.
//     Largest weight because it is the only component built from live,
//     pool-native history. Full 45 pts at >=10% below the 24h TWAP.
//     (Why 24h, not 7d, is documented in src/trend.ts: scoring vs 7d while
//     the trend gate requires price >= 7d TWAP would cap the score at 55
//     whenever the gate passes — threshold 60 unreachable by construction.
//     The 7d deviation is reported as a diagnostic, twap7dDeviationBps.)
//   volume 25 — rising swap activity on the t-pool (hourly counts from the
//     subgraph `swaps` query; the `v3Pools` root field does NOT exist on this
//     subgraph — verified live, use `pools`/`swaps`). Weak confirmation only:
//     the t-pool's last swap was Nov 4, so this scores 0 until activity
//     resumes, and the journal says why.
// Threshold 60 unchanged: supra alone (30) or twap alone (45) can never
// trade; at least two components must agree.
//
// BACKTEST NOTE: the TWAP here comes from live observe() calls, which have no
// historical series — the backtest substitutes trailing-swap TWAP proxies and
// labels them as such (see src/backtest.ts). Supra has no historical series
// either and scores 0 in every backtest event, as before.
/** Max points the reference median (NOT an oracle) may contribute: 14.
 *  14 + twap 45 = 59 < threshold 60, so the median can never be the
 *  component that pushes the score over threshold. */
export const REFERENCE_MEDIAN_MAX_POINTS = 14;

export interface TPoolSignalInput {
  /** Current t-pool spot price, USDT per WHSK (tUSDT per tWHSK). */
  price: number;
  /** 24h observe() TWAP (USDT per WHSK), 0 if unavailable. */
  twap24h: number;
  /** 7d observe() TWAP (USDT per WHSK), 0 if unavailable — diagnostic only. */
  twap7d: number;
  /** Swap volume trend (last hour vs previous hour, 1.0 = flat). */
  volumeTrend: number;
  /** FRESH Supra HSK/USD reference (USD per HSK). 0 / omit when stale/missing. */
  supraPrice?: number;
  /** Freshness of the Supra reading; anything other than 'fresh' scores 0. */
  supraStatus?: 'fresh' | 'stale' | 'missing';
  /**
   * FRESH reference-median HSK/USD price (USD per HSK) — used ONLY when
   * Supra is NOT fresh. Capped at REFERENCE_MEDIAN_MAX_POINTS (14).
   * Pass 0 / omit when stale or missing — the component then scores 0.
   */
  referenceMedianPrice?: number;
  /** Freshness of the reference-median reading; anything other than 'fresh' scores 0. */
  referenceMedianStatus?: 'fresh' | 'stale' | 'missing';
  /** Cross-fee spread of the OLD synthetic pools, bps — DIAGNOSTIC ONLY,
   *  never scored. Pass null when the subgraph read failed. */
  oldSpreadBps?: number | null;
}

export interface TPoolSignal {
  score: number; // 0-100
  direction: 'buy-whsk' | 'none';
  components: { supra: number; twap: number; volume: number };
  reasons: string[];
  /** Old-pool cross-fee spread, bps — diagnostic only, never scored. */
  spreadDiagnosticBps: number | null;
  /** Price vs 24h TWAP, bps (0 when TWAP missing). */
  twapDeviationBps: number;
  /** Price vs 7d TWAP, bps (0 when TWAP missing) — diagnostic. */
  twap7dDeviationBps: number;
  /** Raw pool-vs-reference deviation in bps (unclamped; null when no reference). */
  supraDeviationBps: number | null;
  /** Which reference fed the supra component: fresh Supra, the capped
   *  reference median (NOT an oracle), or none. */
  referenceSource: 'supra' | 'reference-median' | 'none';
}

export function scoreTPoolSignal(input: TPoolSignalInput): TPoolSignal {
  const reasons: string[] = [];

  // Reference component: up to +/-30 pts from a FRESH Supra reading, or up
  // to +/-14 pts from the reference median (NOT an oracle) when Supra is
  // stale/missing. Precedence is strict: a fresh Supra ALWAYS wins; the
  // median fills the slot only while Supra is stale. Same formula either
  // way (deviation clamped at >=1000 bps); only the cap differs.
  let supraScore = 0;
  let supraDev: number | null = null;
  let referenceSource: TPoolSignal['referenceSource'] = 'none';
  const supraFresh =
    (input.supraPrice ?? 0) > 0 && (input.supraStatus ?? 'fresh') === 'fresh';
  const medianFresh =
    (input.referenceMedianPrice ?? 0) > 0 &&
    (input.referenceMedianStatus ?? 'fresh') === 'fresh';
  if (supraFresh) {
    supraDev = twapDeviationBps(input.price, input.supraPrice as number);
    supraScore = clamp(-supraDev / 1000, -1, 1) * 30;
    referenceSource = 'supra';
  } else if (medianFresh) {
    supraDev = twapDeviationBps(input.price, input.referenceMedianPrice as number);
    supraScore = clamp(-supraDev / 1000, -1, 1) * REFERENCE_MEDIAN_MAX_POINTS;
    referenceSource = 'reference-median';
  }

  // TWAP component: up to 45 pts, price vs the 24h observe() TWAP.
  // Price below the 24h TWAP = short-term dip vs the recent average ->
  // mean-reversion upside, adds up to 45 pts at >=10% below.
  let twapScore = 0;
  const twapDev = twapDeviationBps(input.price, input.twap24h);
  if (input.twap24h > 0) {
    twapScore = clamp(-twapDev / 1000, -1, 1) * 45;
  }
  const twap7dDev = twapDeviationBps(input.price, input.twap7d);

  // Volume component: up to 25 pts for rising t-pool swap activity.
  const volumeScore = clamp((input.volumeTrend - 1) / 1, 0, 1) * 25;

  const score = clamp(Math.round(supraScore + twapScore + volumeScore), 0, 100);

  if (supraFresh) {
    reasons.push(
      `t-pool price deviates ${supraDev!.toFixed(0)} bps from fresh Supra HSK/USD ${(input.supraPrice as number).toFixed(5)}`,
    );
  } else if (referenceSource === 'reference-median') {
    reasons.push(
      `t-pool price deviates ${supraDev!.toFixed(0)} bps from reference-median (NOT an oracle) HSK/USD ${(input.referenceMedianPrice as number).toFixed(5)} — Supra stale, fallback reference capped at ±${REFERENCE_MEDIAN_MAX_POINTS} pts`,
    );
  } else if (input.supraStatus === 'stale') {
    reasons.push('Supra HSK/USD reading STALE (>24h old) and no fresh reference-median available — reference treated as missing, component scored 0');
  } else {
    reasons.push('no fresh Supra HSK/USD reference and no fresh reference-median available — supra component scored 0');
  }
  if (input.twap24h > 0) {
    reasons.push(`t-pool price deviates ${twapDev.toFixed(0)} bps from 24h observe() TWAP ${input.twap24h.toFixed(6)}`);
  } else {
    reasons.push('no 24h observe() TWAP available — TWAP component scored 0');
  }
  if (input.twap7d > 0) {
    reasons.push(`7d observe() TWAP ${input.twap7d.toFixed(6)} (diagnostic; trend gate uses it, signal scores vs 24h)`);
  }
  reasons.push(`t-pool swap volume trend ${input.volumeTrend.toFixed(2)}x vs previous hour`);
  if (input.oldSpreadBps !== undefined && input.oldSpreadBps !== null) {
    reasons.push(
      `DIAGNOSTIC ONLY — old-pool cross-fee spread ${input.oldSpreadBps.toFixed(0)} bps (0.05% pool vs 0.3% pool): NOT scored. Those pools are synthetic (~643-928x the Supra oracle) and frozen since ~Nov 1; the spread is not a tradable edge.`,
    );
  } else {
    reasons.push('DIAGNOSTIC ONLY — old-pool spread unavailable (subgraph read failed); not scored either way.');
  }

  // Direction: buy the short-term dip (price below the 24h TWAP by >1%).
  // The agent additionally gates on score >= threshold AND the trend gate.
  const direction: TPoolSignal['direction'] = twapDev < -100 ? 'buy-whsk' : 'none';
  return {
    score,
    direction,
    components: {
      supra: Math.round(supraScore) + 0,
      twap: Math.round(twapScore) + 0,
      volume: Math.round(volumeScore) + 0,
    },
    reasons,
    spreadDiagnosticBps: input.oldSpreadBps ?? null,
    twapDeviationBps: twapDev,
    twap7dDeviationBps: twap7dDev,
    supraDeviationBps: supraDev,
    referenceSource,
  };
}
