# Mainnet decision — what Newton must decide

## The verified rule (DoraHacks detail page, fetched 2026-11-23)
- "Deploy the project's smart contract on HSK Chain mainnet. Projects without a
  mainnet deployment automatically lose eligibility for demo selection."
- "Winning teams must deploy their projects on HSK Chain mainnet to claim a prize."

The "winners can migrate after the hackathon" claim attributed to the faucet page
is **unverified** (faucet page unreadable from this VM) and must not be relied on.

## What this means
A testnet-only entry can be **submitted**, but per the written rules it is
**ineligible for demo selection and for prize claim**. The only rule-compliant
path to winning includes a mainnet deployment of at least the core contract
(`RiskVault.sol` in this repo).

## Cost (measured live 2026-11-23 ~13:15 SAST — re-check gas price at deploy time)

- `eth_estimateGas` for the RiskVault deployment (constructor args: agent
  `0xF5bD...781DA` + caps 1000/3000/200/1000/500) returns **2,517,143 gas**
  on **both** mainnet and testnet — verified live, same figure twice.
  Cross-check (EIP-170): the deployed contract is 10,564 bytes, and the
  code-deposit alone is 10,564 × 200 = 2,112,800 gas — consistent with the
  ~2.52M total. The old "~200–400k gas" estimate was wrong by ~10x and is
  withdrawn; do not use it.
- Mainnet gas price at the check: **500.001 gwei** (volatile — single
  snapshot; testnet is ~1 gwei). At 500 gwei, the deploy costs
  2,517,143 × 500 gwei ≈ **1.26 HSK**.
- `setPool` + `setPoolKind` after deploy: ~0.04 HSK (small-call allowance).
- **Expected total ≈ 1.30 HSK; budget 2.60 HSK at 2x margin** for gas-price
  movement. (No "~3–5 HSK" figure exists in this repo's docs — if you see
  one quoted elsewhere, it is not from here; the measured budget is 2.60 HSK.)
- Real HSK is required: mainnet funds must come from Newton (buy/bridge HSK).
  **No mainnet funds have been spent or requested by the agent.**

## What is ready
- `contracts/RiskVault.sol` compiles (solc 0.8.24) and is minimal/auditable.
- `scripts/deploy.ts` deploys it to testnet or mainnet via Hardhat.
- The deploy script **refuses mainnet unless `MAINNET_CONFIRMED=yes` is set** —
  a second explicit lock on top of Newton's approval.
- The agent itself refuses to trade on mainnet (chain check in `src/quoter.ts`).

## Decision needed from Newton
1. Approve a mainnet RiskVault deploy (yes/no)?
2. If yes: fund a deployer wallet with real HSK and confirm the amount.
3. If no: submit testnet-only, knowing demo/prize eligibility is lost per the rules.

**Nothing mainnet has been run. Nothing will be run without Newton's explicit approval + funds.**
