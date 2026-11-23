// Pure math helpers — no I/O, fully unit-tested.
// Prices are in test USDT per WHSK (token0=USDT, token1=WHSK, both 18 decimals
// on testnet, so no decimal adjustment is needed for this pair).

/** Uniswap V3 sqrtPriceX96 -> price of token1 in units of token0. */
export function sqrtPriceToPrice(sqrtPrice: bigint): number {
  const q96 = 2n ** 96n;
  // price = (sqrtPrice / 2^96)^2 ; use float math on the ratio.
  const ratio = Number(sqrtPrice) / Number(q96);
  return ratio * ratio;
}

/** Price of token1 per token0 -> token0 per token1 (USDT per WHSK). */
export function priceToken0PerToken1(sqrtPrice: bigint): number {
  const p = sqrtPriceToPrice(sqrtPrice);
  return p === 0 ? 0 : 1 / p;
}

/** Relative spread between two prices: (a-b)/mean, signed. */
export function spreadBps(priceA: number, priceB: number): number {
  if (priceA <= 0 || priceB <= 0) return 0;
  const mean = (priceA + priceB) / 2;
  return ((priceA - priceB) / mean) * 10_000;
}

/** Time-weighted average price from [timestamp, price] samples. */
export function twap(samples: Array<{ t: number; price: number }>): number {
  if (samples.length === 0) return 0;
  if (samples.length === 1) return samples[0].price;
  let weighted = 0;
  let totalTime = 0;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  for (let i = 1; i < sorted.length; i++) {
    const dt = sorted[i].t - sorted[i - 1].t;
    if (dt <= 0) continue;
    weighted += sorted[i - 1].price * dt;
    totalTime += dt;
  }
  return totalTime > 0 ? weighted / totalTime : sorted[sorted.length - 1].price;
}

/** Deviation of current price from TWAP, in bps. */
export function twapDeviationBps(current: number, twapPrice: number): number {
  if (current <= 0 || twapPrice <= 0) return 0;
  return ((current - twapPrice) / twapPrice) * 10_000;
}

/** Clamp a number into [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** Price of token1 per token0 from a Uniswap V3 tick: 1.0001^tick. */
export function tickToToken1PerToken0(tick: number): number {
  return Math.pow(1.0001, tick);
}

/** USDT per WHSK from a tick (token0=USDT, token1=WHSK, both 18 dec). */
export function tickToUsdtPerWhsk(tick: number): number {
  const p = tickToToken1PerToken0(tick);
  return p === 0 ? 0 : 1 / p;
}

/** Mean tick from Uniswap V3 tick cumulatives: (tcNow - tcAgo) / secondsAgo.
 *  Returns a float (not truncated bigint division) so the TWAP price keeps
 *  precision on short windows. */
export function meanTickFromCumulatives(tcNow: bigint, tcAgo: bigint, secondsAgo: number): number {
  if (secondsAgo <= 0) return 0;
  return Number(tcNow - tcAgo) / secondsAgo;
}

/** Price of token1 per token0 (human units) from a tick, correcting for the
 *  tokens' decimals: 1.0001^tick * 10^(dec0 - dec1).
 *  Demo pools (both 18 dec): 1.0001^tick = WHSK per USDT.
 *  tWHSK/tUSDT pool (token0 tWHSK 18 dec, token1 tUSDT 6 dec):
 *  1.0001^tick * 10^12 = tUSDT per tWHSK (~0.087 at tick -300757). */
export function priceFromTick(tick: number, dec0: number, dec1: number): number {
  // Decimals arrive as bigint from ethers (uint8) — coerce, else Math.pow
  // throws TypeError (this silently nulled every live TWAP read in v2.0).
  return Math.pow(1.0001, tick) * Math.pow(10, Number(dec0) - Number(dec1));
}

/** USDT per WHSK from a tick, given which side of the pair is USDT and the
 *  two tokens' decimals. priceToken1PerToken0 is token1 per token0; invert
 *  it when USDT is token0 (demo pools), keep it when USDT is token1
 *  (tWHSK/tUSDT pool). Returns 0 on a degenerate (zero) price. */
export function tickToUsdtPerWhskGeneral(
  tick: number,
  usdtIsToken0: boolean,
  dec0: number,
  dec1: number,
): number {
  const p = priceFromTick(tick, dec0, dec1);
  if (p === 0) return 0;
  return usdtIsToken0 ? 1 / p : p;
}

/** True when two prices agree within `relTol` relative tolerance. Used for
 *  the frozen-tick check: TWAP == spot (no movement) means the pool has not
 *  traded in the window. */
export function pricesEqualWithin(a: number, b: number, relTol = 1e-9): boolean {
  if (a <= 0 || b <= 0) return a === b;
  return Math.abs(a - b) / Math.max(a, b) <= relTol;
}
