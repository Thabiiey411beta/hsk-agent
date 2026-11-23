// Read-only client for RiskVault v2 (testnet). The agent reads these caps
// every poll and enforces the TIGHTER of on-chain caps vs local config —
// v1's vault was deployed but never read; this module is the fix.
// No transactions here: anchoring / position registration / exit triggering
// live in the vault contract and are invoked through their own explicit paths.
import { Contract, keccak256, toUtf8Bytes, type JsonRpcProvider, type Wallet } from 'ethers';
import { assertWalletTestnet } from './execution.js';

export const VAULT_ABI = [
  'function caps() view returns (uint256 perTradeCapBps, uint256 dailyCapBps, uint256 stopLossBps, uint256 maxDrawdownBps, uint256 dailyLossLimitBps, bool halted)',
  'function perTradeCapBps() view returns (uint256)',
  'function dailyCapBps() view returns (uint256)',
  'function stopLossBps() view returns (uint256)',
  'function maxDrawdownBps() view returns (uint256)',
  'function dailyLossLimitBps() view returns (uint256)',
  'function halted() view returns (bool)',
  'function anchors(uint256 batchId) view returns (bytes32)',
  'function anchorCount() view returns (uint256)',
  'function positions(bytes32 id) view returns (uint256 entryPrice, uint256 stopPrice, bool exitTriggered, bool exists)',
  'function pool() view returns (address)',
  'function poolKind() view returns (uint8)',
  // Write paths (v3 integration): anchor + registerPosition + exitIfBreached.
  'function anchor(bytes32 batchHash) external returns (uint256 batchId)',
  'function registerPosition(bytes32 id, uint256 entryPrice, uint256 stopPrice) external',
  'function exitIfBreached(bytes32 positionId) external',
] as const;

export interface VaultCaps {
  perTradeCapBps: number;
  dailyCapBps: number;
  stopLossBps: number;
  maxDrawdownBps: number;
  dailyLossLimitBps: number;
  halted: boolean;
}

export interface VaultPosition {
  entryPrice: bigint;
  stopPrice: bigint;
  exitTriggered: boolean;
  exists: boolean;
}

/** Minimal vault-contract surface — lets tests inject a fake. */
export interface VaultContractLike {
  caps(): Promise<[bigint, bigint, bigint, bigint, bigint, boolean]>;
  anchors(batchId: number): Promise<string>;
  anchorCount(): Promise<bigint>;
  positions(id: string): Promise<[bigint, bigint, boolean, boolean]>;
  pool(): Promise<string>;
  poolKind?(): Promise<number>;
}

/** Write surface the agent needs (anchor / registerPosition / exitIfBreached).
 *  Tests inject fakes; production passes live ethers Contracts. */
export interface VaultWriterLike {
  anchor(batchHash: string): Promise<{ hash: string; wait(): Promise<{ status: number | null; logs?: Array<{ topics: string[] }> } | null> }>;
  registerPosition(id: string, entryPrice: bigint, stopPrice: bigint): Promise<{ hash: string; wait(): Promise<{ status: number | null; logs?: Array<{ topics: string[] }> } | null> }>;
  exitIfBreached(positionId: string): Promise<{ hash: string; wait(): Promise<{ status: number | null; logs?: Array<{ topics: string[] }> } | null> }>;
  exitIfBreachedStatic?(positionId: string): Promise<void>;
}

export async function readCapsFromContract(contract: VaultContractLike): Promise<VaultCaps> {
  const [perTrade, daily, stop, drawdown, dailyLoss, halted] = await contract.caps();
  return {
    perTradeCapBps: Number(perTrade),
    dailyCapBps: Number(daily),
    stopLossBps: Number(stop),
    maxDrawdownBps: Number(drawdown),
    dailyLossLimitBps: Number(dailyLoss),
    halted,
  };
}

/** Read the vault's caps. Throws on revert/missing data — the caller must
 *  treat a failed read as "halt" (fail-closed), never as "caps are loose". */
export async function readCaps(provider: JsonRpcProvider, vaultAddress: string): Promise<VaultCaps> {
  const vault = new Contract(vaultAddress, VAULT_ABI, provider) as unknown as VaultContractLike;
  return readCapsFromContract(vault);
}

