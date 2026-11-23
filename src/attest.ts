// Journal integrity (hash chain) + EAS attestation (testnet only).
//
// Hash chain: each journal entry commits to the previous entry's hash, so any
// later edit breaks the chain. Pure functions — no I/O, fully unit-tested.
//
// EAS: LIVE on HSK testnet via OP Stack predeploys (verified live 2026-11-23,
// eth_getCode non-empty on chain 133):
//   EAS            0x4200000000000000000000000000000000000021
//   SchemaRegistry 0x4200000000000000000000000000000000000020
// Flow's trade schema is already registered on 133 (UID below) — reuse it,
// do NOT re-register the same schema string (duplicate registration reverts).
//   schema: bytes32 proposalId,bytes32 rationaleHash,bytes32 txHash,
//           uint256 notionalUsd,bool exitPath,string engine,string origin
//   resolver: none, revocable: false.
// Attestation is a SEPARATE, explicitly-invoked step (never automatic in the
// poll loop). Gelato / Chainlink Automation are NOT on HSK — not used here.
import { AbiCoder, Contract, ethers, keccak256, toUtf8Bytes, type Wallet } from 'ethers';
import { EAS } from './config.js';
import { assertWalletTestnet } from './execution.js';

export const ZERO_HASH = '0x' + '00'.repeat(32) as string;
export const GENESIS_HASH = ZERO_HASH;
export const TRADE_SCHEMA_TYPES = [
  'bytes32',
  'bytes32',
  'bytes32',
  'uint256',
  'bool',
  'string',
  'string',
] as const;

export const EAS_ABI = [
  'function attest((bytes32 schema, (address recipient, uint64 expirationTime, bool revocable, bytes32 refUID, bytes data, uint256 value) data) request) external payable returns (bytes32)',
  'function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid, bytes32 schema, uint64 time, uint64 expirationTime, uint64 revocationTime, bytes32 refUID, address recipient, address attester, bool revocable, bytes data))',
  'event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema)',
] as const;

export const SCHEMA_REGISTRY_ABI = [
  'function register(string schema, address resolver, bool revocable) external returns (bytes32)',
  'function getSchema(bytes32 uid) view returns (tuple(bytes32 uid, address resolver, bool revocable, string schema) schema)',
] as const;

const ATTESTED_TOPIC = keccak256(
  toUtf8Bytes('Attested(address,address,bytes32,bytes32)'),
);

/** keccak256 over (prevHash + '\n' + canonicalEntryJson), UTF-8.
 *  The caller must pass the canonical (deterministically serialised) JSON —
 *  this function hashes exactly what it is given, it does not canonicalise. */
export function hashEntry(prevHash: string, canonicalEntryJson: string): string {
  return keccak256(toUtf8Bytes(`${prevHash}\n${canonicalEntryJson}`));
}

export interface ChainEntry {
  prevHash: string;
  hash: string;
  entryJson: string;
}

/** Verify a hash chain: every entry's hash must recompute from its prevHash
 *  + JSON, and every prevHash (after the first) must equal the previous
 *  entry's hash. The first entry must chain from the genesis zero hash. */
export function verifyChain(entries: ChainEntry[]): {
  valid: boolean;
  badIndex: number | null;
  reason: string | null;
} {
  let expectedPrev = GENESIS_HASH;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.prevHash !== expectedPrev) {
      return { valid: false, badIndex: i, reason: `prevHash mismatch at index ${i}` };
    }
    if (hashEntry(e.prevHash, e.entryJson) !== e.hash) {
      return { valid: false, badIndex: i, reason: `hash mismatch at index ${i}` };
    }
    expectedPrev = e.hash;
  }
  return { valid: true, badIndex: null, reason: null };
}

/** Build a valid chain from canonical entry JSON strings (helper for the
 *  journal anchoring flow + tests). */
export function buildChain(entryJsons: string[]): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev = GENESIS_HASH;
  for (const json of entryJsons) {
    const hash = hashEntry(prev, json);
    out.push({ prevHash: prev, hash, entryJson: json });
    prev = hash;
  }
  return out;
}

export interface TradeAttestationData {
  proposalId: string; // bytes32
  rationaleHash: string; // bytes32
  txHash: string; // bytes32
  notionalUsd: bigint; // uint256, smallest unit the caller uses (documented at call site)
  exitPath: boolean;
  engine: string;
  origin: string;
}

