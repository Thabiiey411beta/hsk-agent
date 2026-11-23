# TOPIC B — Routing, quoting and execution on HSKSwap (testnet, chain 133)

Research date: 2026-11-23 ~10:05–10:12 SAST. All addresses below were verified two ways:
(a) `@hskswap/sdk-core@1.0.3` source on npm (jsDelivr CDN), and (b) live on-chain
reads against `https://testnet.hsk.xyz` (chainId `0x85`, block ~36,132,773) plus
Blockscout verified-source lookups at `https://testnet-explorer.hskchain.net`.
Cross-checked against Flow's live testnet deployment
(`AceVikings/horizon-hack-flow`, `deployments/133.json`, real trades 2 Nov 2026).

---

## 1. SDKs — what they expose, current versions

### `@hskswap/sdk-core` — latest `1.0.3` (versions: 1.0.0–1.0.3). Current. ✅
Fork of `@uniswap/sdk-core` with HashKey chains added:
`ChainId.HASHKEY_TESTNET = 133`, `ChainId.HASHKEY_MAINNET = 177`,
`NativeCurrencyName.HSK = "HSK"`.
Key exports: `Token`, `CurrencyAmount`, `Percent`, `Price`, `TradeType`
(`EXACT_INPUT`/`EXACT_OUTPUT`), `ChainId`, `WETH9`, `CHAIN_TO_ADDRESSES_MAP`,
`V3_CORE_FACTORY_ADDRESSES`, `QUOTER_ADDRESSES`,
`NONFUNGIBLE_POSITION_MANAGER_ADDRESSES`, `SWAP_ROUTER_02_ADDRESSES(chainId)`.
`WETH9[133]` = WHSK `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` (verified in source,
`dist/sdk-core.cjs.development.js` L1512).

### `@hskswap/smart-order-router` — latest `1.0.4` (versions: 1.0.0–1.0.4)
Fork of `@uniswap/smart-order-router`. `package.json` pins the HSK forks:
`"@uniswap/sdk-core": "npm:@hskswap/sdk-core@1.0.3"`,
`"@uniswap/universal-router-sdk": "npm:@hskswap/universal_router_sdk@1.0.4"`,
plus `@uniswap/router-sdk ^2.3.1`, `@uniswap/v3-sdk ^3.27.0`,
`@uniswap/swap-router-contracts ^1.3.1`, `@uniswap/v2-sdk`, `@uniswap/v4-sdk`.
It ships a HashKey jest suite (`test:hsk` → `test/unit/hashkeychain`).

**⚠️ ethers version mismatch:** the SOR depends on **`ethers ^5.7.2`**
(`@ethersproject/providers` `BaseProvider`). Our agent uses **ethers v6**.
Do not mix providers: either run the SOR behind an ethers-v5 provider, or
(much simpler) use the SOR only for quotes and build/send the swap with
ethers v6 manually — see §4 snippet 1.

### What `AlphaRouter` exposes (verified from `build/main/routers/*.d.ts`, v1.0.4)

```ts
route(
  amount: CurrencyAmount,          // in-token for EXACT_INPUT, out-token for EXACT_OUTPUT
  quoteCurrency: Currency,
  tradeType: TradeType,            // TradeType.EXACT_INPUT | EXACT_OUTPUT
  swapConfig?: SwapOptions,        // omit for quote-only; provide for calldata
  partialRoutingConfig?: Partial<AlphaRouterConfig>,
): Promise<SwapRoute | null>
```

`SwapRoute` = `{ quote, quoteGasAdjusted, estimatedGasUsed, estimatedGasUsedQuoteToken,
estimatedGasUsedUSD, gasPriceWei, trade, route: RouteWithValidQuote[],
blockNumber, methodParameters?: { calldata, value, to }, ... }`.
`methodParameters` is only populated when `swapConfig` is passed.

