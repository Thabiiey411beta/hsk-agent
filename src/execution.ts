// Live execution path (testnet only, chain 133). Simulation-before-send and
// fail-closed throughout: a swap is NEVER sent unless its eth_call simulation
// succeeds first; any missing data blocks the trade.
//
// Proven path (verified live 2026-11-23, see research/topic-b-...):
//   faucet tUSDT/tWHSK -> WHSK.deposit() wraps HSK -> ERC20 approve(router)
//   -> QuoterV2 quote -> SwapRouter02 exactInputSingle (tuple params).
// Approve is plain ERC20 approve — NO permit() exists on any test token.
// Gas ~1 gwei; faucet+approve+swap ≈ 0.0003 HSK.
//
// All functions take an explicit provider/wallet — they NEVER read .env
// themselves (the caller passes the wallet in). No keys are ever logged.
import { Contract, ethers, type JsonRpcProvider, type Wallet } from 'ethers';
import { ADDR, TEST_TOKENS, TESTNET_CHAIN_ID } from './config.js';
import {
  assertTestnet,
  buildExactInputSingle,
  minOutAfterSlippage,
  quoteExactInputSingle,
} from './quoter.js';

export const WHSK_ABI = ['function deposit() payable'] as const;
export const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const;
export const FAUCET_ABI = ['function faucet()'] as const;

/** Chain-check on a wallet's provider (not just a passed provider): the
 *  wallet is what signs, so its chain is what matters. Refuses 177 outright. */
export async function assertWalletTestnet(wallet: Wallet): Promise<number> {
  const provider = wallet.provider;
  if (!provider) throw new Error('wallet has no provider — cannot verify chain, refusing');
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`REFUSED: expected testnet ${TESTNET_CHAIN_ID}, wallet is on chain ${chainId}`);
  }
  return chainId;
}

export interface TxResult {
  txHash: string;
}

/** Minimal sent-tx surface (what wrap/approve/faucet need from a contract). */
export interface SentTxLike {
  hash: string;
  wait(): Promise<{ status: number | null } | null>;
}

/** Optional seams for tests: inject contract factories instead of building
 *  live ethers Contracts. Production passes nothing (live path). */
export interface ContractDeps {
  whskContract?: (wallet: Wallet) => { deposit(opts: { value: bigint }): Promise<SentTxLike> };
  erc20Contract?: (token: string, wallet: Wallet) => { approve(spender: string, amount: bigint): Promise<SentTxLike> };
  faucetContract?: (token: string, wallet: Wallet) => { faucet(): Promise<SentTxLike> };
}

/** Wrap native HSK -> WHSK via WHSK.deposit() (WETH9-style), value = amount. */
export async function wrapHsk(
  wallet: Wallet,
  amountWei: bigint,
  deps: ContractDeps = {},
): Promise<TxResult> {
  await assertWalletTestnet(wallet);
  if (amountWei <= 0n) throw new Error('wrapHsk: amount must be > 0');
  const whsk = deps.whskContract
    ? deps.whskContract(wallet)
    : (new Contract(ADDR.whsk, WHSK_ABI, wallet) as unknown as {
        deposit(opts: { value: bigint }): Promise<SentTxLike>;
      });
  const tx = await whsk.deposit({ value: amountWei });
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`wrapHsk tx reverted: ${tx.hash}`);
  return { txHash: tx.hash as string };
}

/** Plain ERC20 approve(spender, amount). No permit — test tokens have none. */
export async function approveToken(
  wallet: Wallet,
  token: string,
  spender: string,
  amount: bigint,
  deps: ContractDeps = {},
): Promise<TxResult> {
  await assertWalletTestnet(wallet);
  if (amount <= 0n) throw new Error('approveToken: amount must be > 0');
  const erc20 = deps.erc20Contract
    ? deps.erc20Contract(token, wallet)
    : (new Contract(token, ERC20_ABI, wallet) as unknown as {
        approve(spender: string, amount: bigint): Promise<SentTxLike>;
      });
  const tx = await erc20.approve(spender, amount);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`approveToken tx reverted: ${tx.hash}`);
  return { txHash: tx.hash as string };
}

export interface SwapOpts {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  amountIn: bigint;
  slippageBps: number;
}

export interface SwapResult extends TxResult {
  /** Quoted amountOut from QuoterV2 (before slippage). */
  quotedAmountOut: bigint;
  amountOutMinimum: bigint;
  /** amountOut returned by the eth_call simulation (expected fill). */
  simulatedAmountOut: bigint;
}

/** Optional seams for tests: inject a quoter / simulator instead of hitting
 *  the live QuoterV2 + RPC. Production passes nothing (live path). */
export interface SwapDeps {
  quoteFn?: (
    provider: JsonRpcProvider,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    fee: number,
  ) => Promise<{ amountOut: bigint; gasEstimate: bigint }>;
  simulateFn?: (tx: { to: string; data: string; value: bigint }, from: string) => Promise<bigint>;
}