/** ABI-encode trade data per Flow's schema (order matters — matches the
 *  registered schema string exactly). */
export function encodeTradeData(data: TradeAttestationData): string {
  return AbiCoder.defaultAbiCoder().encode(
    [...TRADE_SCHEMA_TYPES],
    [
      data.proposalId,
      data.rationaleHash,
      data.txHash,
      data.notionalUsd,
      data.exitPath,
      data.engine,
      data.origin,
    ],
  );
}

/** Decode trade data encoded by encodeTradeData (round-trip check / audit). */
export function decodeTradeData(encoded: string): TradeAttestationData {
  const [proposalId, rationaleHash, txHash, notionalUsd, exitPath, engine, origin] =
    AbiCoder.defaultAbiCoder().decode([...TRADE_SCHEMA_TYPES], encoded);
  return {
    proposalId: proposalId as string,
    rationaleHash: rationaleHash as string,
    txHash: txHash as string,
    notionalUsd: notionalUsd as bigint,
    exitPath: exitPath as boolean,
    engine: engine as string,
    origin: origin as string,
  };
}

/** Expected schema UID for (schema, resolver, revocable) — EAS computes it
 *  as keccak256(abi.encodePacked(schema, resolver, revocable)). */
export function schemaUidFor(schema: string, resolver: string, revocable: boolean): string {
  return keccak256(
    ethers.solidityPacked(['string', 'address', 'bool'], [schema, resolver, revocable]),
  );
}

/** Register a NEW schema on the testnet SchemaRegistry (explicit step only).
 *  Returns the schema UID, verified by reading it back from the registry.
 *  Do NOT call with Flow's schema string — it is already registered. */
export async function registerSchema(
  wallet: Wallet,
  schema: string,
  resolver: string,
  revocable: boolean,
): Promise<{ txHash: string; schemaUid: string }> {
  await assertWalletTestnet(wallet);
  const registry = new Contract(EAS.schemaRegistry, SCHEMA_REGISTRY_ABI, wallet);
  const tx = await registry.register(schema, resolver, revocable);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`registerSchema tx reverted: ${tx.hash}`);
  const uid = schemaUidFor(schema, resolver, revocable);
  const back = await registry.getSchema(uid);
  if (back.schema !== schema) {
    throw new Error(`registerSchema: UID ${uid} did not read back the registered schema`);
  }
  return { txHash: tx.hash as string, schemaUid: uid };
}

export interface AttestTradeOpts extends TradeAttestationData {
  /** Recipient of the attestation (default: the attesting wallet). */
  recipient?: string;
  /** Schema UID (default: Flow's registered trade schema). */
  schemaUid?: string;
}

/** Attest one executed trade (or trade-adjacent on-chain action) to EAS.
 *  Explicitly invoked only — never automatic. Returns the attestation UID
 *  (parsed from the Attested event in the receipt) and the tx hash. */
export async function attestTrade(
  wallet: Wallet,
  opts: AttestTradeOpts,
): Promise<{ txHash: string; attestationUid: string }> {
  await assertWalletTestnet(wallet);
  const schemaUid = opts.schemaUid ?? EAS.flowSchemaUid;
  const eas = new Contract(EAS.eas, EAS_ABI, wallet);
  const data = encodeTradeData(opts);
  const tx = await eas.attest({
    schema: schemaUid,
    data: {
      recipient: opts.recipient ?? wallet.address,
      expirationTime: 0,
      revocable: false,
      refUID: ZERO_HASH,
      data,
      value: 0,
    },
  });
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`attestTrade tx reverted: ${tx.hash}`);
  // Attested(address recipient, address attester, bytes32 uid, bytes32 schema):
  // recipient + attester indexed, uid is the first (only) data word.
  const iface = new ethers.Interface(EAS_ABI);
  for (const log of receipt.logs ?? []) {
    try {
      if (log.topics[0] !== ATTESTED_TOPIC) continue;
      const parsed = iface.parseLog(log);
      if (parsed) return { txHash: tx.hash as string, attestationUid: parsed.args[2] as string };
    } catch {
      /* not our log — keep scanning */
    }
  }
  throw new Error(`attestTrade: no Attested event found in receipt ${tx.hash}`);
}
