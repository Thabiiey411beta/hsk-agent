# HSK Verifiable Agent — AI Agent Trading (Track 1, HSK Chain Horizon Hackathon)

A **paper-first, verifiable** AI trading agent on HSKSwap (HSK Chain testnet).
Every decision — signal, size, risk check, outcome — is logged with its reasons
to a JSONL decision journal, so any trade can be audited after the fact.

**What it does:** watches the fairly-priced **tWHSK/tUSDT pool** (0.3% fee tier),
scores a Supra-oracle-reference + on-chain-TWAP-deviation + swap-volume-trend
signal, applies a hard trend gate, sizes by ATR when the data supports it,
enforces the tighter of on-chain (RiskVault v3) vs local caps, and trades paper
by default. Live testnet execution via SwapRouter02 is available behind
`--live` (testnet only; mainnet is refused; one live trade max per run,
≤ 10 tUSDT). A live trade anchors the journal batch on the vault and attests
via EAS. The old USDT/WHSK pools are synthetic and frozen — read as a
diagnostic only, never traded.
A conversational UI lets you see positions/P&L live and adjust size, frequency,
risk appetite and target assets (`show supra` / `show twap` / `show vault`
are read-only; the trend gate cannot be switched off).

## Quick start

```bash
npm install
npm run build
npm test            # 157 unit tests, all green
npm run paper       # paper mode + web UI at http://localhost:8787
```