/** Execute one exactInputSingle swap on SwapRouter02.
 *  1. Chain-check (testnet only). 2. Quote via QuoterV2. 3. Build the tuple
 *  tx with amountOutMinimum = quoted x (1 - slippage). 4. Simulate via
 *  eth_call — if the simulation reverts, REFUSE to send (throws, no tx).
 *  5. Send, wait for 1 confirmation, return the tx hash + simulated fill.
 *  NOTE: no swap is executed by this module on its own — callers must only
 *  invoke it when a signal has cleared the agent's gates (integration pass). */
export async function executeSwap(
  wallet: Wallet,
  opts: SwapOpts,
  deps: SwapDeps = {},
): Promise<SwapResult> {
  await assertWalletTestnet(wallet);
  if (opts.amountIn <= 0n) throw new Error('executeSwap: amountIn must be > 0');
  if (opts.slippageBps < 0 || opts.slippageBps > 10_000) {
    throw new Error(`executeSwap: slippageBps ${opts.slippageBps} out of range 0..10000`);
  }
  const provider = wallet.provider as JsonRpcProvider;
  const quoteFn = deps.quoteFn ?? quoteExactInputSingle;
  const quote = await quoteFn(provider, opts.tokenIn, opts.tokenOut, opts.amountIn, opts.fee);
  if (quote.amountOut <= 0n) throw new Error('executeSwap: quoter returned zero amountOut — refusing');
  const amountOutMinimum = minOutAfterSlippage(quote.amountOut, opts.slippageBps);
  const tx = buildExactInputSingle(
    opts.tokenIn,
    opts.tokenOut,
    opts.fee,
    wallet.address,
    opts.amountIn,
    amountOutMinimum,
  );
  // Simulation-before-send: eth_call from the wallet address.
  let simulatedAmountOut: bigint;
  try {
    if (deps.simulateFn) {
      simulatedAmountOut = await deps.simulateFn(tx, wallet.address);
    } else {
      const sim = await provider.call({ ...tx, from: wallet.address });
      simulatedAmountOut = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], sim)[0] as bigint;
    }
  } catch (e) {
    throw new Error(
      `executeSwap: simulation reverted — refusing to send. ${(e as Error).message.slice(0, 300)}`,
    );
  }
  if (simulatedAmountOut < amountOutMinimum) {
    throw new Error(
      `executeSwap: simulated out ${simulatedAmountOut} < minimum ${amountOutMinimum} — refusing`,
    );
  }
  const sent = await wallet.sendTransaction(tx);
  const receipt = await sent.wait();
  if (receipt?.status !== 1) throw new Error(`executeSwap tx reverted on-chain: ${sent.hash}`);
  return {
    txHash: sent.hash,
    quotedAmountOut: quote.amountOut,
    amountOutMinimum,
    simulatedAmountOut,
  };
}

export type FaucetToken = 'tUSDT' | 'tWHSK';

/** Claim from Flow's public test-token faucets (testnet only, chain-checked).
 *  tUSDT: 1,000/call, 1h cooldown. tWHSK: 10,000/call. The faucet() call
 *  itself reverts while on cooldown — that revert is surfaced, not hidden. */
export async function getFaucetTokens(
  wallet: Wallet,
  which: FaucetToken | 'both',
  deps: ContractDeps = {},
): Promise<{ token: FaucetToken; txHash: string }[]> {
  await assertWalletTestnet(wallet);
  const wanted: FaucetToken[] = which === 'both' ? ['tUSDT', 'tWHSK'] : [which];
  const out: { token: FaucetToken; txHash: string }[] = [];
  for (const token of wanted) {
    const address = token === 'tUSDT' ? TEST_TOKENS.tUsdt : TEST_TOKENS.tWhsk;
    const faucet = deps.faucetContract
      ? deps.faucetContract(address, wallet)
      : (new Contract(address, FAUCET_ABI, wallet) as unknown as {
          faucet(): Promise<SentTxLike>;
        });
    const tx = await faucet.faucet();
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error(`faucet(${token}) tx reverted: ${tx.hash}`);
    out.push({ token, txHash: tx.hash as string });
  }
  return out;
}

/** Read-only ERC20 balance (no tx). */
export async function getTokenBalance(
  provider: JsonRpcProvider,
  token: string,
  address: string,
): Promise<bigint> {
  const erc20 = new Contract(token, ERC20_ABI, provider);
  return (await erc20.balanceOf(address)) as bigint;
}

/** Read-only ERC20 allowance (no tx). */
export async function getAllowance(
  provider: JsonRpcProvider,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const erc20 = new Contract(token, ERC20_ABI, provider);
  return (await erc20.allowance(owner, spender)) as bigint;
}
