# HSK Horizon — Verifiable AI Trading Agent (Track 1)

## What it is
A paper-first, **verifiable** AI trading agent on HSKSwap (HSK Chain testnet, chain 133).
Every decision it makes — signal, size, risk check, outcome — is logged with its
reasons to a JSONL decision journal, so any trade can be audited after the fact.
Its primary market is the fairly-priced **tWHSK/tUSDT pool** (0.3% fee tier,
`0x840fa6e4...`, price ~$0.0869 ≈ the Supra oracle). It scores a
Supra-oracle-reference + on-chain-TWAP-deviation + swap-volume-trend signal,
applies a hard trend gate, sizes by ATR when the data supports it, enforces the
tighter of on-chain (RiskVault v3) vs local caps, and executes (paper by
default; testnet via SwapRouter02 with `--live`, one trade max per run).
The old USDT/WHSK pools are synthetic and frozen — they are read only as a
logged diagnostic, never priced off, never traded.

## Strategy
- **Primary market: tWHSK/tUSDT (0.3% pool).** Token order token0 = tWHSK
  (18 dec), token1 = tUSDT (6 dec) — the decimal correction is load-bearing:
  tick −300757 → ~0.0869 tUSDT/tWHSK. Spot and TWAPs come from the pool's
  `observe()` (24h and 7d windows) and `slot0()`, not from the subgraph.
- **Supra oracle reference (30 pts):** the Supra Push Oracle (DORA S-Values)
  HSK/USD price (pair 517) is the external anchor — is the pool actually cheap
  vs the wider market? See the "Supra Push Oracle reference" section below.
  Only a FRESH reading scores; stale/missing scores 0 and is journaled as such.
  On the fairly-priced t-pool a fresh reading behaves normally (pool 0.0869 vs
  oracle 0.08426 = +3.1%, ~−9 pts), unlike the saturated −30 on the synthetic
  pools. **Fallback while Supra is stale:** the off-chain reference median
  (CoinGecko + Kraken + Gate.io + MEXC, explicitly NOT an oracle) may fill
  this same slot, capped at **14 pts** — see "Reference median fallback
  (NOT an oracle)" below. A fresh Supra always wins; the median never
  overrides it, and 14 + TWAP 45 = 59 < 60, so the median can never be the
  component that pushes the score over threshold.
- **TWAP vs current price (45 pts):** price vs the **24h** `observe()` TWAP.
  A short-term dip below the recent average adds conviction (full 45 at ≥10%
  below); a price above it subtracts. Largest weight because it is the only
  component built from live, pool-native history. The 7d TWAP deviation is
  reported as a diagnostic — scoring vs 7d while the trend gate requires
  price ≥ 7d TWAP would cap the score at 55 whenever the gate passes, making
  threshold 60 unreachable by construction (see `src/trend.ts`).
- **Swap-volume trend (25 pts):** rising t-pool swap count in the last hour vs
  the previous hour adds conviction. The t-pool's last swap was Nov 4 2026, so
  this scores 0 until activity resumes, and the journal says why.
- **Old-pool cross-fee spread: NOT scored.** There is only one t-pool fee tier,
  so there is no spread to score. The old pools' spread is logged as a
  diagnostic only — those pools are synthetic (~643–928x the oracle) and frozen
  since ~Nov 1; the spread is not a tradable edge.
- Signal score 0–100 (supra 30 + twap 45 + volume 25). Trade only when score ≥
  threshold (default 60) **and** the trend gate passes **and** all risk gates
  pass. No single component can trigger a trade. No signal, no trade — missing
  data blocks (fail-closed).

## Trend gate (hard safety rule, not a user toggle)
Before any long entry, ALL of these must hold (see `src/trend.ts`):
- price ≥ 7d `observe()` TWAP — the market is not below its long average;
- 24h TWAP ≥ 7d TWAP — the recent average is not falling below the long one
  (flat/rising slope proxy; a true 30d window reverts `OLD` on every pool, so
  7d is the longest honest window, and the slope is proxied by 24h-vs-7d
  because one `observe()` window cannot give TWAP-now vs TWAP-7d-ago);