- **Multi-hop:** yes — `AlphaRouterConfig.maxSwapsPerPath` (routes are `V3Route` /
  `V2Route` / `V4Route` / `MixedRoute`; on HSK testnet only V3 pools exist, so
  in practice V3-only).
- **Split routing:** yes — `maxSplits`, `minSplits`, `distributionPercent`
  (e.g. 5 ⇒ splits in multiples of 5%); `route[].percent` gives each leg's share.
- **Exact-output:** yes — `TradeType.EXACT_OUTPUT` (quote = amountIn required).
- **Pool selection:** `v3PoolSelection: { topN, topNDirectSwaps, topNTokenInOut,
  topNSecondHop, topNWithEachBaseToken, ... }`; `protocols?: Protocol[]` to restrict.
- **SwapRouter02 calldata:** pass `swapConfig = { type: SwapType.SWAP_ROUTER_02,
  recipient, slippageTolerance: new Percent(n, 10_000), deadline: epochSeconds,
  simulate?: { fromAddress } }`, then send `methodParameters.to` /
  `methodParameters.calldata` / `methodParameters.value`. An optional
  `inputTokenPermit` field exists for permit-based approval (see §4 — our test
  tokens have no `permit()`, so it is unusable here).
- The SOR also supports `SwapType.UNIVERSAL_ROUTER` (Universal Router
  `0x76D86a…d56918` on mainnet per Avow docs) — no testnet Universal Router
  address is published in the SDK; use `SWAP_ROUTER_02` on testnet.

Minimal V3-only wiring (ethers v5, standard upstream class names — the fork
re-exports them from `build/main/index`):

```ts
import { ethers } from 'ethers'; // v5
import { ChainId, CurrencyAmount, Percent, Token, TradeType } from '@hskswap/sdk-core';
import {
  AlphaRouter, SwapType, V3SubgraphProvider, V3PoolProvider,
  OnChainQuoteProvider, TokenProvider, SwapRouterProvider,
  EIP1559GasPriceProvider, V3GasModelFactory,
} from '@hskswap/smart-order-router';

const provider = new ethers.providers.JsonRpcProvider('https://testnet.hsk.xyz');
const router = new AlphaRouter({
  chainId: ChainId.HASHKEY_TESTNET, provider,
  v3SubgraphProvider: new V3SubgraphProvider(ChainId.HASHKEY_TESTNET),
  v3PoolProvider: new V3PoolProvider(ChainId.HASHKEY_TESTNET, provider),
  onChainQuoteProvider: new OnChainQuoteProvider(
    ChainId.HASHKEY_TESTNET, provider, /* multicall2Provider */ undefined),
  tokenProvider: new TokenProvider(ChainId.HASHKEY_TESTNET, provider),
  gasPriceProvider: new EIP1559GasPriceProvider(provider),
  v3GasModelFactory: new V3GasModelFactory(),
  swapRouterProvider: new SwapRouterProvider(provider, ChainId.HASHKEY_TESTNET),
});

const route = await router.route(
  CurrencyAmount.fromRawAmount(tokenIn, amountInRaw),
  tokenOut, TradeType.EXACT_INPUT,
  { type: SwapType.SWAP_ROUTER_02, recipient: wallet.address,
    slippageTolerance: new Percent(50, 10_000), // 0.5%
    deadline: Math.floor(Date.now() / 1000) + 1800 },
  { protocols: ['V3' as any], v3PoolSelection: {
    topN: 2, topNDirectSwaps: 2, topNTokenInOut: 2, topNSecondHop: 1,
    topNWithEachBaseToken: 0, topNWithBaseToken: 0 },
    maxSwapsPerPath: 2, maxSplits: 1, minSplits: 1, distributionPercent: 5 },
);
// route!.methodParameters.{ to, calldata, value } → send as one tx.
```

Note: the SOR's V3 subgraph default for testnet is
`https://graphnode-testnet.hashkeychain.net/subgraphs/name/hskdex-subgraph-testnet`
(see §5 — this supersedes the older `uniswap-v3/hsk-test` URL in earlier docs).

