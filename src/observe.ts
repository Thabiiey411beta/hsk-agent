// On-chain TWAP reader via Uniswap V3 pool observe().
// Testnet only (chain 133). Read-only: eth_call only, never sends a tx
// (except increaseCardinality, which is an explicit setup step).
//
// Verified live 2026-11-23 (block ~36,121,087):
//   observe(uint32[] secondsAgos) selector 0x883bdbfd returns
//   (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s).
//   meanTick = (tc[now] - tc[ago]) / secondsAgo; TWAP price = 1.0001^meanTick
//   (adjusted for token decimals — see src/math.ts priceFromTick).
//   Windows 1h/24h/7d work on the demo pools; 30d reverts OLD (observation
//   cardinality is 1 on the 0.05% pool, 16 on the 0.3% pool — anyone may call
//   increaseObservationCardinalityNext, permissionless).
//   Both demo pools are FROZEN at tick -43600 / -39926 (no swaps since ~Nov 1):
//   TWAP == spot, reported with frozen: true rather than failing.
//   The liquid test pair tWHSK/tUSDT 0x840fa6e4... has token0 = tWHSK (18 dec),
//   token1 = tUSDT (6 dec) — the decimal correction matters there (tick
//   -300757 -> ~0.0869 tUSDT per tWHSK, NOT the raw 1.0001^tick).
import { Contract, type JsonRpcProvider, type Wallet } from 'ethers';
import { meanTickFromCumulatives, pricesEqualWithin, tickToUsdtPerWhskGeneral } from './math.js';
import { assertTestnet } from './quoter.js';

export const POOL_ABI = [
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external',
] as const;

const ERC20_META_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
] as const;

export interface PoolTwap {
  pool: string;
  /** USDT per WHSK (human units), correctly handling token order + decimals. */
  twapPrice: number;
  meanTick: number;
  /** Spot price (USDT per WHSK) from slot0 at read time. */
  spotPrice: number;
  spotTick: number;
  secondsAgo: number;
  /** True when TWAP == spot (pool has not traded in the window). The value
   *  is still returned — frozen is a fact about the pool, not an error. */
  frozen: boolean;
  /** Block timestamp at read time (seconds since epoch). */
  timestamp: number;
  token0: string;
  token1: string;
}

/** Minimal pool-contract surface the reader needs — lets tests inject a fake. */
export interface PoolContractLike {
  observe(secondsAgos: number[]): Promise<[bigint[], bigint[]]>;
  slot0(): Promise<{ tick: number } | [unknown, number, unknown, unknown, unknown, unknown, unknown]>;
  token0(): Promise<string>;
  token1(): Promise<string>;
  increaseObservationCardinalityNext?(target: number): Promise<unknown>;
}

export interface TokenMetaLike {
  decimals(): Promise<number>;
  symbol(): Promise<string>;
}

function slot0Tick(slot0: Awaited<ReturnType<PoolContractLike['slot0']>>): number {
  if (Array.isArray(slot0)) return Number(slot0[1]);
  return Number(slot0.tick);
}

/** Core TWAP logic over an injected pool contract + token-meta reader.
 *  Returns null on any revert / missing data (fail-closed) — e.g. a 30d
 *  window on a cardinality-1 pool reverts OLD. */
