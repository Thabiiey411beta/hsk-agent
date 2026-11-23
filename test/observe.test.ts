import { describe, expect, it } from 'vitest';
import { getPoolTwapFromContract, type PoolContractLike, type TokenMetaLike } from '../src/observe.js';
import { meanTickFromCumulatives, priceFromTick, tickToUsdtPerWhskGeneral } from '../src/math.js';

const USDT = '0xUSDT';
const WHSK = '0xWHSK';
const TUSDT = '0xTUSDT';
const TWHSK = '0xTWHSK';

// Fake pool: frozen demo pool, tick -43600 over a 1h window.
function fakePool(opts: Partial<{ revertObserve: boolean; spotTick: number; meanTick: number }> = {}): PoolContractLike {
  const meanTick = opts.meanTick ?? -43600;
  const windowSec = 3600;
  const tcDiff = BigInt(meanTick * windowSec);
  return {
    observe: async () => {
      if (opts.revertObserve) throw new Error('missing revert data (OLD)');
      return [[0n, tcDiff], [0n, 0n]];
    },
    slot0: async () => ({ tick: opts.spotTick ?? -43600 }),
    token0: async () => USDT,
    token1: async () => WHSK,
  };
}

function demoMeta(address: string): TokenMetaLike {
  const table: Record<string, { dec: number; sym: string }> = {
    [USDT]: { dec: 18, sym: 'USDT' },
    [WHSK]: { dec: 18, sym: 'WHSK' },
  };
  return {
    decimals: async () => table[address].dec,
    symbol: async () => table[address].sym,
  };
}

describe('math helpers for TWAP', () => {
  it('meanTick from cumulatives: (-156960000)/3600 = -43600', () => {
    expect(meanTickFromCumulatives(-156960000n, 0n, 3600)).toBe(-43600);
  });
  it('priceFromTick demo pools (18/18): tick -43600 -> 0.01278 WHSK per USDT', () => {
    expect(priceFromTick(-43600, 18, 18)).toBeCloseTo(0.01278, 4);
  });
  it('tickToUsdtPerWhskGeneral demo pools: tick -43600 -> ~78.24 USDT/WHSK', () => {
    expect(tickToUsdtPerWhskGeneral(-43600, true, 18, 18)).toBeCloseTo(78.24, 1);
  });
  it('priceFromTick accepts bigint decimals (what ethers returns for uint8)', () => {
    // Regression: Math.pow(10, 18n - 18n) throws TypeError — v2.0 live TWAP
    // reads all returned null because of this.
    expect(priceFromTick(-43600, 18n as unknown as number, 18n as unknown as number)).toBeCloseTo(0.01278, 4);
    expect(tickToUsdtPerWhskGeneral(-300757, false, 18n as unknown as number, 6n as unknown as number)).toBeCloseTo(0.0869, 3);
  });
  it('tickToUsdtPerWhskGeneral tWHSK/tUSDT (USDT is token1, 18/6): tick -300757 -> ~0.0869', () => {
    expect(tickToUsdtPerWhskGeneral(-300757, false, 18, 6)).toBeCloseTo(0.0869, 3);
  });
});

describe('getPoolTwapFromContract (demo USDT/WHSK pool)', () => {
  it('frozen pool returns TWAP == spot with frozen=true (not an error)', async () => {
    const r = await getPoolTwapFromContract(fakePool(), '0xpool', 3600, demoMeta);
    expect(r).not.toBeNull();
    expect(r!.twapPrice).toBeCloseTo(78.24, 1);
    expect(r!.spotPrice).toBeCloseTo(78.24, 1);
    expect(r!.meanTick).toBe(-43600);
    expect(r!.frozen).toBe(true);
  });
  it('bigint decimals from tokenMeta (ethers uint8) do not break the read', async () => {
    // Regression: ethers returns decimals() as bigint; Math.pow on bigint
    // throws and the whole read returned null in v2.0.
    const bigMeta = (address: string): TokenMetaLike => ({
      decimals: async () => 18n as unknown as number,
      symbol: async () => (address === USDT ? 'USDT' : 'WHSK'),
    });
    const r = await getPoolTwapFromContract(fakePool(), '0xpool', 3600, bigMeta);
    expect(r).not.toBeNull();
    expect(r!.twapPrice).toBeCloseTo(78.24, 1);
  });
  it('moving pool: TWAP != spot -> frozen=false', async () => {
    const r = await getPoolTwapFromContract(fakePool({ spotTick: -40000 }), '0xpool', 3600, demoMeta);
    expect(r).not.toBeNull();
    expect(r!.frozen).toBe(false);
    expect(r!.spotPrice).toBeCloseTo(54.6, 0);
  });
  it('observe revert (OLD, window too long) -> null, never a guess', async () => {
    const r = await getPoolTwapFromContract(fakePool({ revertObserve: true }), '0xpool', 30 * 86400, demoMeta);
    expect(r).toBeNull();
  });
  it('invalid window -> null', async () => {
    expect(await getPoolTwapFromContract(fakePool(), '0xpool', 0, demoMeta)).toBeNull();
    expect(await getPoolTwapFromContract(fakePool(), '0xpool', -5, demoMeta)).toBeNull();
  });
  it('unknown pair (no USDT side) -> null, fail-closed', async () => {
    const meta = () => ({ decimals: async () => 18, symbol: async () => 'XXX' });
    const r = await getPoolTwapFromContract(fakePool(), '0xpool', 3600, meta);
    expect(r).toBeNull();
  });
});

describe('getPoolTwapFromContract (tWHSK/tUSDT pool, decimals matter)', () => {
  const tPool: PoolContractLike = {
    observe: async () => [[0n, BigInt(-300757 * 3600)], [0n, 0n]],
    slot0: async () => ({ tick: -300757 }),
    token0: async () => TWHSK,
    token1: async () => TUSDT,
  };
  const tMeta = (address: string): TokenMetaLike => {
    const table: Record<string, { dec: number; sym: string }> = {
      [TWHSK]: { dec: 18, sym: 'tWHSK' },
      [TUSDT]: { dec: 6, sym: 'tUSDT' },
    };
    return { decimals: async () => table[address].dec, symbol: async () => table[address].sym };
  };
  it('tick -300757 with 18/6 decimals -> ~0.0869 USDT per WHSK, not the raw 1.0001^tick', async () => {
    const r = await getPoolTwapFromContract(tPool, '0xtpool', 3600, tMeta);
    expect(r).not.toBeNull();
    expect(r!.twapPrice).toBeCloseTo(0.0869, 3);
    expect(r!.twapPrice).toBeGreaterThan(0.08);
    expect(r!.twapPrice).toBeLessThan(0.09);
    expect(r!.frozen).toBe(true);
  });
});