---

## 2. HSKSwap testnet contracts — VERIFIED

| Contract | Address | Verification |
|---|---|---|
| V3 Factory | `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0` | ✅ sdk-core `HASHKEY_TESTNET_ADDRESSES` + on-chain code 24,535 B + Blockscout `UniswapV3Factory` |
| SwapRouter02 | `0xa6914E66690c6794244B5f66a09eAEbf66254237` | ✅ sdk-core + on-chain 24,497 B + Blockscout `SwapRouter02` |
| QuoterV2 | `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC` | ✅ sdk-core + on-chain 8,273 B + Blockscout `QuoterV2` |
| NonfungiblePositionManager | `0x73dEc6bfa6751509b08480bd97f54b874E3b20e8` | ✅ sdk-core + on-chain 24,384 B |
| WHSK (Wrapped HSK) | `0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6` | ✅ sdk-core `WETH9[133]` + on-chain `name="Wrapped HSK" symbol="WHSK" decimals=18` + Blockscout `WHSK` (has `deposit()`/`withdraw()`) |
| Multicall (sdk-core) | `0x47F625Ec29637445AA1570d7008Cf78692CdA096` | ✅ sdk-core + on-chain 1,383 B |
| Multicall3 (standard) | `0xcA11bde05977b3631167028862bE2a173976CA11` | ✅ on-chain 3,808 B (used by Flow) |
| TickLens | `0x73942976823088508a2C6c8055DF71107DB1d8db` | ✅ sdk-core + on-chain 1,385 B |
| V3Migrator | `0x59fF56C0c051C281d56524bf39FC737f6b566258` | ✅ sdk-core + on-chain 7,700 B |

All six "known values" from the task brief are **correct** for factory, router,
quoter, NFPM and WHSK. Mainnet (for reference, also in sdk-core):
factory `0x972cA9D1662F5e029cD18327D29026532E84c742`,
router `0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3`,
quoter `0x603f70466fDdbE3F238220B9a74FFF419a2BbFDD`,
NFPM `0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5`,
WHSK `0xB210D2120d57b758EE163cFfb43e73728c471Cf1`.

### ⚠️ Test USDT — the "known" address is real but it is NOT the tradeable one

- `0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f` = **"USDT", 18 decimals**
  (not 6!), `SimpleERC20`, totalSupply 1e9, **no `mint()`/`faucet()`** — only
  `transfer/approve`. It has a WHSK pool (below) but its price is broken (§3).
- The liquid, fairly-priced test USDT is Flow's **`tUSDT`
  `0xD57a8171b83E154145f47DcE512786173a9A36ca`** — "Test Tether USD (ATE
  testnet)", **6 decimals**, `TestToken` with a **public `faucet()`**.
- Sibling Flow test tokens: **`tWHSK`
  `0x198c3EC5530463290e2F16988Bf6B8006F4C6995`** (18 dec, faucet) and **`tWBTC`
  `0x2C7A171A58AE1690Cf1e01e296aB0CF9Dfc04aA2`** (8 dec, faucet).

### Pools (all fee 3000, all confirmed via `factory.getPool` + `slot0()`)

| Pool | Address | token0 / token1 | tick | Price (live, 2026-11-23) | Liquidity |
|---|---|---|---|---|---|
| tWHSK / tUSDT | `0x840fa6e439F52cEa60dABec8BBB820DE80dDb542` | tWHSK / tUSDT | −300757 | **$0.0869 / WHSK** (≈ Supra oracle $0.0874 ✅) | 7.44e17 |
| tWBTC / tUSDT | `0x9d6A06ae873aD5d34ef13Ac8afE3BA80d1A5eF07` | tWBTC / tUSDT | 66500 | **~$77,250 / BTC** | 1.78e9 |
| WHSK / USDT(98b6) | `0xc076fb478b77633736738579c7f48d2539604a50` | USDT / WHSK | −39926 | **~$54 / WHSK — 620× above oracle ⚠️** | 3.23e21 |