/** Read an anchored journal batch hash. Returns null when the batch was
 *  never anchored (zero hash) — callers must not treat "no anchor" as "verified". */
export async function readAnchorFromContract(
  contract: VaultContractLike,
  batchId: number,
): Promise<string | null> {
  const hash = await contract.anchors(batchId);
  return hash === '0x' + '00'.repeat(32) ? null : hash;
}

export async function readAnchor(
  provider: JsonRpcProvider,
  vaultAddress: string,
  batchId: number,
): Promise<string | null> {
  const vault = new Contract(vaultAddress, VAULT_ABI, provider) as unknown as VaultContractLike;
  return readAnchorFromContract(vault, batchId);
}

export async function readAnchorCount(provider: JsonRpcProvider, vaultAddress: string): Promise<number> {
  const vault = new Contract(vaultAddress, VAULT_ABI, provider) as unknown as VaultContractLike;
  return Number(await vault.anchorCount());
}

/** Read a registered position (entry/stop prices, exit flag). */
export async function readPositionFromContract(
  contract: VaultContractLike,
  positionId: string,
): Promise<VaultPosition> {
  const [entryPrice, stopPrice, exitTriggered, exists] = await contract.positions(positionId);
  return { entryPrice, stopPrice, exitTriggered, exists };
}

export async function readPosition(
  provider: JsonRpcProvider,
  vaultAddress: string,
  positionId: string,
): Promise<VaultPosition> {
  const vault = new Contract(vaultAddress, VAULT_ABI, provider) as unknown as VaultContractLike;
  return readPositionFromContract(vault, positionId);
}

/** The tighter of the on-chain cap (bps) and the local config fraction
 *  (0-1). The agent always trades at the tighter one; a missing/invalid
 *  on-chain cap must be handled by the caller (fail-closed) before calling. */
export function tighterCap(onChainBps: number, localFraction: number): number {
  if (!Number.isFinite(onChainBps) || onChainBps < 0) return localFraction;
  if (!Number.isFinite(localFraction) || localFraction < 0) return onChainBps / 10_000;
  return Math.min(onChainBps / 10_000, localFraction);
}

// --- Write paths (integration pass; testnet only, chain-checked) ---
// All three send real transactions from the agent wallet. The agent calls
// them only with an explicit signing wallet; paper mode without a wallet
// skips them and journals the skip. No keys are ever read or logged here.

/** Read the vault's pool layout kind (0 = demo USDT/WHSK, 1 = tWHSK/tUSDT).
 *  Returns null when the vault predates poolKind (v1/v2) — the caller must
 *  treat a null kind on a v3-expected vault as a mismatch, not as kind 0. */
export async function readPoolKind(provider: JsonRpcProvider, vaultAddress: string): Promise<number | null> {
  try {
    const vault = new Contract(vaultAddress, VAULT_ABI, provider);
    return Number(await (vault as unknown as { poolKind(): Promise<bigint> }).poolKind());
  } catch {
    return null;
  }
}

/** Deterministic bytes32 position id for an agent position id string. */
export function positionIdFor(agentPositionId: string): string {
  return keccak256(toUtf8Bytes(agentPositionId));
}

/** Scale a human USDT-per-WHSK price to the vault's 1e18 fixed point. */
export function priceToVaultUnits(priceUsdtPerWhsk: number): bigint {
  if (!(priceUsdtPerWhsk > 0) || !Number.isFinite(priceUsdtPerWhsk)) {
    throw new Error(`priceToVaultUnits: invalid price ${priceUsdtPerWhsk}`);
  }
  return BigInt(Math.round(priceUsdtPerWhsk * 1e18));
}

async function sendAndConfirm(
  label: string,
  send: () => Promise<{ hash: string; wait(): Promise<{ status: number | null; logs?: Array<{ topics: string[] }> } | null> }>,
): Promise<{ txHash: string; receipt: { status: number | null; logs?: Array<{ topics: string[] }> } | null }> {
  const tx = await send();
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`${label} tx reverted: ${tx.hash}`);
  return { txHash: tx.hash as string, receipt };
}

const ANCHORED_TOPIC = keccak256(toUtf8Bytes('Anchored(uint256,bytes32)'));

