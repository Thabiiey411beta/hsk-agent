import { describe, expect, it } from 'vitest';
import {
  readAnchorFromContract,
  readCapsFromContract,
  readPositionFromContract,
  tighterCap,
  type VaultContractLike,
} from '../src/vault.js';

const ZERO = '0x' + '00'.repeat(32);

const fakeVault: VaultContractLike = {
  caps: async () => [1000n, 3000n, 200n, 1000n, 500n, false],
  anchors: async (batchId: number) =>
    batchId === 0 ? '0x' + 'ab'.repeat(32) : ZERO,
  anchorCount: async () => 1n,
  positions: async (id: string) =>
    id === '0xpos'
      ? [78240000000000000000n, 76675000000000000000n, false, true]
      : [0n, 0n, false, false],
  pool: async () => '0xff2b7e501c870980bf5641b4a70d0f9fb0f6f6ab',
};

describe('readCapsFromContract', () => {
  it('decodes the v2 deploy caps (10/30/2/10/5%, not halted)', async () => {
    const caps = await readCapsFromContract(fakeVault);
    expect(caps).toEqual({
      perTradeCapBps: 1000,
      dailyCapBps: 3000,
      stopLossBps: 200,
      maxDrawdownBps: 1000,
      dailyLossLimitBps: 500,
      halted: false,
    });
  });
  it('a reverting caps read throws (caller must treat as halt, fail-closed)', async () => {
    const bad: VaultContractLike = { ...fakeVault, caps: async () => { throw new Error('revert'); } };
    await expect(readCapsFromContract(bad)).rejects.toThrow('revert');
  });
});

describe('readAnchorFromContract', () => {
  it('anchored batch returns its hash', async () => {
    expect(await readAnchorFromContract(fakeVault, 0)).toBe('0x' + 'ab'.repeat(32));
  });
  it('never-anchored batch returns null (not "verified")', async () => {
    expect(await readAnchorFromContract(fakeVault, 7)).toBeNull();
  });
});

describe('readPositionFromContract', () => {
  it('registered position decodes entry/stop prices + flags', async () => {
    const p = await readPositionFromContract(fakeVault, '0xpos');
    expect(p.exists).toBe(true);
    expect(p.exitTriggered).toBe(false);
    expect(p.entryPrice).toBe(78240000000000000000n); // 78.24 USDT/WHSK x 1e18
    expect(p.stopPrice).toBe(76675000000000000000n); // 76.6752 = -2% of entry
  });
  it('unknown position reports exists=false', async () => {
    const p = await readPositionFromContract(fakeVault, '0xnope');
    expect(p.exists).toBe(false);
  });
});

describe('tighterCap', () => {
  it('on-chain tighter wins', () => {
    expect(tighterCap(500, 0.1)).toBeCloseTo(0.05);
  });
  it('local tighter wins', () => {
    expect(tighterCap(2000, 0.1)).toBeCloseTo(0.1);
  });
  it('equal caps -> that value', () => {
    expect(tighterCap(1000, 0.1)).toBeCloseTo(0.1);
  });
  it('invalid on-chain value falls back to local (caller handles fail-closed)', () => {
    expect(tighterCap(NaN, 0.1)).toBeCloseTo(0.1);
  });
});