The WHSK/USDT(98b6) pool price is stale/nonsense (pool was likely seeded with an
inverted initial price). Do **not** use it as a price reference and do not route
the demo strategy through it — it would "print" ~620× too much USDT per WHSK
sold and the reverse trade would be ruinous. `getPool(WHSK, tUSDT, 3000)` =
`0x0`: there is **no** pool between canonical WHSK and Flow's tUSDT.

---

## 3. Token inventory — where test USDT comes from

Wallet state per brief: ~0.099 tHSK, 0 test USDT, 0 WHSK. Paths:

1. **tHSK (gas):** thirdweb faucet, 0.01 tHSK/day —
   `https://thirdweb.com/hashkey-chain-testnet(discard)` (guide:
   `https://blog.thirdweb.com/faucet-guides/how-to-get-free-hashkey-token-thsk-from-hashkey-chain-testnet-faucet/`).
   0.099 tHSK is already plenty (see gas math, §4).
2. **Wrap tHSK → WHSK:** `WHSK.deposit()` payable (WETH9-style), 1:1.
   `withdraw(uint256)` unwraps. No separate wrapper contract.
3. **Test USDT — recommended: Flow's TestToken `faucet()`** (verified source):
   ```solidity
   function faucet() external {
     uint256 last = lastFaucetAt[msg.sender];
     if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN)
       revert FaucetCooldown(last + FAUCET_COOLDOWN);
     lastFaucetAt[msg.sender] = block.timestamp;
     _mint(msg.sender, faucetAmount);
   }
   ```
   Anyone can call it; `mint(to, amount)` is owner-only.
   - tUSDT `0xD57a…`: `faucetAmount()` = **1,000 tUSDT** (1,000,000,000 raw, 6 dec),
     `FAUCET_COOLDOWN()` = **3600 s (1 h)**.
   - tWHSK `0x198c…`: **10,000 tWHSK** per call, 1 h cooldown.
   - tWBTC `0x2C7A…`: **0.01 tWBTC** per call, 1 h cooldown.
   This is exactly how Flow funded its real 2 Nov 2026 testnet trades.
4. **Test USDT — alternative:** swap WHSK → USDT(98b6) on pool `0xc076fb47`
   (works, but price ~$54/HSK — see warning above). No HSKSwap-operated test
   USDT faucet was found (no faucet flow on `app.hskswap.com`; `hskswap.com`
   DNS fails; no docs site found).
5. **Recommended live-trade pair for the agent: tWHSK / tUSDT, pool
   `0x840fa6e4`, fee 3000.** Both legs come from the public faucet, price is
   fair vs the Supra oracle, and the path is proven by Flow's on-chain trades.
   If the strategy must trade canonical WHSK, wrap first — but then the only
   USDT counterparty is the broken 98b6 pool.

### Live quotes measured via QuoterV2 (tuple form, §4) — block ~36,132,773

- `1 tWHSK → 0.086631 tUSDT` (gasEstimate 74,019)
- `100 tUSDT → 1,146.87 tWHSK` (gasEstimate 82,444)
- Exact-output: `10 tUSDT out costs 115.436 tWHSK` (gasEstimate 73,795)
- `0.01 WHSK → 0.5402 USDT(98b6)` — confirms the $54/HSK pool price.

---

## 4. Approve flow + execution (ethers v6 — recommended path)

**Critical fork quirk:** this fork's `QuoterV2` and `SwapRouter02` take
**struct/tuple params, not 5–7 loose args**. The loose-arg form reverts
(verified on-chain). Signatures (from Blockscout verified ABIs):

