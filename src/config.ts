// Config: chains, contracts, tokens. Addresses verified live 2026-11-23
// (eth_getCode on testnet RPC; source of truth @hskswap/sdk-core 1.0.3).
import { readFileSync } from 'node:fs';
export const TESTNET_RPC = 'https://testnet.hsk.xyz';
export const MAINNET_RPC = 'https://mainnet.hsk.xyz';
export const TESTNET_CHAIN_ID = 133;
export const MAINNET_CHAIN_ID = 177;

export const TESTNET_SUBGRAPH =
  'https://graphnode-testnet.hashkeychain.net/subgraphs/name/uniswap-v3/hsk-test';
export const MAINNET_SUBGRAPH =
  'https://graphnode.hashkeychain.net/subgraphs/name/hskswap';

export const ADDR = {
  factory: '0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0',
  router: '0xa6914E66690c6794244B5f66a09eAEbf66254237',
  quoter: '0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC',
  nfpm: '0x73dEc6bfa6751509b08480bd97f54b874E3b20e8',
  whsk: '0xca8aaceec5db1e91b9ed3a344ba026c4a2b3ebf6',
  usdt: '0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f',
  usdc: '0x93f960a8dab5a541e93e6ddacd54f49a1750de81',
} as const;

// Mainnet addresses (from sdk-core; mainnet only — NEVER use on chain 133).
export const MAINNET_ADDR = {
  factory: '0x972cA9D1662F5e029cD18327D29026532E84c742',
  router: '0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3',
  quoter: '0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD',
  whsk: '0xB210D2120d57b758EE163cFfb43e73728c471Cf1',
} as const;

// Supra Push Oracle (DORA S-Values) — verified live 2026-11-23 (see src/supra.ts).
// Testnet contract has code on chain 133; mainnet address recorded for
// reference only — this agent NEVER talks to mainnet (chain 177 refused).
// STALENESS WARNING: feed was ~6-7 days stale on both chains at integration
// time despite a documented 6h cadence; see src/supra.ts staleness rule.
export const SUPRA = {
  testnet: '0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917',
  mainnet: '0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57',
  pairHskUsd: 517,
  pairBtcUsd: 0,
} as const;

export const POOLS = {
  lowFee: {
    id: '0xff2b7e501c870980bf5641b4a70d0f9fb0f6f6ab',
    fee: 500,
    label: 'USDT/WHSK 0.05%',
  },
  highFee: {
    id: '0xc076fb478b77633736738579c7f48d2539604a50',
    fee: 3000,
    label: 'USDT/WHSK 0.3%',
  },
} as const;

export interface AgentConfig {
  /** seconds between polls */
  pollSeconds: number;
  /** min signal score (0-100) to trade */
  minScore: number;
  /** max fraction of equity per trade (0-1) */
  perTradeCap: number;
  /** max fraction of equity deployed per day */
  dailyCap: number;
  /** stop-loss fraction per position, e.g. 0.02 = -2% */
  stopLoss: number;
  /** daily loss limit fraction -> halt for the day */
  dailyLossLimit: number;
  /** max drawdown from equity peak -> halt until reset */
  maxDrawdown: number;
  /** risk appetite 0-1: scales size within caps */
  riskAppetite: number;
  /** starting paper equity, in test USDT */
  paperEquityUsdt: number;
  /** slippage tolerance in bps */
  slippageBps: number;
  /** max age (seconds) for a Supra oracle reading to count as fresh (default 86400 = 24h) */
  supraMaxAgeSec: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  pollSeconds: 60,
  minScore: 60,
  perTradeCap: 0.1,
  dailyCap: 0.3,
  stopLoss: 0.02,
  dailyLossLimit: 0.05,
  maxDrawdown: 0.1,
  riskAppetite: 0.5,
  paperEquityUsdt: 1000,
  slippageBps: 50,
  supraMaxAgeSec: 86400,
};

