import { describe, expect, it } from 'vitest';
import { keccak256, toUtf8Bytes } from 'ethers';
import {
  anchorBatch,
  registerVaultPosition,
  exitWouldTrigger,
  triggerExitIfBreached,
  positionIdFor,
  priceToVaultUnits,
} from '../src/vault.js';

// Fake signing wallet: only the chain check matters (133 = testnet).
const fakeWallet = {
  address: '0xF5bDFE902718Bd75d2d6A6070dcdC6FBF9D781DA',
  provider: { getNetwork: async () => ({ chainId: 133n }) },
} as any;

const VAULT = '0x67fD07BeB208878bA248fB6D99110904f9dB5DaF';
const ANCHORED_TOPIC = keccak256(toUtf8Bytes('Anchored(uint256,bytes32)'));

function sentTx(hash: string, logs: Array<{ topics: string[] }> = []) {
  return { hash, wait: async () => ({ status: 1 as const, logs }) };
}

describe('positionIdFor / priceToVaultUnits', () => {
  it('position id is a deterministic bytes32 keccak of the agent id', () => {
    const id = positionIdFor('pos-123');
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(positionIdFor('pos-123')).toBe(id);
    expect(positionIdFor('pos-124')).not.toBe(id);
  });
  it('price scales to 1e18 units (0.0868845 -> 86884500000000000)', () => {
    expect(priceToVaultUnits(0.0868845)).toBe(86884500000000000n);
    expect(priceToVaultUnits(78.24)).toBe(78240000000000000000n);
    expect(() => priceToVaultUnits(0)).toThrow(/invalid price/);
  });
});

describe('anchorBatch', () => {
  it('parses batchId from the Anchored event in the receipt', async () => {
    const writer = {
      anchor: async () => sentTx('0xaaa', [{ topics: [ANCHORED_TOPIC, '0x' + (7).toString(16).padStart(64, '0'), '0x' + 'ab'.repeat(32)] }]),
      registerPosition: async () => sentTx('0xbbb'),
      exitIfBreached: async () => sentTx('0xccc'),
    };
    const out = await anchorBatch(fakeWallet, VAULT, '0x' + 'cd'.repeat(32), writer);
    expect(out).toEqual({ txHash: '0xaaa', batchId: 7 });
  });
  it('rejects a zero batch hash and a receipt without the Anchored event', async () => {
    const writer = {
      anchor: async () => sentTx('0xaaa', []),
      registerPosition: async () => sentTx('0xbbb'),
      exitIfBreached: async () => sentTx('0xccc'),
    };
    await expect(anchorBatch(fakeWallet, VAULT, '0x' + '00'.repeat(32), writer)).rejects.toThrow(/non-zero bytes32/);
    await expect(anchorBatch(fakeWallet, VAULT, '0x' + 'cd'.repeat(32), writer)).rejects.toThrow(/no Anchored event/);
  });
  it('refuses a non-testnet wallet', async () => {
    const mainnetWallet = { ...fakeWallet, provider: { getNetwork: async () => ({ chainId: 177n }) } };
    const writer = { anchor: async () => sentTx('0xaaa'), registerPosition: async () => sentTx('0xbbb'), exitIfBreached: async () => sentTx('0xccc') };
    await expect(anchorBatch(mainnetWallet, VAULT, '0x' + 'cd'.repeat(32), writer)).rejects.toThrow(/REFUSED/);
  });
});

describe('registerVaultPosition', () => {
  it('sends entry/stop in 1e18 units keyed by the hashed position id', async () => {
    let seen: any = null;
    const writer = {
      anchor: async () => sentTx('0xaaa'),
      registerPosition: async (id: string, entry: bigint, stop: bigint) => { seen = { id, entry, stop }; return sentTx('0xreg'); },
      exitIfBreached: async () => sentTx('0xccc'),
    };
    const tx = await registerVaultPosition(fakeWallet, VAULT, 'pos-1', 0.0868845, 0.085, writer);
    expect(tx).toBe('0xreg');
    expect(seen.id).toBe(positionIdFor('pos-1'));
    expect(seen.entry).toBe(86884500000000000n);
    expect(seen.stop).toBe(85000000000000000n);
  });
  it('refuses a stop >= entry (client-side, before any tx)', async () => {
    const writer = {
      anchor: async () => sentTx('0xaaa'),
      registerPosition: async () => sentTx('0xreg'),
      exitIfBreached: async () => sentTx('0xccc'),
    };
    await expect(registerVaultPosition(fakeWallet, VAULT, 'pos-1', 0.0868845, 0.09, writer)).rejects.toThrow(/stop .* must be/);
  });
});

describe('exitWouldTrigger / triggerExitIfBreached', () => {
  it('static-call success -> true; revert -> false (no tx sent either way)', async () => {
    const ok = { exitIfBreachedStatic: async () => undefined };
    expect(await exitWouldTrigger(null as any, VAULT, 'pos-1', ok)).toBe(true);
    const no = { exitIfBreachedStatic: async () => { throw new Error('stop not breached'); } };
    expect(await exitWouldTrigger(null as any, VAULT, 'pos-1', no)).toBe(false);
  });
  it('trigger sends the tx and returns its hash', async () => {
    const writer = {
      anchor: async () => sentTx('0xaaa'),
      registerPosition: async () => sentTx('0xreg'),
      exitIfBreached: async () => sentTx('0xexit'),
    };
    expect(await triggerExitIfBreached(fakeWallet, VAULT, 'pos-1', writer)).toBe('0xexit');
  });
});