```solidity
// QuoterV2
quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn,
  uint24 fee, uint160 sqrtPriceLimitX96)) -> (amountOut, sqrtPriceX96After,
  initializedTicksCrossed, gasEstimate)   // selector 0xc6a5026a
quoteExactOutputSingle((address tokenIn, address tokenOut, uint256 amountOut,
  uint24 fee, uint160 sqrtPriceLimitX96)) -> (amountIn, ...)  // 0xbd21704a
quoteExactInput(bytes path, uint256 amountIn) -> (...)
// SwapRouter02
exactInputSingle((address tokenIn, address tokenOut, uint24 fee,
  address recipient, uint256 amountIn, uint256 amountOutMinimum,
  uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)
exactInput((address tokenIn, address tokenOut, uint256 amountIn,
  uint256 amountOutMinimum, bytes path)) // multi-hop path encoding
```

Quoter functions are `nonpayable` and revert internally with the result, so in
ethers v6 call them via **`.staticCall()`** (a plain call would try to send a tx).

```ts
import { ethers } from 'ethers';
const provider = new ethers.JsonRpcProvider('https://testnet.hsk.xyz');
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const WHSK  = '0xCA8aAceEC5Db1e91B9Ed3a344bA026c4a2B3ebF6';
const TUSDT = '0xD57a8171b83E154145f47DcE512786173a9A36ca';
const TWHSK = '0x198c3EC5530463290e2F16988Bf6B8006F4C6995';
const ROUTER = '0xa6914E66690c6794244B5f66a09eAEbf66254237';
const QUOTER = '0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC';
const POOL_FEE = 3000;

// 0. Fund test tokens (1 tx each, 1 h cooldown)
const testToken = new ethers.Contract(TUSDT, ['function faucet()'], wallet);
await (await testToken.faucet()).wait();            // +1,000 tUSDT
await (await new ethers.Contract(TWHSK, ['function faucet()'], wallet).faucet()).wait();

// 1. Wrap (only if trading canonical WHSK)
const whsk = new ethers.Contract(WHSK,
  ['function deposit() payable', 'function approve(address,uint256) returns (bool)'], wallet);
await (await whsk.deposit({ value: ethers.parseEther('0.01') })).wait();

// 2. Quote (tuple form, staticCall)
const quoter = new ethers.Contract(QUOTER, [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
], provider);
const [amountOut] = await quoter.quoteExactInputSingle.staticCall({
  tokenIn: TWHSK, tokenOut: TUSDT, amountIn: ethers.parseEther('1'),
  fee: POOL_FEE, sqrtPriceLimitX96: 0 });

// 3. Approve router (exact amount; or use MaxUint256 on testnet)
const tokenIn = new ethers.Contract(TWHSK,
  ['function approve(address spender, uint256 amount) returns (bool)'], wallet);
await (await tokenIn.approve(ROUTER, ethers.parseEther('1'))).wait();

// 4. Swap (tuple form)
const router = new ethers.Contract(ROUTER, [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
], wallet);
const minOut = amountOut * 995n / 1000n; // 0.5% slippage
await (await router.exactInputSingle({
  tokenIn: TWHSK, tokenOut: TUSDT, fee: POOL_FEE, recipient: wallet.address,
  amountIn: ethers.parseEther('1'), amountOutMinimum: minOut, sqrtPriceLimitX96: 0,
})).wait();
```

Notes:
- **Permit:** `SwapRouter02` exposes `selfPermit*` and the SOR has
  `inputTokenPermit`, but none of WHSK / tUSDT / tWHSK / USDT(98b6) implements
  EIP-2612 `permit()` (verified ABIs) — plain `approve()` is the only path.
- **Multicall:** router has `multicall(bytes[])` / `multicall(uint256,bytes[])`
  so approve+swap can be batched into one tx (approve must be a separate
  *call* inside the multicall, still two state changes — no gas saving on the
  approve itself, but one round-trip). `approveMax(token)` exists on the router
  for one-time infinite approval.
