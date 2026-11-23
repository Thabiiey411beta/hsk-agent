import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';
import { SupraReader, type SupraContractLike } from '../src/supra.js';
import { ReferenceMedianReader } from '../src/referenceMedian.js';
import type { PoolTwap } from '../src/observe.js';

const NOW = 1795430000000; // fixed clock for the stale Supra reader
const STALE_SUPRA: SupraContractLike = {
  getSvalue: async () => ({
    round: 1n,
    decimals: 18n,
    time: BigInt(NOW - 7 * 86400_000), // 7 days old -> stale
    price: 84260000000000000n,
  }),
};
const staleReader = () => new SupraReader(null, { contract: STALE_SUPRA, maxAgeSec: 86400, nowMs: () => NOW });
// The reference median is live HTTP by default — these tests pin it to
// "missing" (fetch always fails -> null) so scores stay deterministic
// and no network is touched. Fallback wiring is tested separately in
// test/reference-median.test.ts with a stubbed median reader.
const noMedian = new ReferenceMedianReader({
  fetchFn: async () => { throw new Error('no network in tests'); },
});

const CAPS = { perTradeCapBps: 1000, dailyCapBps: 3000, stopLossBps: 200, maxDrawdownBps: 1000, dailyLossLimitBps: 500, halted: false };

function twap(twapPrice: number, spotPrice: number, secondsAgo: number): PoolTwap {
  return {
    pool: '0x840fa6e439F52cEa60dABec8BBB820DE80dDb542',
    twapPrice,
    meanTick: -300757,
    spotPrice,
    spotTick: -300757,
    secondsAgo,
    frozen: twapPrice === spotPrice,
    timestamp: Math.floor(NOW / 1000),
    token0: '0x198c3EC5530463290e2F16988Bf6B8006F4C6995',
    token1: '0xD57a8171b83E154145f47DcE512786173a9A36ca',
  };
}

function journalDir() {
  return mkdtempSync(join(tmpdir(), 'hsk-agent-int-'));
}

describe('Agent poll (t-pool integration, fakes)', () => {
  it('frozen pool: signal 0, no trade, vault caps read, effective caps set', async () => {
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      fetchTwap: async (_p, w) => twap(0.0868845, 0.0868845, w),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
    });
    const out = await agent.poll();
    expect(agent.state.lastTPool?.spot).toBeCloseTo(0.0868845, 7);
    expect(agent.state.lastSignal?.score).toBe(0);
    expect(out.action).toMatch(/no trade — score 0 < 60/);
    expect(agent.state.positions.length).toBe(0);
    expect(agent.state.lastVaultCaps).toEqual(CAPS);
    expect(agent.state.effectiveCaps?.perTradeCap).toBeCloseTo(0.1);
    // Old-pool spread is present as a diagnostic, not a scored component.
    expect(agent.state.lastSignal?.spreadDiagnosticBps).toBeCloseTo(3634, 0);
    expect(agent.state.lastSignal?.reasons.join(' ')).toMatch(/DIAGNOSTIC ONLY/);
  });

  it('dip below the 24h TWAP with rising volume clears 60 and opens a PAPER position', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const swaps = [
      { id: 'a', timestamp: nowSec - 1800, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'b', timestamp: nowSec - 900, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'c', timestamp: nowSec - 5000, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
    ];
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      // Price 0.0869 is ~13% below the 24h TWAP (0.10) -> TWAP 45 pts;
      // volume 2h/1h -> trend 2 -> volume 25 pts; total 70 >= 60.
      // Trend gate: price >= 7d TWAP (0.086) and 24h (0.10) >= 7d (0.086) -> pass.
      fetchTwap: async (_p, w) => (w === 86400 ? twap(0.10, 0.0869, w) : twap(0.086, 0.0869, w)),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => swaps,
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
    });
    const out = await agent.poll();
    expect(agent.state.lastSignal?.score).toBe(70);
    expect(agent.state.lastTrendGate?.pass).toBe(true);
    expect(agent.state.positions.length).toBe(1);
    expect(agent.state.positions[0].mode).toBe('paper');
    expect(agent.state.positions[0].stopPrice).toBeLessThan(agent.state.positions[0].entryPrice);
    expect(out.action).toMatch(/PAPER BUY/);
    // ATR fallback: only 1 daily bar from 3 swaps in one day.
    expect(agent.state.lastAtr?.fallback).toBe(true);
    // No wallet in paper mode: vault registration skipped + journaled.
    const entries = agent.journal.readAll();
    expect(entries.some((e) => e.type === 'register' && e.status === 'skipped')).toBe(true);
  });

  it('trend gate blocks the entry when price is below the 7d TWAP (score clears first)', async () => {
    // Score clears (dip vs 24h TWAP 45 + volume 25 = 70) but price 0.0869 is
    // below the 7d TWAP 0.09 -> the gate, not the score, blocks the entry.
    const nowSec = Math.floor(Date.now() / 1000);
    const swaps = [
      { id: 'a', timestamp: nowSec - 1800, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'b', timestamp: nowSec - 900, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'c', timestamp: nowSec - 5000, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
    ];
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      fetchTwap: async (_p, w) => (w === 86400 ? twap(0.10, 0.0869, w) : twap(0.09, 0.0869, w)),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => swaps,
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
    });
    const out = await agent.poll();
    expect(agent.state.lastSignal?.score).toBe(70);
    expect(agent.state.lastTrendGate?.pass).toBe(false);
    expect(out.action).toMatch(/no trade — trend gate failed/);
    expect(agent.state.positions.length).toBe(0);
  });

  it('vault caps read failure blocks trading that poll (fail-closed)', async () => {
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      fetchTwap: async (_p, w) => twap(0.0868845, 0.0868845, w),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => { throw new Error('revert'); },
      readVaultPoolKindFn: async () => 1,
    });
    const out = await agent.poll();
    expect(out.action).toMatch(/BLOCKED: vault caps read failed/);
    expect(agent.state.positions.length).toBe(0);
  });

  it('vault poolKind mismatch blocks trading (on-chain stop would misprice)', async () => {
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      fetchTwap: async (_p, w) => twap(0.0868845, 0.0868845, w),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 0,
    });
    const out = await agent.poll();
    expect(out.action).toMatch(/BLOCKED: RiskVault v3 poolKind is 0/);
  });

  it('missing TWAP blocks the poll (fail-closed)', async () => {
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      fetchTwap: async () => null,
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
    });
    const out = await agent.poll();
    expect(out.action).toMatch(/BLOCKED: t-pool TWAP unavailable/);
    expect(out.signal).toBeNull();
  });
});

