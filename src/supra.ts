// Supra Push Oracle (DORA S-Values) reader — off-chain reference price.
// Testnet: 0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917 (chain 133)
// Mainnet: 0x58e158c74DF7Ad6396C0dcbadc4878faC9e93d57 (chain 177 — NEVER used
// by this agent; mainnet is refused everywhere else in the codebase).
//
// CORRECT interface is the DORA tuple. The older `checkPrice(string)` interface
// REVERTS on these contracts for every pair tested — do not use it.
//   getSvalue(uint256 _pairIndex) -> (round, decimals, time, price)
//   - `time` is in MILLISECONDS; `price` is scaled by 10^decimals.
//   - Pair indexes (Flow entry + live reads): 0 = BTC/USD, 517 = HSK/USD.
//   - HSK ≈ WHSK 1:1, so HSK/USD (517) is the reference for the WHSK/USDT
//     pool price (USDT ≈ USD 1:1 — documented approximation, not exact).
//
// STALENESS (observed 2026-11-23): the feed was ~6-7 days stale on BOTH chains
// (testnet pair 517: 0.08426, ~6.2 days old; mainnet pair 517: 0.083745,
// ~6.9 days old) despite a documented 6h push cadence. So a reading is only
// usable when FRESH: ageSec <= maxAgeSec (default 86400 = 24h). A stale reading
// is returned with fresh=false and the CALLER must treat the reference as
// MISSING (fail-closed, same as a missing TWAP) — it must never contribute
// signal points. Never silently use a stale price as if fresh.
//
// Read-only: this module makes eth_call only, never sends a transaction.
import { Contract, type JsonRpcProvider } from 'ethers';
import { SUPRA } from './config.js';

export const SUPRA_ABI = [
  'function getSvalue(uint256 _pairIndex) view returns (tuple(uint256 round, uint256 decimals, uint256 time, uint256 price))',
] as const;

export interface SupraReading {
  pair: number;
  /** Human-unit price, e.g. USD per HSK (raw price / 10^decimals). */
  price: number;
  decimals: number;
  /** Feed timestamp, milliseconds since epoch (as reported by the oracle). */
  timestampMs: number;
  /** Seconds between the feed timestamp and the read. */
  ageSec: number;
  /** ageSec <= maxAgeSec at read time. */
  fresh: boolean;
  /** Raw round value reported by the oracle (opaque; kept for audit). */
  round: number;
}

/** Minimal contract surface the reader needs — lets tests inject a fake. */
export interface SupraContractLike {
  getSvalue(pairIndex: number): Promise<{
    round: bigint;
    decimals: bigint;
    time: bigint;
    price: bigint;
  }>;
}

export interface SupraReaderOptions {
  /** Oracle contract address (default: testnet Push Oracle). */
  address?: string;
  /** Max age in seconds for a reading to count as fresh (default 86400 = 24h). */
  maxAgeSec?: number;
  /** Injected contract (tests) — skips creating a live ethers Contract. */
  contract?: SupraContractLike;
  /** Clock override (tests). */
  nowMs?: () => number;
}

export class SupraReader {
  readonly address: string;
  readonly maxAgeSec: number;
  private contract: SupraContractLike;
  private nowMs: () => number;

  constructor(provider: JsonRpcProvider | null, opts: SupraReaderOptions = {}) {
    this.address = opts.address ?? SUPRA.testnet;
    this.maxAgeSec = opts.maxAgeSec ?? 86400;
    this.nowMs = opts.nowMs ?? Date.now;
    this.contract =
      opts.contract ??
      (new Contract(this.address, SUPRA_ABI, provider!) as unknown as SupraContractLike);
  }

  /**
   * Read one pair. Returns the reading (with fresh=false when stale) or null
   * on ANY failure: revert, bad decode, zero price, implausible timestamp.
   * Callers must check `fresh` — a stale reading is a missing reference.
   */
  async readPair(pairIndex: number): Promise<SupraReading | null> {
    let raw;
    try {
      raw = await this.contract.getSvalue(pairIndex);
    } catch {
      return null; // revert / RPC failure -> missing reference, fail-closed
    }
    try {
      const decimals = Number(raw.decimals);
      const priceRaw = raw.price;
      const timeMs = Number(raw.time);
      const now = this.nowMs();
      // Guard against bad decodes / absurd values.
      if (!Number.isFinite(decimals) || decimals < 0 || decimals > 30) return null;
      if (priceRaw <= 0n) return null; // zero price -> missing
      if (!Number.isFinite(timeMs) || timeMs <= 0) return null;
      if (timeMs > now + 300_000) return null; // >5 min in the future: implausible
      const price = Number(priceRaw) / 10 ** decimals;
      if (!Number.isFinite(price) || price <= 0) return null;
      const ageSec = Math.max(0, (now - timeMs) / 1000);
      return {
        pair: pairIndex,
        price,
        decimals,
        timestampMs: timeMs,
        ageSec,
        fresh: ageSec <= this.maxAgeSec,
        round: Number(raw.round),
      };
    } catch {
      return null; // bad decode -> missing reference
    }
  }
}