- **Gas (measured):** live `eth_gasPrice` = **1.001 gwei**. Real precedent —
  Flow's vault-routed $5 tUSDT→tWHSK swap, tx
  `0xcb10731e34a4ffc0934201ef35d04d8ffb04cb1d2e35871c65e6504f26473afc`
  (block 35206113, confirmed on-chain): **gasUsed 186,687 @ 1.001 gwei ≈
  0.000187 HSK**. A direct router `exactInputSingle` is typically ~130–160k
  gas; `approve` ~46k; `WHSK.deposit` ~30k; `faucet()` ~50–70k. Whole
  faucet+approve+swap sequence ≈ 250–300k gas ≈ **0.0003 HSK** — negligible
  against a 0.099 tHSK balance. (QuoterV2's `gasEstimate` ~74k is the cost of
  the *quote simulation*, not the swap.)
- No HSK-specific gas quirks found; EIP-1559 or legacy pricing both work at
  ~1 gwei. The router is also payable with `wrapETH()` / `unwrapWETH9()` /
  `refundETH()` / `sweepToken()` helpers.

---

## 5. Subgraph vs direct RPC (`slot0`)

### Subgraph — live, but use the SOR 1.0.4 default
- Testnet (current SOR default): **`https://graphnode-testnet.hashkeychain.net/subgraphs/name/hskdex-subgraph-testnet`**
- Mainnet: `https://graphnode.hashkeychain.net/subgraphs/name/hskdex-subgraph`
- Older URLs from earlier docs (`.../name/hskswap`, `.../name/uniswap-v3/hsk-test`)
  still respond, but the SOR 1.0.4 source explicitly warns the hskdex subgraphs
  expose the V3 root field as **`v3Pools`** (not `pools`) — queries must use
  `v3Pools`. Verified live: `_meta.block.number` ≈ 36,120,928 (near head) and
  a `v3Pools(first: 5, orderBy: totalValueLockedUSD)` query returns pools.
  All three pools above are indexed (feeTier 3000, correct symbols/liquidity).
- Caveats: `totalValueLockedUSD` is `0` for the Flow pools (no USD pricing
  configured) and top-by-TVL rows are junk test tokens (TT1/TT2 ≈ $20M) — do
  not rank pools by TVL blindly.

