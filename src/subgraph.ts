// Minimal GraphQL client for the HSKSwap subgraphs (testnet + mainnet).
// Note: subgraph USD figures are all "0" — price is derived from sqrtPrice, never USD.
import { TESTNET_SUBGRAPH } from './config.js';

export interface PoolSnapshot {
  id: string;
  feeTier: number;
  sqrtPrice: bigint;
  txCount: number;
  liquidity: bigint;
  token0: { symbol: string; decimals: number };
  token1: { symbol: string; decimals: number };
}

export interface SwapRecord {
  id: string;
  timestamp: number;
  pool: string;
  /** Uniswap V3 tick at the swap — price is derived from this (the subgraph
   *  Swap type has no sqrtPrice field). */
  tick: number;
  amount0: number;
  amount1: number;
  amountUSD: number; // always 0 in these subgraphs — kept for completeness, never used for pricing
}

async function gql(url: string, query: string): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
  const json = (await res.json()) as { data?: unknown; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(`subgraph error: ${json.errors[0].message}`);
  return json.data;
}

export async function fetchPools(
  poolIds: string[],
  url = TESTNET_SUBGRAPH,
): Promise<PoolSnapshot[]> {
  const ids = poolIds.map((id) => `"${id}"`).join(',');
  const data = (await gql(
    url,
    `{ pools(where:{id_in:[${ids}]}) { id feeTier sqrtPrice txCount liquidity token0 { symbol decimals } token1 { symbol decimals } } }`,
  )) as {
    pools: Array<{
      id: string;
      feeTier: string;
      sqrtPrice: string;
      txCount: string;
      liquidity: string;
      token0: { symbol: string; decimals: string };
      token1: { symbol: string; decimals: string };
    }>;
  };
  return data.pools.map((p) => ({
    id: p.id,
    feeTier: Number(p.feeTier),
    sqrtPrice: BigInt(p.sqrtPrice),
    txCount: Number(p.txCount),
    liquidity: BigInt(p.liquidity),
    token0: { symbol: p.token0.symbol, decimals: Number(p.token0.decimals) },
    token1: { symbol: p.token1.symbol, decimals: Number(p.token1.decimals) },
  }));
}

export async function fetchSwaps(
  poolId: string,
  first = 100,
  skip = 0,
  url = TESTNET_SUBGRAPH,
): Promise<SwapRecord[]> {
  const data = (await gql(
    url,
    `{ swaps(first:${first}, skip:${skip}, orderBy:timestamp, orderDirection:desc, where:{pool:"${poolId}"}) { id timestamp tick amount0 amount1 amountUSD } }`,
  )) as { swaps: Array<Record<string, string>> };
  return data.swaps.map((s) => ({
    id: s.id,
    timestamp: Number(s.timestamp),
    pool: poolId,
    tick: Number(s.tick),
    amount0: Number(s.amount0),
    amount1: Number(s.amount1),
    amountUSD: Number(s.amountUSD),
  }));
}

/** Swap counts per hour bucket for a pool (used for the volume-trend component). */
export function hourlySwapCounts(swaps: SwapRecord[], nowSec: number): { lastHour: number; prevHour: number } {
  const lastHour = swaps.filter((s) => s.timestamp > nowSec - 3600).length;
  const prevHour = swaps.filter((s) => s.timestamp > nowSec - 7200 && s.timestamp <= nowSec - 3600).length;
  return { lastHour, prevHour };
}