export async function getPoolTwapFromContract(
  pool: PoolContractLike,
  poolAddress: string,
  secondsAgo: number,
  tokenMeta: (address: string) => TokenMetaLike,
  nowSec?: number,
): Promise<PoolTwap | null> {
  if (!Number.isInteger(secondsAgo) || secondsAgo <= 0) return null;
  try {
    const [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);
    const [m0, m1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)]);
    const [dec0, sym0] = [Number(await m0.decimals()), await m0.symbol()];
    const [dec1, sym1] = [Number(await m1.decimals()), await m1.symbol()];
    const [tickCumulatives] = await pool.observe([secondsAgo, 0]);
    if (!tickCumulatives || tickCumulatives.length < 2) return null;
    const meanTick = meanTickFromCumulatives(tickCumulatives[1], tickCumulatives[0], secondsAgo);
    const slot0 = await pool.slot0();
    const spotTick = slot0Tick(slot0);
    // Which side is USDT determines whether the raw token1-per-token0 price
    // must be inverted to get USDT per WHSK.
    const sym0U = sym0.toUpperCase();
    const sym1U = sym1.toUpperCase();
    const usdtIsToken0 = sym0U.includes('USDT');
    const usdtIsToken1 = sym1U.includes('USDT');
    if (!usdtIsToken0 && !usdtIsToken1) return null; // unknown pair — fail closed
    const twapPrice = tickToUsdtPerWhskGeneral(meanTick, usdtIsToken0, dec0, dec1);
    const spotPrice = tickToUsdtPerWhskGeneral(spotTick, usdtIsToken0, dec0, dec1);
    if (!(twapPrice > 0) || !(spotPrice > 0)) return null;
    return {
      pool: poolAddress,
      twapPrice,
      meanTick,
      spotPrice,
      spotTick,
      secondsAgo,
      frozen: pricesEqualWithin(twapPrice, spotPrice) || meanTick === spotTick,
      timestamp: nowSec ?? Math.floor(Date.now() / 1000),
      token0,
      token1,
    };
  } catch {
    return null; // revert (e.g. OLD) or missing data -> null, never a guess
  }
}

/** Live TWAP read: observe([secondsAgo, 0]) on `poolAddress`.
 *  Returns null on revert (e.g. window older than the oldest observation). */
export async function getPoolTwap(
  provider: JsonRpcProvider,
  poolAddress: string,
  secondsAgo: number,
): Promise<PoolTwap | null> {
  const pool = new Contract(poolAddress, POOL_ABI, provider) as unknown as PoolContractLike;
  const tokenMeta = (address: string) =>
    new Contract(address, ERC20_META_ABI, provider) as unknown as TokenMetaLike;
  let timestamp: number | undefined;
  try {
    const block = await provider.getBlock('latest');
    timestamp = block?.timestamp;
  } catch {
    timestamp = undefined; // fall back to wall-clock inside the reader
  }
  return getPoolTwapFromContract(pool, poolAddress, secondsAgo, tokenMeta, timestamp);
}

/** Read a pool's current observation cardinality (slot0 fields 3/4). */
export async function getCardinality(
  provider: JsonRpcProvider,
  poolAddress: string,
): Promise<{ cardinality: number; cardinalityNext: number } | null> {
  try {
    const pool = new Contract(poolAddress, POOL_ABI, provider);
    const s = await pool.slot0();
    return { cardinality: Number(s[3]), cardinalityNext: Number(s[4]) };
  } catch {
    return null;
  }
}

/** Permissionless setup step: raise a pool's observation cardinality so
 *  longer TWAP windows stop reverting OLD. Anyone may call this (Uniswap V3
 *  pools expose it without access control); it only writes the pool's own
 *  observation bookkeeping. Chain-checked to testnet 133; refuses mainnet.
 *  Returns the tx hash plus before/after cardinality. */
export async function increaseCardinality(
  provider: JsonRpcProvider,
  wallet: Wallet,
  poolAddress: string,
  target: number,
): Promise<{ txHash: string; before: number | null; after: number | null }> {
  await assertTestnet(provider);
  if (!Number.isInteger(target) || target < 1 || target > 65535) {
    throw new Error(`invalid cardinality target ${target}`);
  }
  const before = await getCardinality(provider, poolAddress);
  const pool = new Contract(poolAddress, POOL_ABI, wallet);
  const tx = await pool.increaseObservationCardinalityNext(target);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`increaseCardinality tx reverted: ${tx.hash}`);
  const after = await getCardinality(provider, poolAddress);
  return { txHash: tx.hash as string, before: before?.cardinality ?? null, after: after?.cardinalityNext ?? null };
}