### RPC `slot0()` — recommended for the agent (no subgraph dependency)
```solidity
function slot0() external view returns (
  uint160 sqrtPriceX96, int24 tick, uint16 observationIndex,
  uint16 observationCardinality, uint16 observationCardinalityNext,
  uint8 feeProtocol, bool unlocked);
```
Price derivation (token0/token1 are the pool's sorted tokens):
```
price_token1_per_token0 (human units) = (sqrtPriceX96 / 2**96)**2 × 10**(dec0 − dec1)
tick = 2 · ln(sqrtPriceX96 / 2**96) / ln(1.0001)
```
Verified numerically on-chain:
- tWHSK/tUSDT: sqrt `23354530683081066172474` → (2.948e-7)² × 10¹² = **$0.0869**;
  tick from sqrt −300,756 vs on-chain tick −300,757 ✓.
- tWBTC/tUSDT: sqrt `2202140348795438620217198764554` → **~$77,250**; tick 66,500 ✓.
- WHSK/USDT(98b6): sqrt `10763269204415441255261542937`, token0=USDT,
  token1=WHSK → 0.01846 WHSK per USDT ⇒ **$54.18/HSK** (direction matters:
  here the price is WHSK-per-USDT because token0 is USDT).
Also available per pool: `liquidity()`, `token0()`, `token1()`, `fee()`,
`tickSpacing()`, `observe()` for TWAP (check `observationCardinality` first —
fresh pools may have cardinality 0, making TWAP unavailable until someone
increases it).

```ts
// ethers v6 slot0 price read
const pool = new ethers.Contract(poolAddr, [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
], provider);
const s = await pool.slot0();
const ratio = Number(s.sqrtPriceX96) / 2 ** 96;      // use BigInt math in prod
const price = ratio * ratio * 10 ** (dec0 - dec1);   // token1 per token0
```

---

## 6. Bottom line for the builder

1. **Use pair tWHSK/tUSDT, pool `0x840fa6e4`, fee 3000.** Faucet both legs
   (`faucet()` → 1,000 tUSDT / 10,000 tWHSK per call, 1 h cooldown), approve,
   `exactInputSingle` (tuple form). Price is fair vs oracle; the path is
   proven by Flow's real trades.
2. **Do not use the WHSK/USDT(98b6) pool for the strategy** — price ~$54/HSK
   is broken; the "known" USDT address is real but has no faucet and its only
   pool is unusable for fair trading.
3. **Quote with QuoterV2 tuple form** (`quoteExactInputSingle((...))`,
   selector `0xc6a5026a`, via `.staticCall()` in ethers v6). The 5-arg form
   reverts. Same tuple rule for the router.
4. **SOR 1.0.4 can do multi-hop / split / exact-output**, but it is ethers-v5
   based; simplest is SOR-for-quotes (or skip it — single-hop + direct
   `slot0()` reads already cover the v1 agent's needs) and ethers-v6 manual
   calldata for execution.
5. **Gas is a non-issue:** ~1 gwei; a full faucet+approve+swap sequence costs
   ≈ 0.0003 HSK. The 0.099 tHSK balance covers hundreds of trades.
6. **Subgraph is optional:** `slot0()` + `liquidity()` over RPC gives price
   and depth; if the subgraph is used, query `v3Pools` on
   `hskdex-subgraph-testnet`, not `pools`.

## Sources
- npm registry: `@hskswap/sdk-core` 1.0.3, `@hskswap/smart-order-router` 1.0.4
  (`https://registry.npmjs.org/@hskswap%2Fsdk-core`,
  `https://registry.npmjs.org/@hskswap%2Fsmart-order-router`)
- sdk-core source: `https://cdn.jsdelivr.net/npm/@hskswap/sdk-core@1.0.3/dist/sdk-core.cjs.development.js`
  (ChainId L176–178, `HASHKEY_TESTNET_ADDRESSES` L523–528, `WETH9[133]` L1512)
- SOR source: `https://cdn.jsdelivr.net/npm/@hskswap/smart-order-router@1.0.4/build/main/{util/addresses.js,providers/v3/subgraph-provider.js,routers/alpha-router/alpha-router.d.ts,routers/router.d.ts,providers/index.d.ts,package.json}`
- Flow deployment + journal (real testnet trades):
  `https://github.com/AceVikings/horizon-hack-flow/blob/main/deployments/133.json`,
  `https://github.com/AceVikings/horizon-hack-flow/blob/main/docs/JUDGE.md`,
  `https://github.com/AceVikings/horizon-hack-flow/blob/main/docs/testnet-133-journal.json`
- Explorer: `https://testnet-explorer.hskchain.net` (Blockscout; contract source/ABI
  via `.../api?module=contract&action=getsourcecode&address=...`)
- RPC: `https://testnet.hsk.xyz` (chain 133; needs a browser User-Agent — bare
  requests get HTTP 403; alt RPCs `hashkeychain-testnet.alt.technology`,
  `hashkey-testnet.drpc.org` did not answer from this VM)
- Subgraphs: `https://graphnode-testnet.hashkeychain.net/subgraphs/name/hskdex-subgraph-testnet`
  (and `.../name/uniswap-v3/hsk-test`, still live)
- tHSK faucet: `https://blog.thirdweb.com/faucet-guides/how-to-get-free-hashkey-token-thsk-from-hashkey-chain-testnet-faucet/`
- HSKSwap app: `https://app.hskswap.com/#/swap` (no faucet flow found)

## Open / not verified
- The agent wallet's own balances were not re-checked (address not in scope).
- `observationCardinality` on the pools (TWAP readiness) was not read.
- No official HSKSwap test-token faucet was found — if one exists it is not
  indexed/documented; the working sources are the on-chain `faucet()` calls
  above.
- SOR `AlphaRouter` wiring snippet uses standard upstream provider class names
  re-exported by the fork (`build/main/index` → `export * from './providers'`);
  the builder should confirm exact import names against the installed package.