describe('Agent live path (fakes — no RPC, no tx)', () => {
  const fakeWallet = {
    address: '0xF5bDFE902718Bd75d2d6A6070dcdC6FBF9D781DA',
    provider: { getNetwork: async () => ({ chainId: 133n }) },
  } as any;

  function liveDeps() {
    return {
      referenceMedianReader: noMedian,
      fetchTwap: async (_p: string, w: number) => (w === 86400 ? twap(0.10, 0.0869, w) : twap(0.086, 0.0869, w)),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
      wallet: fakeWallet,
      checkAllowanceFn: async () => 100_000_000n, // 100 tUSDT approved
      executeSwapFn: async () => ({
        txHash: '0xswap',
        quotedAmountOut: 115_000_000_000_000_000_000n,
        amountOutMinimum: 114_000_000_000_000_000_000n,
        simulatedAmountOut: 115_000_000_000_000_000_000n,
      }),
      registerPositionFn: async () => '0xreg',
      exitWouldTriggerFn: async () => false,
      anchorFn: async () => ({ txHash: '0xanchor', batchId: 3 }),
      attestFn: async () => ({ txHash: '0xattest', attestationUid: '0xuid' }),
    };
  }

  it('live mode executes ONE trade, registers + anchors + attests, then blocks a second', async () => {
    // Volume 1 here gives score 45 — need volume 2x for 70. Use swaps.
    const nowSec = Math.floor(Date.now() / 1000);
    const swaps = [
      { id: 'a', timestamp: nowSec - 1800, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'b', timestamp: nowSec - 900, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      { id: 'c', timestamp: nowSec - 5000, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
    ];
    const agent = new Agent({}, 'live', join(journalDir(), 'j.jsonl'), staleReader(), { ...liveDeps(), fetchTPoolSwaps: async () => swaps });
    const out = await agent.poll();
    expect(out.action).toMatch(/LIVE BUY/);
    expect(agent.state.liveTrades).toBe(1);
    expect(agent.state.positions.length).toBe(1);
    expect(agent.state.positions[0].mode).toBe('live');
    expect(agent.state.positions[0].liveTxHash).toBe('0xswap');
    expect(agent.state.positions[0].vaultRegistered).toBe(true);
    const types = agent.journal.readAll().map((e) => e.type);
    expect(types).toContain('live-fill');
    expect(types).toContain('anchor');
    expect(types).toContain('attestation');
    // Second poll: position open -> holding (no second entry while holding).
    const out2 = await agent.poll();
    expect(out2.action).toMatch(/holding/);
  });

  it('live mode blocks when allowance is insufficient (never auto-approves)', async () => {
    const agent = new Agent({}, 'live', join(journalDir(), 'j.jsonl'), staleReader(), {
      referenceMedianReader: noMedian,
      ...liveDeps(),
      checkAllowanceFn: async () => 0n,
      fetchTPoolSwaps: async () => [
        { id: 'a', timestamp: Math.floor(Date.now() / 1000) - 1800, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
        { id: 'b', timestamp: Math.floor(Date.now() / 1000) - 900, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
        { id: 'c', timestamp: Math.floor(Date.now() / 1000) - 5000, pool: 'x', tick: -300757, amount0: 10, amount1: 1, amountUSD: 0 },
      ],
    });
    const out = await agent.poll();
    expect(out.action).toMatch(/blocked — tUSDT allowance/);
    expect(agent.state.liveTrades).toBe(0);
  });
});
