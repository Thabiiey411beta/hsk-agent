// QuoterV2 + SwapRouter02 execution path (ethers v6, raw minimal ABIs).
// Live mode: chain check rejects mainnet (177); simulation via eth_call precedes any send.
import { Contract, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { ADDR, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID, TEST_TOKENS } from './config.js';

const QUOTER_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

export interface Quote {
  amountOut: bigint;
  gasEstimate: bigint;
}

export async function quoteExactInputSingle(
  provider: JsonRpcProvider,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  fee: number,
): Promise<Quote> {
  const quoter = new Contract(ADDR.quoter, QUOTER_ABI, provider);
  const [amountOut, , , gasEstimate] = await quoter.quoteExactInputSingle.staticCall({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  });
  return { amountOut: amountOut as bigint, gasEstimate: gasEstimate as bigint };
}

export interface BuiltTx {
  to: string;
  data: string;
  value: bigint;
  gasEstimate: bigint;
}

export function buildExactInputSingle(
  tokenIn: string,
  tokenOut: string,
  fee: number,
  recipient: string,
  amountIn: bigint,
  amountOutMinimum: bigint,
): BuiltTx {
  const router = new Contract(ADDR.router, ROUTER_ABI);
  const data = router.interface.encodeFunctionData('exactInputSingle', [
    { tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0 },
  ]);
  return { to: ADDR.router, data, value: 0n, gasEstimate: 0n };
}

/** Full dry-run: quote -> build tx -> simulate via eth_call. Sends nothing.
 *  The router simulation is EXPECTED to revert for an unfunded wallet (the
 *  router pulls tokenIn from the sender, who holds no test USDT) — that
 *  revert is reported, not hidden: it proves the tx is well-formed up to the
 *  funds gate. The quote itself is the live on-chain price proof. */
export async function dryRunSwap(
  provider: JsonRpcProvider,
  opts: { tokenIn: string; tokenOut: string; amountIn: bigint; fee: number; from: string; slippageBps: number },
): Promise<{ quote: Quote; tx: BuiltTx; simulatedOut: bigint | null; gasEstimate: bigint | null; simulationError: string | null }> {
  const quote = await quoteExactInputSingle(provider, opts.tokenIn, opts.tokenOut, opts.amountIn, opts.fee);
  const minOut = (quote.amountOut * BigInt(10_000 - opts.slippageBps)) / 10_000n;
  const tx = buildExactInputSingle(opts.tokenIn, opts.tokenOut, opts.fee, opts.from, opts.amountIn, minOut);
  try {
    const sim = await provider.call({ ...tx, from: opts.from });
    const simulatedOut = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], sim)[0] as bigint;
    const gasEstimate = await provider.estimateGas({ ...tx, from: opts.from });
    return { quote, tx, simulatedOut, gasEstimate, simulationError: null };
  } catch (e) {
    return { quote, tx, simulatedOut: null, gasEstimate: null, simulationError: (e as Error).message.slice(0, 300) };
  }
}

export async function assertTestnet(provider: JsonRpcProvider): Promise<number> {
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  if (chainId === MAINNET_CHAIN_ID) {
    throw new Error('REFUSED: live mode on mainnet (chain 177) is forbidden — testnet only');
  }
  if (chainId !== TESTNET_CHAIN_ID) {
    throw new Error(`unexpected chain ${chainId}, expected testnet ${TESTNET_CHAIN_ID}`);
  }
  return chainId;
}

/** Wallet balances for the tokens the agent actually trades.
 *  Reads the t-pool tokens (tUSDT 6 dec, tWHSK 18 dec) — NOT the old
 *  synthetic USDT/WHSK pair (0x98b6173a / 0xca8aacee), whose balances are
 *  0 / dust and made the CLI startup line print "test USDT 0" while the
 *  wallet really held 1,000 tUSDT / 10,000 tWHSK. Raw bigint values;
 *  callers format with the token decimals (see cli.ts). */
export async function getBalances(
  provider: JsonRpcProvider,
  address: string,
): Promise<{ hsk: bigint; tUsdt: bigint; tWhsk: bigint }> {
  const hsk = await provider.getBalance(address);
  const tUsdt = new Contract(TEST_TOKENS.tUsdt, ERC20_ABI, provider);
  const tWhsk = new Contract(TEST_TOKENS.tWhsk, ERC20_ABI, provider);
  return {
    hsk,
    tUsdt: (await tUsdt.balanceOf(address)) as bigint,
    tWhsk: (await tWhsk.balanceOf(address)) as bigint,
  };
}

export function walletFromEnv(privateKey: string, provider: JsonRpcProvider): Wallet {
  return new Wallet(privateKey, provider);
}

/** amountOutMinimum for a quoted amount at a slippage tolerance in bps:
 *  quoted * (10000 - slippageBps) / 10000. Pure — used by the live swap
 *  path in src/execution.ts. */
export function minOutAfterSlippage(quotedAmountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps ${slippageBps} out of range 0..10000`);
  }
  return (quotedAmountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
