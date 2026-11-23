# Test funds — status 2026-11-23

## What was tried
1. **Official faucet** — the old URL `https://faucet-testnet.hsk.xyz/` is DEAD (DNS does not resolve, confirmed 2026-11-23). The live official faucet is `https://faucet.hskchain.net/faucet` (reached via faucet.hsk.xyz redirect). It takes a pasted address + reCAPTCHA checkbox, button says "Send me 1 HSK", one claim per 24h — but the actual drip is **0.1 HSK**, not 1. Claim confirmed 2026-11-23 11:51 SAST, tx 0x40fd56826813bd2f390355e5df1f0531440dceac1dedadd57fb172c9fdd44424, block 36120411, 0.1 HSK to the agent wallet. Current testnet explorer: https://testnet-explorer.hskchain.net (old alt.technology explorer is dead DNS).
2. **Thirdweb universal faucet** (blog.thirdweb.com guide, 0.01 tHSK/24h) — https://thirdweb.com/hashkey-chain-testnet offers only a "Connect Wallet" button, no address-paste field. Not used (no wallet connect from this VM).
3. **Public mint on test tokens** — probed `mint` / `faucet` / `drip` on test USDT (`0x98b6173a8b7dfc52ce8bc88f1184a918a1ccaa4f`) and WHSK (`0xca8aaceec5db1e91b9ed3a344ba026c4a2b3ebf6`) via read-only `eth_call`:
   **all revert**. No public mint exists; `owner()` / `faucetAmount()` also revert.
4. **Fresh wallet balance:** `0xF5bDFE902718Bd75d2d6A6070dcdC6FBF9D781DA` holds **0.1 HSK** (faucet claim 11:51 SAST; Newton also sent faucet funds around the same time — only 0.1 total is in the wallet), 0 test USDT, 0 WHSK (checked live on testnet RPC, block 36120474).

## Consequence
- RiskVault DEPLOYED on testnet 2026-11-23 ~11:56 SAST at `0x4D3fF0EE974b93C22103046715B20EC451c4f467` (deployer 0xF5bD...781DA, chain 133). Deploy needed two fixes first: the script was written for Hardhat 2 (`import { ethers } from 'hardhat'`) but the project runs Hardhat 3 (fixed to `network.connect()` + plugins array), and Hardhat wasn't loading `.env` so getSigners() was empty (fixed by sourcing .env when running).
- Live agent ran 2026-11-23 11:55–11:57 SAST (~3 polls, `--live`, testnet): signal 50/100 each poll (spread 50, TWAP 0 — no history available, volume 0 — flat), direction buy-whsk, decision **no-trade** (50 < 60 threshold). Correct behaviour — the agent refuses to trade on a weak signal. No live swap executed yet; execution path remains proven by dry-run (live QuoterV2 quote + tx build + simulation).
- Test USDT is still needed for a swap — the faucet only drips HSK, so test USDT must come from a pool swap (WHSK→USDT) or another faucet route. Wallet after deploy: ~0.099 tHSK.

## Update 2026-11-23 ~13:15 SAST (hygiene pass — verified live on testnet RPC)
- Wallet `0xF5bD...781DA` now holds **0.0887 tHSK, 1,000 tUSDT, 10,000 tWHSK**
  (tUSDT/tWHSK from the v2 Flow faucet claims; the old synthetic USDT balance
  is 0 and old WHSK is 0.001). The CLI startup balance line used to read the
  old token addresses and print "test USDT 0" — fixed in `src/quoter.ts` to
  read the t-pool tokens, so the startup line is now truthful.
- Dry-run re-verified live: 10 tUSDT → 114.734 tWHSK quoted, simulation
  matches the quote exactly, tx gas estimate 115,462. Nothing sent.