export function loadEnv(): { rpcUrl: string; privateKey?: string } {
  // Minimal .env loader (no dotenv dependency): KEY=VALUE lines, no logging of values.
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no .env — paper mode needs none */
  }
  return { rpcUrl: out.RPC_URL ?? TESTNET_RPC, privateKey: out.PRIVATE_KEY };
}

// --- v2 additions (appended 2026-11-23; existing values above untouched) ---

// EAS (Ethereum Attestation Service) — LIVE on HSK testnet via OP Stack
// predeploys; verified live 2026-11-23 (eth_getCode non-empty on chain 133).
export const EAS = {
  eas: '0x4200000000000000000000000000000000000021',
  schemaRegistry: '0x4200000000000000000000000000000000000020',
  // Flow's trade schema, already registered on testnet 133 — reuse it, do
  // NOT re-register the same schema string (duplicate registration reverts).
  flowSchemaUid: '0x1c0c01e337924a140372f0043e9a9a3125e0e276b6dae78382676b3d0e53a04f',
  flowSchema:
    'bytes32 proposalId,bytes32 rationaleHash,bytes32 txHash,uint256 notionalUsd,bool exitPath,string engine,string origin',
} as const;

// Flow's public test tokens (verified live 2026-11-23: decimals, symbols,
// faucet() present). v1's 0x98b6173a USDT pool is 18-dec, no faucet and
// ~620x mispriced vs oracle — do NOT trade off it; use these instead.
export const TEST_TOKENS = {
  tUsdt: '0xD57a8171b83E154145f47DcE512786173a9A36ca',
  tWhsk: '0x198c3EC5530463290e2F16988Bf6B8006F4C6995',
  tWbtc: '0x2C7A171A58AE1690Cf1e01e296aB0CF9Dfc04aA2',
  // tUSDT faucet: 1,000/call, 1h cooldown. tWHSK faucet: 10,000/call.
  // tWBTC faucet: 0.01/call.
} as const;

// Liquid, fairly-priced test pair (verified live 2026-11-23): token0 = tWHSK
// (18 dec), token1 = tUSDT (6 dec), fee 3000, price ~$0.0869 ≈ oracle.
export const T_POOL = {
  id: '0x840fa6e439F52cEa60dABec8BBB820DE80dDb542',
  fee: 3000,
  label: 'tWHSK/tUSDT 0.3%',
} as const;

// RiskVault deployments (testnet 133). v1 is superseded by v2 (see report);
// both stay deployed, v1 is never deleted.
export const VAULTS = {
  v1: '0x4D3fF0EE974b93C22103046715B20EC451c4f467',
  v2: '0x9bF92125ba39c9a23D373aeFb408d7aF1C14A193', // deployed 2026-11-23, superseded by v3
  // v3 (deployed 2026-11-23, integration pass): poolKind-aware price math so
  // exitIfBreached() works on the tWHSK/tUSDT pool. Pool set to the t-pool
  // tx 0x549b55adfeb8ee2fae5dc95ca551a7e02160c78a3146bc14ca9288645ed95b87,
  // poolKind 1 tx 0xe4b599a6a0bbbb5a4c5dd3bafe22053f7ca57ca7d8b6a70489fcaf2510dc6863.
  // Verified live: caps 1000/3000/200/1000/500; stop-below-price does not
  // trigger, stop-above-price triggers (exitIfBreached tx 0x81c00ac7...).
  v3: '0x67fD07BeB208878bA248fB6D99110904f9dB5DaF',
} as const;

// Target observation cardinality for pool TWAP reads. Verified live
// 2026-11-23: low-fee demo pool = 1, high-fee = 16, tWHSK/tUSDT = 64.
export const OBSERVE_CARDINALITY_TARGET = 64;

// 5-minute TWAP window (seconds) the RiskVault v2 exitIfBreached() uses.
export const VAULT_TWAP_WINDOW_SEC = 300;