Or a single poll: `node dist/cli.js --once`
Backtest on real subgraph history: `node dist/cli.js --backtest 365`
(a second replay covers the t-pool's own swap history)
Dry-run the execution path (quote → build → simulate, sends nothing):
`node dist/cli.js --dry-run 10 <your-address>` (tUSDT → tWHSK on the t-pool)

Live testnet (needs test HSK + tUSDT/tWHSK — see `FUNDS.md`):
```bash
cp .env.example .env   # put a FRESH testnet-only private key in .env (never commit it)
node dist/cli.js --live            # loop; ONE live trade max per run, <= 10 tUSDT
node dist/cli.js --live --once     # single poll, then exit
```

## Architecture

See `DESIGN.md`. Core: `src/agent.ts` (poll loop), `src/signal.ts`
(`scoreTPoolSignal`: supra 30 + TWAP(24h) 45 + volume 25, with the
reference median as a capped 14-pt fallback while Supra is stale; the old
two-pool `scoreSignal` is backtest-only now), `src/supra.ts` (Supra Push
Oracle reader, pair 517 HSK/USD, 24h staleness rule),
`src/referenceMedian.ts` (off-chain median fallback — NOT an oracle),
`src/observe.ts` (on-chain TWAP via `observe()`), `src/trend.ts` (hard trend gate), `src/atr.ts` (ATR sizing),
`src/execution.ts` (simulation-before-send swaps), `src/vault.ts` (RiskVault v3
client: caps, anchor, registerPosition, exit checks), `src/attest.ts`
(hash chain + EAS attestation), `src/sizing.ts`, `src/risk.ts` (fail-closed
gates), `src/journal.ts`, `src/subgraph.ts`, `src/quoter.ts` (QuoterV2 +
SwapRouter02), `src/backtest.ts` (two-pool replay + t-pool replay),
`src/chat.ts` + `src/server.ts` (UI + chat).
Contract: `contracts/RiskVault.sol` v3 — on-chain caps + anchor +
registerPosition + poolKind-aware `exitIfBreached` (Hardhat; deploy script in
`scripts/deploy.ts`, mainnet NOT run — see `MAINNET-NOTE.md`).

## Verified live results (2026-11-23)

- Testnet chain 133, gas ~1 gwei; subgraph live; primary market is the
  tWHSK/tUSDT pool `0x840fa6e4...` (0.0868845 tUSDT/tWHSK, frozen — no swaps
  since Nov 4; TWAPs 1h/24h/7d all frozen, 30d reverts).
- Paper poll: signal score 0/100 < threshold 60 → **no trade** (correct:
  frozen TWAP, stale Supra, zero volume).
- Live `--once` poll: same — signal 0, **no live trade executed**. The
  threshold was not lowered to force a trade; the one-live-trade allowance
  is unspent.
- RiskVault v3 `0x67fD07BeB208878bA248fB6D99110904f9dB5DaF`: pool = t-pool,
  poolKind = 1, caps 10/30/2/10/5%. Verified live: a stop below the price does
  not trigger; a stop above the price triggers (`exitIfBreached` tx
  `0x81c00a...`). Journal batch 1 anchored on v3 (tx `0xf28cdb...`).
- Backtest (365d, real subgraph swaps, two-pool replay): **v1 baseline
  (original weights, reproduced): 82 events, 8 trades, 0 wins, −42.73 USDT
  (−4.27%). With the trend gate: 26 signals seen, 26 gate-blocked, 0 trades,
  0 PnL — the gate vetoed every losing entry. New signal + gate + ATR:
  0 trades, 0 PnL. T-pool replay (26 swaps, Nov 2–4): 0 trades, 0 PnL.**
  Diagnosis: testnet WHSK collapsed ~99% over 2026 (6,363 → 78 USDT/WHSK,
  synthetic testnet pricing); a mean-reversion strategy buys into that
  downtrend, and sparse swaps let stop-losses gap through. This is a paper
  number on synthetic testnet data — **not live profit, not a real market.**
- No live testnet trade executed: no test HSK could be obtained from this VM
  (official faucet unreachable, test tokens have no public mint — see `FUNDS.md`).
  (That line is now historical: the agent wallet holds 0.0887 tHSK + 1,000 tUSDT
  + 10,000 tWHSK from the v2 faucet claims, checked live 23 Nov ~13:15 SAST;
  the live trade still did not happen because the signal never cleared 60.)

## Supra Push Oracle reference (2026-11-23)

The signal includes a Supra HSK/USD reference component (30 pts, only when the
reading is FRESH). Supra Push Oracle (DORA S-Values) on testnet:
`0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917`, pair 517 = HSK/USD, tuple
`getSvalue` interface (`checkPrice` reverts — not used). **Honest status: the
feed was ~6–7 days stale on both chains at integration time** (testnet pair 517:
$0.08426, ~6.2 days old), so the component scores 0 on testnet until Supra
resumes pushing — stale is treated as missing, never used as if fresh. When
fresh, expect saturation at −30 on testnet: pool WHSK (~54–78 USDT/WHSK) sits
~643–928x above the oracle — synthetic testnet pricing, not a reader bug; the
code is deliberately not retuned for testnet (on mainnet, where pool and oracle
agree within a few %, it behaves normally). Supra is a **partner feed, not the
sole official one** — HSK also adopted Chainlink Data Streams. Known risk, not
a blocker: a July 2026 Bonzo Lend oracle exploit on another chain involved
Supra. Full detail in `DESIGN.md` (Supra section) and `src/supra.ts`.

APRO was checked as a second feed and stays OUT: re-verified live 23 Nov
12:51 SAST, all three testnet feeds are ~224 days stale (last push April
2026) and the USDT/USD feed reports a nonsensical $2,195. Testnet has no
APRO HSK/USD feed at all. A stale second feed adds noise, not redundancy —
see `DESIGN.md` (oracle landscape) and the verification record in the goal
workspace (`hidden_files/apro-20261123.md`).

## Reference median fallback — NOT an oracle (2026-11-23)

While Supra is stale, the signal's reference slot is filled by the median of
four independent venues — CoinGecko `hashkey-ecopoints`, Kraken HSK/USD,
Gate.io HSK/USDT, MEXC HSK/USDT — implemented in `src/referenceMedian.ts`.
**It is NOT an oracle:** no signing, no on-chain verification, it trusts
those CEX APIs. Rules: ≥3 of 4 sources fresh, median, reject if spread >2%,
last-good cached max 5 min (served only after a fetch failure, never over a
spread rejection). A fresh Supra always wins — the median is not even fetched
while Supra is fresh — and its contribution is **capped at ±14 pts**, so
14 + TWAP 45 = 59 < threshold 60: it can never push the score over threshold
on its own. Threshold 60 and the hard trend gate are unchanged. HashKey
Exchange HSK/USD is excluded on purpose (it printed $0.08434, +4.7% above
consensus). **Live at integration (23 Nov 13:10 SAST, paper `--once`):**
median $0.080631, all 4 venues, 0.198% spread; Supra $0.08426, ~6.22 days
stale. Signal score 0 (median component −11), no trade. Full detail in
`DESIGN.md` (reference median section) and the verification record in the
goal workspace (`hidden_files/opensource-oracle-fallback-20261123.md`).

## Chat commands

`status` · `show positions` · `pnl` · `show supra` · `show twap` ·
`show vault` · `set position size to 5%` ·
`set trade frequency to 30 seconds` · `set risk to low|medium|high` ·
`set target asset to tWHSK/tUSDT` · `halt` / `resume` · `help`

The trend gate is a safety rule, not a toggle — there is no command to switch
it off.

## Mainnet decision (needs Newton)

Per the verified DoraHacks rules, mainnet deployment is required for demo
eligibility AND prize claim. This repo ships the mainnet deploy script but does
**not** run it. See `MAINNET-NOTE.md` before deciding.

## Demo

See `DEMO.md` (3-minute video outline).