- ADX(14) < 25 when computable — skipped, never faked, when fewer than 15
  daily bars exist (the t-pool has 3 daily bars, so ADX is currently skipped).
The comparison is `>=`, not strict `>`: on a frozen pool price == TWAP exactly,
and strict `>` could never pass until someone else trades — `>=` means "not in
a downtrend". A failed gate is journaled with the TWAP values; there is no chat
command to disable it.

## ATR sizing (volatility-adjusted)
1% of equity risked per trade, stop = 2× ATR(14) on daily bars built from
subgraph swap ticks (gap-aware true range). The computed stop is wired into the
position's stop-loss (local exit check) and the vault's `registerPosition`
stopPrice. ATR needs ≥15 daily bars; with fewer, the agent falls back to the
fixed 2% stop + cap sizing and journals the fallback. Live, the t-pool has 3
daily bars, so ATR is currently unavailable (fallback). See `src/atr.ts`.

## Risk model (fail-closed)
- Per-trade cap: max 10% of paper equity (default, adjustable via chat).
- Daily cap: max 30% of equity deployed per day; daily loss limit 5% → halt for the day.
- Stop-loss: −2% per position (default; ATR stop when available); max drawdown 10% from equity peak → halt until reset.
- Missing data (TWAP revert, vault caps unreadable, vault poolKind mismatch,
  quote fails) = **block**, never trade. A failed vault read blocks trading
  that poll; a vault `halted` flag blocks; a poolKind ≠ 1 blocks (the on-chain
  stop would misprice).
- On-chain caps live in `RiskVault.sol` v3; the agent reads them **every poll**
  and enforces the tighter of on-chain vs local config for per-trade cap,
  daily cap, stop-loss, drawdown, and daily loss limit.
- Live mode refuses chain 177 (mainnet) outright, refuses to run with no funds,
  executes at most ONE live trade per run, capped at 10 tUSDT notional on the
  first live trade, and never auto-approves the router (insufficient allowance
  blocks with a clear message).

## Execution path
1. RPC `observe()` → t-pool 24h/7d TWAP + spot; subgraph → old-pool diagnostic
   spread + t-pool swap history (volume/ATR bars); `eth_call` → Supra pair 517.
