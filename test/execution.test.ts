import { describe, expect, it } from 'vitest';
import type { Wallet } from 'ethers';
import {
  approveToken,
  assertWalletTestnet,
  executeSwap,
  getFaucetTokens,
  wrapHsk,
} from '../src/execution.js';
import { minOutAfterSlippage } from '../src/quoter.js';

function fakeWallet(chainId = 133n, overrides: Record<string, unknown> = {}): Wallet {
  return {
    address: '0xF5bDFE902718Bd75d2d6A6070dcdC6FBF9D781DA',
    provider: { getNetwork: async () => ({ chainId }) },
    sendTransaction: async () => ({ hash: '0xsend', wait: async () => ({ status: 1 }) }),
    ...overrides,
  } as unknown as Wallet;
}

const okTx = (hash: string) => ({ hash, wait: async () => ({ status: 1 }) });

describe('chain checks', () => {
  it('testnet wallet passes', async () => {
    await expect(assertWalletTestnet(fakeWallet())).resolves.toBe(133);
  });
  it('mainnet wallet (177) is refused outright', async () => {
    await expect(assertWalletTestnet(fakeWallet(177n))).rejects.toThrow(/REFUSED/);
  });
  it('wrong chain is refused', async () => {
    await expect(assertWalletTestnet(fakeWallet(1n))).rejects.toThrow(/expected testnet 133/);
  });
  it('wallet without a provider is refused', async () => {
    const w = { address: '0xabc' } as unknown as Wallet;
    await expect(assertWalletTestnet(w)).rejects.toThrow(/no provider/);
  });
});

describe('minOutAfterSlippage (quoter addition)', () => {
  it('50 bps on 1000 -> 995', () => {
    expect(minOutAfterSlippage(1000n, 50)).toBe(995n);
  });
  it('0 bps -> unchanged; out-of-range throws', () => {
    expect(minOutAfterSlippage(1000n, 0)).toBe(1000n);
    expect(() => minOutAfterSlippage(1000n, 10001)).toThrow();
    expect(() => minOutAfterSlippage(1000n, -1)).toThrow();
  });
});

describe('wrapHsk / approveToken (injected contracts)', () => {
  it('wrap passes value through and returns tx hash', async () => {
    let seen: { value: bigint } | null = null;
    const r = await wrapHsk(fakeWallet(), 1000n, {
      whskContract: () => ({
        deposit: async (opts: { value: bigint }) => {
          seen = opts;
          return okTx('0xwrap');
        },
      }),
    });
    expect(r.txHash).toBe('0xwrap');
    expect(seen!.value).toBe(1000n);
  });
  it('wrap rejects zero amount before any call', async () => {
    await expect(wrapHsk(fakeWallet(), 0n)).rejects.toThrow(/must be > 0/);
  });
  it('wrap surfaces a reverted tx', async () => {
    await expect(
      wrapHsk(fakeWallet(), 1000n, {
        whskContract: () => ({
          deposit: async () => ({ hash: '0xbad', wait: async () => ({ status: 0 }) }),
        }),
      }),
    ).rejects.toThrow(/reverted/);
  });
  it('approve passes spender + amount and returns tx hash', async () => {
    let seen: { spender: string; amount: bigint } | null = null;
    const r = await approveToken(fakeWallet(), '0xtoken', '0xrouter', 500n, {
      erc20Contract: () => ({
        approve: async (spender: string, amount: bigint) => {
          seen = { spender, amount };
          return okTx('0xapprove');
        },
      }),
    });
    expect(r.txHash).toBe('0xapprove');
    expect(seen).toEqual({ spender: '0xrouter', amount: 500n });
  });
});

describe('executeSwap simulation-before-send', () => {
  const base = { tokenIn: '0xD57a8171b83E154145f47DcE512786173a9A36ca', tokenOut: '0x198c3EC5530463290e2F16988Bf6B8006F4C6995', fee: 3000, amountIn: 1000n, slippageBps: 50 };
  it('sends only after a successful simulation, minOut = quoted x (1 - slippage)', async () => {
    let sent: unknown = null;
    const w = fakeWallet(133n, {
      sendTransaction: async (tx: unknown) => {
        sent = tx;
        return { hash: '0xswap', wait: async () => ({ status: 1 }) };
      },
    });
    const r = await executeSwap(
      w,
      base,
      {
        quoteFn: async () => ({ amountOut: 2000n, gasEstimate: 100000n }),
        simulateFn: async () => 1995n,
      },
    );
    expect(r.txHash).toBe('0xswap');
    expect(r.quotedAmountOut).toBe(2000n);
    expect(r.amountOutMinimum).toBe(1990n);
    expect(r.simulatedAmountOut).toBe(1995n);
    expect(sent).not.toBeNull();
  });
  it('simulation revert -> REFUSES to send (no tx)', async () => {
    let sent = false;
    const w = fakeWallet(133n, { sendTransaction: async () => { sent = true; return { hash: '0x', wait: async () => ({ status: 1 }) }; } });
    await expect(
      executeSwap(w, base, {
        quoteFn: async () => ({ amountOut: 2000n, gasEstimate: 100000n }),
        simulateFn: async () => { throw new Error('execution reverted: insufficient balance'); },
      }),
    ).rejects.toThrow(/simulation reverted — refusing to send/);
    expect(sent).toBe(false);
  });
  it('simulated out below minimum -> refuses', async () => {
    const w = fakeWallet();
    await expect(
      executeSwap(w, base, {
        quoteFn: async () => ({ amountOut: 2000n, gasEstimate: 100000n }),
        simulateFn: async () => 1000n, // below minOut 1990
      }),
    ).rejects.toThrow(/simulated out .* < minimum/);
  });
  it('zero quote -> refuses', async () => {
    const w = fakeWallet();
    await expect(
      executeSwap(w, base, {
        quoteFn: async () => ({ amountOut: 0n, gasEstimate: 0n }),
        simulateFn: async () => 0n,
      }),
    ).rejects.toThrow(/zero amountOut/);
  });
  it('mainnet wallet -> refuses before quoting', async () => {
    const w = fakeWallet(177n);
    await expect(
      executeSwap(w, base, {
        quoteFn: async () => { throw new Error('should not be called'); },
      }),
    ).rejects.toThrow(/REFUSED/);
  });
});

describe('getFaucetTokens (injected contracts)', () => {
  it('claims both faucets, one tx each, in order', async () => {
    const seen: string[] = [];
    const r = await getFaucetTokens(fakeWallet(), 'both', {
      faucetContract: (token: string) => ({
        faucet: async () => {
          seen.push(token);
          return okTx('0xfaucet-' + token.slice(2, 6));
        },
      }),
    });
    expect(r).toHaveLength(2);
    expect(r[0].token).toBe('tUSDT');
    expect(r[1].token).toBe('tWHSK');
    expect(seen).toHaveLength(2);
  });
  it('single-token claim only calls that faucet', async () => {
    const r = await getFaucetTokens(fakeWallet(), 'tUSDT', {
      faucetContract: () => ({ faucet: async () => okTx('0xone') }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].token).toBe('tUSDT');
  });
});
