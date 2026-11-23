# Demo — 3-minute video outline

**0:00–0:20 — The problem.** Testnet trading agents are black boxes: they claim
returns nobody can check. This agent is verifiable by design — every decision
logged with its reasons.

**0:20–0:50 — Live data.** Web UI at localhost:8787: the fairly-priced
tWHSK/tUSDT pool on HSK testnet (0.3% fee tier, ~0.0869 tUSDT/tWHSK, frozen —
no swaps since Nov 4), signal score and its three components (Supra reference
/ TWAP / volume). The old USDT/WHSK pools (~78 vs ~54, a 3,633 bps spread)
appear only as a logged diagnostic — synthetic pricing, never traded.

**0:50–1:30 — A decision, end to end.** Trigger a poll: RPC `observe()` TWAP
→ signal → trend gate → sizing → risk gates → journal entry. Show the journal
JSONL: score, reasons, why it traded or (in this run) why it did *not* trade
(score 0 < 60: frozen TWAP, stale Supra, zero volume). Show the dry-run:
QuoterV2 quote for 10 tUSDT → ~114.73 tWHSK on the t-pool, router tx built,
simulation matches the quote exactly (verified live 23 Nov ~13:15 SAST;
tx gas estimate 115,462). Nothing sent.

**1:30–2:10 — Conversational control.** Chat in the UI: "show positions", "pnl",
"set risk to low", "set position size to 5%", "set trade frequency to 30
seconds" — each answered live, each change journalled.

**2:10–2:40 — Honest backtest.** 365 days of real subgraph swaps, two-pool
replay: v1 baseline 8 trades, 0 wins, −4.27% paper (reproduced to the cent);
with the trend gate, 26 signals seen, 26 gate-blocked, 0 trades. Under the
current (v2) weights: 0 signals, 0 trades — the gate is unit-tested, not
backtest-validated under v2 (see DESIGN.md). Explain why (testnet price
collapsed 99% in 2026; mean-reversion buys a falling synthetic market). No
hype: paper numbers are labelled paper.

**2:40–3:00 — RiskVault + mainnet note.** The on-chain caps contract, the
deploy script, and the honest status: testnet-only until Newton approves and
funds a mainnet deploy; the rules require it for demo/prize eligibility.
Mainnet deploy cost is measured, not guessed: 2,517,143 gas → ~1.30 HSK
expected, 2.60 HSK budgeted (see MAINNET-NOTE.md).