/** Anchor a journal batch hash on the vault. Returns { txHash, batchId }.
 *  batchId is parsed from the Anchored event in the receipt (batchId is the
 *  first indexed topic) — no second RPC read, and a missing event fails. */
export async function anchorBatch(
  wallet: Wallet,
  vaultAddress: string,
  batchHash: string,
  writer?: VaultWriterLike,
): Promise<{ txHash: string; batchId: number }> {
  await assertWalletTestnet(wallet);
  if (!/^0x[0-9a-fA-F]{64}$/.test(batchHash) || batchHash === '0x' + '00'.repeat(32)) {
    throw new Error('anchorBatch: batchHash must be a non-zero bytes32');
  }
  const w: VaultWriterLike =
    writer ??
    (new Contract(vaultAddress, VAULT_ABI, wallet) as unknown as VaultWriterLike);
  const { txHash, receipt } = await sendAndConfirm('anchorBatch', () => w.anchor(batchHash));
  for (const log of receipt?.logs ?? []) {
    if (log.topics[0] === ANCHORED_TOPIC && log.topics[1]) {
      return { txHash, batchId: Number(BigInt(log.topics[1])) };
    }
  }
  throw new Error(`anchorBatch: no Anchored event found in receipt ${txHash}`);
}

/** Register a position's entry + stop prices on the vault (on-chain stop).
 *  Prices are human USDT per WHSK; stop must be below entry (enforced by
 *  the contract — a bad call reverts and throws here). */
export async function registerVaultPosition(
  wallet: Wallet,
  vaultAddress: string,
  agentPositionId: string,
  entryPrice: number,
  stopPrice: number,
  writer?: VaultWriterLike,
): Promise<string> {
  await assertWalletTestnet(wallet);
  if (!(stopPrice > 0) || !(stopPrice < entryPrice)) {
    throw new Error(`registerVaultPosition: stop ${stopPrice} must be > 0 and < entry ${entryPrice}`);
  }
  const w: VaultWriterLike =
    writer ??
    (new Contract(vaultAddress, VAULT_ABI, wallet) as unknown as VaultWriterLike);
  const { txHash } = await sendAndConfirm('registerVaultPosition', () =>
    w.registerPosition(positionIdFor(agentPositionId), priceToVaultUnits(entryPrice), priceToVaultUnits(stopPrice)),
  );
  return txHash;
}

/** View-path check: would exitIfBreached(id) succeed right now? Uses a
 *  staticCall (no tx, no gas). Returns false when the stop is not breached
 *  (the call reverts "stop not breached"), the position is unknown, or the
 *  pool is unset — all fail-closed (no exit triggered, no tx sent). */
export async function exitWouldTrigger(
  provider: JsonRpcProvider,
  vaultAddress: string,
  agentPositionId: string,
  writer?: { exitIfBreachedStatic(positionId: string): Promise<void> },
): Promise<boolean> {
  try {
    if (writer?.exitIfBreachedStatic) {
      await writer.exitIfBreachedStatic(positionIdFor(agentPositionId));
    } else {
      const vault = new Contract(vaultAddress, VAULT_ABI, provider);
      await (vault as unknown as { exitIfBreached: { staticCall(id: string): Promise<void> } }).exitIfBreached.staticCall(positionIdFor(agentPositionId));
    }
    return true;
  } catch {
    return false;
  }
}

/** Send exitIfBreached(id) — ONLY call after exitWouldTrigger() returned
 *  true, so gas is never spent on a call that would revert. Returns the tx
 *  hash. The vault moves no funds; it flags the position + emits ExitTriggered. */
export async function triggerExitIfBreached(
  wallet: Wallet,
  vaultAddress: string,
  agentPositionId: string,
  writer?: VaultWriterLike,
): Promise<string> {
  await assertWalletTestnet(wallet);
  const w: VaultWriterLike =
    writer ??
    (new Contract(vaultAddress, VAULT_ABI, wallet) as unknown as VaultWriterLike);
  const { txHash } = await sendAndConfirm('triggerExitIfBreached', () => w.exitIfBreached(positionIdFor(agentPositionId)));
  return txHash;
}