2. Vault v3 `caps()` + `poolKind()` every poll (tighter-of rule).
3. Signal → trend gate → ATR/fallback sizing → risk gates.
4. Paper: virtual fill at spot, journal entry, vault `registerPosition`
   attempted when a signing wallet is present (skipped + journaled otherwise).
   Live: QuoterV2 quote → `executeSwap` (simulation via `eth_call` first;
   refuses on revert or simulated-out < minimum) → fill → vault registration →
   journal-batch anchor on the vault → EAS attestation (Flow's schema UID).
   Dry-run: quote → build → simulate, sends nothing.
5. Journal: every poll, signal, decision, fill, exit, vault read, gate, ATR —
   `data/journal.jsonl`. A live fill anchors the batch hash on-chain and
   attests the trade via EAS; paper fills never anchor/attest.

## Architecture
```
src/
  config.ts      chains, contracts, tokens (addresses from @hskswap/sdk-core 1.0.3), defaults
  math.ts        sqrtPrice→price, TWAP, spread, score helpers (pure, tested)
  signal.ts      scoreSignal() — old two-pool signal (backtest only now)
                 scoreTPoolSignal() — supra 30 + TWAP(24h) 45 + volume 25 → 0–100
  supra.ts       SupraReader — DORA tuple getSvalue, staleness rule (24h default), fail-closed
  observe.ts     getPoolTwap() via pool observe(), cardinality helpers (read-only)
  trend.ts       checkTrendGate() — price >= 7d TWAP, 24h TWAP >= 7d TWAP, ADX < 25 when available
  atr.ts         buildDailyBars(), computeAtr(), sizeByAtr() — 1% risk, 2x ATR stop
  execution.ts   wrapHsk / approveToken / executeSwap (simulation-before-send) / faucets
  vault.ts       RiskVault v3 client: readCaps, readPoolKind, anchorBatch,
                 registerVaultPosition, exitWouldTrigger, triggerExitIfBreached
  attest.ts      hashEntry / verifyChain / buildChain + EAS attestTrade (Flow schema UID)
  sizing.ts      sizePosition() — caps, risk-appetite scaling (fallback when ATR unavailable)
  risk.ts        RiskGate — daily cap, stop-loss, drawdown halt, missing-data block
  journal.ts     append-only JSONL decision journal
  subgraph.ts    GraphQL client (pools, swaps) — testnet + mainnet URLs
  quoter.ts      QuoterV2 eth_call + SwapRouter02 tx builder (ethers v6)
  backtest.ts    replay subgraph swaps through signal/sizing/risk (+ t-pool replay)
  agent.ts       poll loop: TWAP → signal → vault caps → trend gate → sizing → paper/live execute → journal
  chat.ts        natural-language command parser (positions, pnl, size, frequency, risk, assets, show supra/twap/vault)
  server.ts      tiny HTTP server: web UI + /api/state + /api/chat + /api/journal
  cli.ts         entrypoint: --paper (default) | --live [--once] | --backtest | --dry-run | --once
contracts/
  RiskVault.sol  on-chain caps (per-trade, daily, stop-loss, drawdown) + anchor +
                 registerPosition + exitIfBreached (poolKind-aware price math, v3)
scripts/
  deploy.ts      Hardhat deploy script (testnet + mainnet). MAINNET NOT RUN — needs Newton's approval + funds.
public/
  index.html     web UI + chat
```

## Supra Push Oracle reference

External price anchor for the signal. Supra Push Oracle (DORA S-Values) is a
**partner feed on HSK, not the sole official one** — HSK Chain also adopted
Chainlink Data Streams as its official data solution; do not claim otherwise.

- Addresses: testnet `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917` (chain 133),
  mainnet `0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57` (recorded only — the
  agent never touches mainnet). Documented cadence 6h, 0.5% deviation
  (docs.supra.com, updated 17 Nov 2026).
- Interface: the DORA tuple — `getSvalue(uint256 _pairIndex) view returns
  (tuple(uint256 round, uint256 decimals, uint256 time, uint256 price))`.
  The older `checkPrice(string)` interface **reverts** on these contracts for
  every pair tested — never use it. `time` is in milliseconds; `price` is
  scaled by 10^`decimals` (18 in all live reads). Pair 0 = BTC/USD,
  pair 517 = HSK/USD. HSK ≈ WHSK 1:1, so HSK/USD is the reference for the
  WHSK/USDT pool price (USDT ≈ USD 1:1 — documented approximation).
- Implementation: `src/supra.ts` (`SupraReader.readPair`) — read-only
  `eth_call`, returns the reading or `null` on any failure (revert, bad decode,
  zero price, implausible timestamp). The agent (`src/agent.ts`) reads pair 517
  every poll, journals a `supra` entry (price, age, fresh/stale), and exposes it
  in `/api/state` + the web UI.
- Staleness rule: `maxAgeSec` configurable, default 86400 (24h). A reading with
  `ageSec > maxAgeSec` is STALE and the reference is treated as MISSING —
  fail-closed, exactly like a missing TWAP: the component scores 0 and the
  journal records why. A stale price is never silently used as if fresh.
- **Observed staleness (2026-11-23, re-verified live at integration time): the
  feed is ~6–7 days stale on BOTH chains.** Testnet pair 517: $0.08426,
  ~6.2 days old; pair 0 (BTC): $64,346, ~6.1 days old; mainnet pair 517:
  $0.083745, ~6.9 days old. Values are plausible but old — the documented 6h
  cadence is NOT being met right now. Consequence: the supra component scores
  0 on testnet until Supra resumes pushing. This is reported plainly, not hidden.
- **Saturation on the OLD pools (not the t-pool):** when the feed IS fresh,
  expect the component to saturate at −30 on the synthetic pools. Pool WHSK
  trades at ~54–78 USDT/WHSK vs the oracle's $0.08426 — a ~643x gap on the
  cheap pool (~6,420,000 bps) and ~928x on the expensive pool (~9,280,000 bps).
  Testnet WHSK is synthetic and detached from the real HSK price. The deviation
  is clamped (±30 pts at ≥1000 bps), the raw bps value is journaled unclamped,
  and the code is deliberately NOT retuned to look reasonable on testnet
  numbers — on mainnet, where pool and oracle agree within a few %, the same
  code behaves normally. On the fairly-priced t-pool (0.0869 vs 0.08426 =
  +3.1%), a fresh reading scores ~−9 pts, not −30.
- **Known risk (not a blocker):** a July 2026 Bonzo Lend oracle exploit on
  another chain involved Supra. Noted as a known risk; the agent only reads the
  feed off-chain as a conviction component (never a gate, never an on-chain
  dependency), so a bad feed can cost conviction points, not funds.
- **Oracle landscape on HSK (verified 2026-11-23):** Chainlink Price Feeds and
  Pyth are NOT on HSK. **APRO was re-verified live 23 Nov 12:51 SAST (block
  36122222) and stays OUT — all three testnet feeds are ~224 days stale, and
  the USDT feed's data is not credible:** BTC/USD `0x64697A…` $70,799.45,
  updated 2026-04-13T05:12:04Z (224.2d old, documented heartbeat 4h);
  USDT/USD `0xC45D52…` $2,195.05 — a nonsensical value for a stablecoin —
  updated 2026-04-13T06:17:10Z (224.2d old, heartbeat 4h); USDC/USD
  `0xCdB10d…` $1.00014981, updated 2026-04-12T16:51:20Z (224.8d old,
  heartbeat 24h). Contracts exist (7,061 bytes each) and `latestRoundData()`
  returns without reverting, so the ABI is right — the feeds are simply dead:
  no pushes since April 2026. A stale second feed adds nothing but noise,
  and the USDT feed's $2,195 reading would have made any peg check actively
  harmful. Testnet also has NO APRO HSK/USD feed (BTC/USDT/USDC only), so
  APRO could never have been a second HSK price on testnet anyway. The
  mainnet HSK/USD feed (`0x86CE42…`, documented 0.5%/1h) was NOT verified —
  mainnet is out of scope (decision deferred). Re-check condition: if a
  testnet feed ever pushes within its documented heartbeat, re-verify and
  only then wire it in as peg validation / redundancy (never a scoring
  component on its own). Full evidence in
  `workspace/goals/hsk-chain-horizon-hackathon-ai-agent-trading/hidden_files/apro-20261123.md`.
  On-chain TWAP via pool `observe()` works live (1h–7d
  windows; 30d reverts `OLD` — the t-pool is <30d old; the low-fee pool's
  observation cardinality is still 1 despite `cardinalityNext` 64, because
  cardinality only grows when a new observation is written). Flow's Supra adapter contracts
  (HSK `0xeCC8Fe21c7C0D39988856b6B67860bAe55A8c9A2`, BTC
  `0x9bbb840B9e1086177507D958E40668f3cEF99372`) mirror the same Nov 17 data via
  `latestRoundData()` if a Chainlink-style read is ever needed — same
  staleness caveat applies.
- **Backtest limitation:** no historical Supra series exists, so the backtest
  calls the signal WITHOUT a reference and the component scores 0
  (missing) for every event. Backtest improvement comes from the trend filter,
  not from Supra. The t-pool backtest additionally substitutes trailing-swap
  TWAP proxies for the live `observe()` TWAPs (labelled as proxies).
- **Unit check:** 1.0001^tick is WHSK per USDT (tick −43,600 → 0.0128); the
  agent inverts it to USDT per WHSK (78.24). A "0.012781 USDT per WHSK" figure
  is that inversion error — the agent's price handling is correct, confirmed
  against the live QuoterV2 dry-run (10 USDT → 0.1277 WHSK; 10/0.1277 = 78.3).
  On the t-pool the decimal correction runs the other way (token0 tWHSK 18 dec,
  token1 tUSDT 6 dec): 1.0001^tick × 10^12 = tUSDT per tWHSK (~0.0869).

## Reference median fallback (NOT an oracle)

**It is NOT an oracle.** No cryptographic signing, no on-chain verification,
no decentralised consensus. It is the median of four independent centralised
venues, used only as a fallback reference price while every on-chain oracle is
stale. It trusts CoinGecko and three CEX public APIs and this VM's network path
to them. Every log, journal entry and signal reason that touches it carries the
label `source: "reference-median (NOT an oracle)"`, and the signal records
which reference was used (`referenceSource: 'supra' | 'reference-median' |
'none'`). Attestations cannot add a field (Flow's schema is fixed) — but the
attested rationale hash covers the journal entries, which carry the label, so
no attestation can silently claim an oracle price when the median was the source.

- **Sources (no key, no payment, no deployment):** CoinGecko
  `hashkey-ecopoints` (NOT `hashkey-platform-token` — that id 404s), Kraken
  HSK/USD, Gate.io HSK/USDT, MEXC HSK/USDT. **Excluded on purpose:** HashKey
  Exchange HSK/USD printed $0.08434 (+4.7% above consensus) in the same
  CoinGecko ticker list — venue divergence is real, which is why the median +
  spread gate exist. Binance does not list HSK; KuCoin is geo-blocked from
  this VM; DexScreener does not index HSK Chain.
- **Rules (`src/referenceMedian.ts`, mirrors `src/supra.ts`):** parallel
  fetches, 5 s timeout each, one read per 60 s poll. CoinGecko
  `last_updated_at` must be ≤120 s old; Kraken/Gate/MEXC carry no timestamp,
  so a successful response counts as fresh at fetch time. Require ≥3 of 4
  sources; take the median; **reject if spread (max−min)/median > 2% or fewer
  than 3 respond**. Last-good median is cached for max 5 min and served only
  after a *fetch* failure — a spread rejection is never masked by the cache,
  because current venue disagreement is evidence. Stale/missing = component
  scores 0, fail-closed, journaled.
- **Precedence and cap:** a fresh Supra reading ALWAYS wins — the median is
  not even fetched while Supra is fresh. While Supra is stale the median fills
  the reference slot at **±14 pts** (`REFERENCE_MEDIAN_MAX_POINTS`), the
  largest cap that keeps median(14) + TWAP(45) = 59 < threshold 60: the median
  can never be the component that pushes the score over threshold. Threshold 60
  and the hard trend gate are unchanged. The median never overrides
  Supra/trend-gate discipline and never scores on its own.
- **Honest limits:** CEX spot prices ≠ on-chain HSKSwap execution prices;
  HSK liquidity is thin (Kraken 24h vol ~2,100 HSK; Gate ~107k HSK), so the
  reference can diverge from what the agent could actually execute on-chain.
  The on-chain t-pool TWAP remains the execution-reality check. A compromised
  or rate-limited API, or a venue going stale, silently degrades it — hence
  the spread gate, the ≥3-source rule and the 5-minute max age. CoinGecko
  keyless is ~5 calls/min on a shared pool — fine at 60 s cadence, unfit for
  anything faster. If the demo runs from different egress, re-verify all four
  endpoints from there. For a hackathon testnet agent this is a legitimate,
  disclosed fallback. It would **not** be acceptable as the price source for a
  production mainnet trading system — that needs a live, signed on-chain oracle.
- **Why it exists (verified live 2026-11-23):** Supra is ~6.2 days stale and
  scores 0 fail-closed; APRO is dead on testnet (no push since Apr 2026).
  RedStone was re-checked immediately before integration (23 Nov ~13:10 SAST):
  `api.redstone.finance` and both `oracle-gateway` hosts still return empty
  replies (HTTP 000) for HSK and for ETH — no HSK feed, gateway unreachable
  from this VM. RedStone, DIA (HSK 404), API3, Tellor, Band, Chronicle, UMA
  (no HSK feed/deployment), Chainlink Data Streams (paid, $150/mo+, no free
  tier), Pyth (no HSK) and Binance (HSK not listed) were all investigated and
  closed — full evidence in
  `workspace/goals/hsk-chain-horizon-hackathon-ai-agent-trading/hidden_files/opensource-oracle-fallback-20261123.md`.
- **Live evidence at integration (2026-11-23 13:10 SAST, `node dist/cli.js
  --once`, paper):** Supra pair 517 $0.08426, 537,576 s old (~6.22 days),
  stale. Median **$0.080631** from all 4 venues, spread 0.198%, fresh.
  Signal score **0** (median component −11: pool 0.0868845 vs median +776
  bps; TWAP 0, volume 0), `referenceSource: 'reference-median'` — no trade,
  correctly. The stale Supra value sits +4.5% above the live median.

## Modes
- **Paper (default):** virtual positions, real subgraph/RPC data, full journal. No keys, no funds.
- **`--live`:** testnet only. Requires `PRIVATE_KEY` in `.env` (fresh testnet-only wallet),
  chain-id check rejects 177, funds check first. **One live trade max per run,
  ≤ 10 tUSDT notional.** `--live --once` runs a single poll and exits.
- **`--dry-run`:** proves the full execution path without sending: quote → build tx →
  simulate via `eth_call` → report gas + expected output. No funds needed.
  Now quotes tUSDT → tWHSK on the t-pool (fee 3000).
- **`--backtest [days] [--weights v1|v2] [--gate|--no-gate] [--atr|--no-atr]`:** replays real testnet subgraph swap history through the
  same signal/sizing/risk code; reports trades, win rate, PnL in token terms,
  plus the t-pool's own swap history through the new signal. Backtest/paper
  numbers are **never** presented as live profit. `--weights v1` reproduces
  the original pre-Supra weights (spread 50 + TWAP 30 + volume 20) with no
  gate and no ATR sizing (v1 predates both); v2 (default) is the current
  weights with the gate and ATR sizing on. Explicit flags override the
  weights default, so each factor's effect is isolable.

## Backtest before/after (2026-11-23, same 82-event dataset, 101 low-pool swaps)

All numbers below are re-runnable from the shipped code
(`node dist/cli.js --backtest 365 ...`). Full audit:
`workspace/goals/hsk-chain-horizon-hackathon-ai-agent-trading/hidden_files/backtest-audit-20261123.md`.
Paper equity 1,000 USDT, threshold 60 in every variant. No Supra
reference exists in any backtest, so the supra component scores 0 in all
variants — the v1/v2 difference is the spread/TWAP/volume rebalance only.

| Command | signals | gate-blocked | trades | wins | PnL |
|---|---|---|---|---|---|
| `--weights v1` | 11 | 0 | 8 | 0 | −42.73 USDT (−4.27%) |
| `--weights v1 --gate` | 26 | 26 | 0 | 0 | 0 |
| `--weights v1 --atr` | 9 | 0 | 7 | 0 | −88.42 USDT (−8.84%) |
| `--weights v2` | 0 | 0 | 0 | 0 | 0 |
| `--weights v2 --no-gate` | 0 | 0 | 0 | 0 | 0 |
| `--weights v2 --no-gate --no-atr` | 0 | 0 | 0 | 0 | 0 |

- **v1 baseline (original weights spread 50 + TWAP 30 + volume 20, no gate,
  fixed 2% stop): 82 events, 8 trades, 0 wins, −42.73 USDT (−4.27%).**
  (The record's "101 events" was the low-pool swap count; the replay itself
  has 82 events.) The v1 weights are a reconstruction from the phase-2
  report — there is no git history in this repo to check them against —
  but the reconstruction reproduces the recorded baseline to the cent.
  The 8th "trade" is the mark-to-market close at end of replay, not a
  real exit; the 7 real exits are all stop-losses at −5.8% to −10.5%
  (stops gap through on sparse data).
- **Old weights + trend gate (isolated gate test): 26 signals seen, 26
  gate-blocked, 0 trades, 0 PnL.** Every one of the 8 losing v1 entries was
  price far below TWAP (a collapsing market) — the gate vetoed all of them.
  That is the filter working, not a bug; parameters were NOT tuned to squeeze
  wins out of 8 trades. (`signalsSeen` is 11 in the v1 run but 26 here
  because it counts threshold-crossing events evaluated while flat — in the
  ungated run later events are exits, not new signals.)
- **v1 + ATR sizing: 7 trades, −88.42 USDT (−8.84%) — ATR sizing made the
  v1 losses WORSE.** On a collapsing series the daily ATR is enormous, so
  the 2×ATR stop is very wide (one trade exited −64.97%); the fixed 2%
  stop capped losses sooner. ATR sizing is not a loss-limiter on sparse,
  gapping data.
- **Current signal weights, no gate: 82 events, 0 trades, 0 PnL** (the
  Supra rebalance alone already keeps the agent out: spread 40 + TWAP 15
  caps at 55 with no Supra series and flat volume — below threshold 60
  before the gate is even consulted).
- **New signal + trend gate + ATR sizing (old-pool replay): 82 events,
  0 trades, 0 PnL, gateBlocked 0 (nothing reached the gate), ATR not used
  (no trade was ever sized).** 15 daily bars exist in the old-pool series, so
  ATR is computable there — it just never gets a trade to size.
- **T-pool replay (26 swaps, Nov 2–4 2026, 3 daily bars): 0 trades, 0 PnL.**
  Frozen price → TWAP deviation 0, no volume, no fresh Supra → score 0 on
  every event. ATR unavailable (3 < 15 bars) → fallback path recorded.

**Honest limitation — read before citing the gate:** the trend gate is
NOT demonstrated by a runnable backtest under the current (v2) weights.
Under v2 nothing reaches the gate on real data (0 signals in all three
v2 variants), so the gate's veto is observable only under v1 weights
(26/26) and on synthetic fixtures in the unit tests. The t-pool replay
(the current agent's actual market) has 3 daily bars and a frozen price:
too little history for any backtest claim. Present the gate as a hard
safety rule with unit tests, not as backtest-validated. The backtest
also uses a 20-swap trailing TWAP as the 7d proxy with the 24h-vs-7d
slope treated as flat, so it exercises the price-vs-TWAP leg of the gate
only, not the full two-leg gate the live agent applies.

## Verified facts used (2026-11-23, re-checked live at integration time)
- Testnet RPC `https://testnet.hsk.xyz`, chain 133, gas ~1 gwei. Mainnet chain 177, gas ~500 gwei (single snapshot; 500.001 gwei at the 23 Nov ~13:15 SAST check). Mainnet RiskVault deploy measured live: `eth_estimateGas` 2,517,143 gas on both chains → ~1.26 HSK at 500 gwei, ~1.30 HSK expected with setPool/setPoolKind, 2.60 HSK budgeted at 2x margin (see `MAINNET-NOTE.md`).
- Testnet: Factory `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0`, SwapRouter02
  `0xa6914E66690c6794244B5f66a09eAEbf66254237`, QuoterV2
  `0x73820d9eE5Bf1BfcD429580320FC7A374E8fa1cC`, WHSK
  `0xca8aaceec5db1e91b9ed3a344ba026c4a2b3ebf6` (18 dec), test USDT
  `0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f` (18 dec).
- **Primary market (verified live 2026-11-23 ~12:25 SAST):** tWHSK/tUSDT pool
  `0x840fa6e4...`, fee 3000, token0 = tWHSK (18 dec), token1 = tUSDT (6 dec),
  price 0.0868845, cardinality 64, TWAPs 1h/24h/7d frozen (no swaps since
  Nov 4), 30d reverts (pool <30d old). tUSDT `0xD57a...` (6 dec, faucet
  1,000/call, 1h cooldown), tWHSK `0x198c...` (faucet 10,000/call).
  Wallet `0xF5bD...781DA`: 0.0887 tHSK, 1,000 tUSDT, 10,000 tWHSK, 0.001 WHSK,
  100 tUSDT approved to the router. (HSK re-checked live 23 Nov ~13:15 SAST;
  it drifts down slowly with gas spend — 0.0917 at the earlier check.)
- **Old pools (diagnostic only):** USDT/WHSK 0.05%
  `0xff2b7e501c870980bf5641b4a70d0f9fb0f6f6ab` (78.24, cardinality 1,
  `cardinalityNext` 64 — the earlier "1→64" claim was the *next* value, not
  the live cardinality), 0.3% `0xc076fb478b77633736738579c7f48d2539604a50`
  (54.18, cardinality 16). Both frozen since ~Nov 1, synthetic pricing.
- Subgraph USD figures are all `"0"` — no USD pricing; price derived from `sqrtPrice`.
  The subgraph has NO `v3Pools` root field (query errors) — use `pools`/`swaps`.
- **RiskVault v3** `0x67fD07BeB208878bA248fB6D99110904f9dB5DaF` (deployed
  2026-11-23, integration pass): pool = t-pool, poolKind = 1, caps
  1000/3000/200/1000/500, halted false. Verified live: stop below price does
  not trigger; stop above price triggers (`exitIfBreached` tx `0x81c00a...`).
  Anchor batch 0 tx `0xdca992...` (v2) / batch 1 tx `0xf28cdb...` (v3).
  v1 `0x4D3f...` and v2 `0x9bF9...` stay deployed, superseded.
- Faucet `https://faucet-testnet.hsk.xyz/` unreachable from this VM (curl 000).
  No test HSK obtained at build time — see `FUNDS.md`.
- DoraHacks rules (verified): mainnet deployment required for demo eligibility
  AND prize claim; "migrate after" claim unverified. See `MAINNET-NOTE.md`.
- Supra Push Oracle (verified live 2026-11-23, re-verified at integration):
  testnet `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917`, DORA tuple `getSvalue`
  interface, pair 517 = HSK/USD ($0.08426, ~6.2 days stale), pair 0 = BTC/USD
  ($64,346, ~6.1 days stale). `checkPrice(string)` reverts — not used. Feed
  ~6–7 days stale on both chains despite a documented 6h cadence; the supra
  signal component therefore scores 0 on testnet until Supra resumes pushing.
  Pool-vs-oracle gap on the OLD pools ~643–928x (~6.42–9.28M bps) — synthetic
  testnet pricing; the component is designed to saturate at −30 in that regime,
  not retuned. On the t-pool the gap is +3.1% (fairly priced).
- **Live trade status (integration pass): NO live trade executed.** Live
  `--once` poll 2026-11-23 ~12:35 SAST: signal 0/100 (frozen t-pool, stale
  Supra, no volume) < 60 → no trade, correctly. The threshold was NOT lowered
  to force a trade. The one-live-trade allowance is unspent.

## Differentiation
Not vault-arbitrage, not a bytecode gate, not reputation scoring. The angle is
**verifiability**: a paper-first agent whose every decision is logged with reasons,
backtested on real subgraph data, and steerable through a conversational UI.
