// Reference median — OFF-CHAIN fallback reference price for HSK/USD.
// THIS IS NOT AN ORACLE. It is the median of four independent centralised
// venues (CoinGecko, Kraken, Gate.io, MEXC), used ONLY as a fallback when
// every on-chain oracle is stale/missing. It has no signing, no on-chain
// verification and no decentralised consensus: it trusts those four public
// APIs and this VM's network path to them. Every log, journal entry and
// attestation that touches it must carry the label
//   source: "reference-median (NOT an oracle)"
// so it can never be mistaken for an oracle price.
//
// WHY IT EXISTS (verified live 2026-11-23, ~13:03-13:06 SAST, re-verified by
// the coordinator; full evidence in
// workspace/goals/hsk-chain-horizon-hackathon-ai-agent-trading/hidden_files/
// opensource-oracle-fallback-20261123.md):
//   - Supra (the agent's only on-chain oracle) is ~6.2 days stale and scores
//     0 fail-closed. APRO is dead on testnet (no push since Apr 2026).
//   - RedStone was re-checked 2026-11-23 ~13:10 SAST before this integration:
//     api.redstone.finance + both oracle-gateway hosts still return empty
//     replies (HTTP 000) for HSK and for ETH — no HSK feed, gateway
//     unreachable from this VM. Dropped, not integrated.
//   - CoinGecko hashkey-ecopoints (NOT hashkey-platform-token — that id 404s)
//     + Kraken HSK/USD + Gate.io HSK/USDT + MEXC HSK/USDT agreed within
//     0.20% at check time: median $0.08062. The stale Supra value $0.08426
//     sits +4.5% above that live median.
//   - EXCLUDED on purpose: HashKey Exchange HSK/USD printed $0.08434 (+4.7%
//     above consensus) in the same CoinGecko ticker list — venue divergence
//     is real, which is why the median + spread gate exist. Binance does not
//     list HSK; KuCoin is geo-blocked from this VM; DexScreener does not
//     index HSK Chain.
//
// RULES (mirror the Supra fail-closed discipline in src/supra.ts):
//   - Read-only HTTP fetches, parallel, 5s timeout each, 60s cadence (the
//     agent polls every 60s, so one median read per poll).
//   - Freshness per source: CoinGecko last_updated_at <= 120s old; Kraken /
//     Gate.io / MEXC carry no timestamp — a successful response counts as
//     fresh at fetch time, any error drops the source.
//   - Require >= 3 of 4 sources fresh; take the median; REJECT the reading
//     if max-min spread > 2% (venue divergence) or fewer than 3 respond.
//   - Cache: last-good median is kept for max 5 min and is served ONLY when
//     the fetch itself fails (<3 sources responding). A spread rejection is
//     NOT masked by the cache — current venue disagreement is evidence, and
//     serving a stale price over it would hide that. A cached reading is
//     flagged fromCache:true and its ageSec is the age of the cached price.
//   - Stale/missing = the reference component scores 0, fail-closed, journaled.
//   - The median NEVER overrides a fresh on-chain oracle (see src/signal.ts:
//     Supra fresh always wins; the median fills the reference slot only
//     while Supra is stale, capped at 14 pts — it can never push the score
//     over the 60 threshold on its own).
//   - CEX spot prices != on-chain HSKSwap execution prices; HSK liquidity
//     is thin (Kraken 24h vol ~2,100 HSK; Gate ~107k HSK). The on-chain
//     t-pool TWAP remains the execution-reality check.
//   - For a hackathon testnet agent this is a legitimate, disclosed fallback.
//     It would NOT be acceptable as the price source for a production
//     mainnet trading system — that needs a live, signed on-chain oracle.
export const REFERENCE_MEDIAN_SOURCE = 'reference-median (NOT an oracle)';

/** Max age (seconds) of a CoinGecko last_updated_at for the source to count. */
export const COINGECKO_MAX_AGE_SEC = 120;
/** Minimum fresh sources required for a median. */
export const MIN_SOURCES = 3;
/** Max spread (max-min)/median before the reading is rejected. */
export const MAX_SPREAD = 0.02;
/** Max age (seconds) a cached last-good median may be served after a fetch failure. */
export const MAX_CACHE_AGE_SEC = 300;
/** Per-source fetch timeout (ms). */
export const FETCH_TIMEOUT_MS = 5000;

export const SOURCES = ['coingecko', 'kraken', 'gate', 'mexc'] as const;
export type MedianSource = (typeof SOURCES)[number];

export const SOURCE_URLS: Record<MedianSource, string> = {
  coingecko:
    'https://api.coingecko.com/api/v3/simple/price?ids=hashkey-ecopoints&vs_currencies=usd&include_last_updated_at=true',
  kraken: 'https://api.kraken.com/0/public/Ticker?pair=HSKUSD',
  gate: 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=HSK_USDT',
  mexc: 'https://api.mexc.com/api/v3/ticker/price?symbol=HSKUSDT',
};

/** Minimal fetch surface the reader needs — lets tests inject a stub. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface SourceReading {
  source: MedianSource;
  price: number;
  /** Fetch time, ms since epoch. */
  fetchedAtMs: number;
}

export interface ReferenceMedianReading {
  /** Median HSK price in USD across the fresh sources. */
  price: number;
  /** Sources that contributed to this median. */
  sources: MedianSource[];
  /** (max - min) / median across the contributing sources. */
  spreadPct: number;
  /** When the median was computed, ms since epoch. */
  fetchedAtMs: number;
  /** Seconds between fetchedAtMs and the read. */
  ageSec: number;
  /** Age within the applicable window (fresh fetch, or cache <= 5 min). */
  fresh: boolean;
  /** True when served from the last-good cache after a fetch failure. */
  fromCache: boolean;
  /** The mandatory label — never an oracle. */
  source: typeof REFERENCE_MEDIAN_SOURCE;
}

export type MedianResult =
  | { ok: true; price: number; spreadPct: number; sources: MedianSource[] }
  | { ok: false; reason: string };

/** Median of a non-empty list: middle value, or mean of the two middles. */
export function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pure aggregation: >= MIN_SOURCES fresh readings, spread <= MAX_SPREAD.
 * A +5% outlier on one venue barely moves a 4-source median (it is not one
 * of the two middle values) — the spread gate is what rejects a venue that
 * has genuinely diverged.
 */
export function aggregateMedian(
  readings: SourceReading[],
  opts: { minSources?: number; maxSpreadPct?: number } = {},
): MedianResult {
  const minSources = opts.minSources ?? MIN_SOURCES;
  const maxSpreadPct = opts.maxSpreadPct ?? MAX_SPREAD;
  if (readings.length < minSources) {
    return {
      ok: false,
      reason: `only ${readings.length} of ${SOURCES.length} sources fresh (need >= ${minSources})`,
    };
  }
  const prices = readings.map((r) => r.price);
  const median = computeMedian(prices);
  const spreadPct = (Math.max(...prices) - Math.min(...prices)) / median;
  if (spreadPct > maxSpreadPct) {
    return {
      ok: false,
      reason: `spread ${(spreadPct * 100).toFixed(2)}% exceeds ${maxSpreadPct * 100}% — venues disagree, reading rejected`,
    };
  }
  return { ok: true, price: median, spreadPct, sources: readings.map((r) => r.source) };
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse one venue's JSON into a price (null = unusable response). */
export function parseSourcePrice(source: MedianSource, body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null;
  switch (source) {
    case 'coingecko': {
      const usd = (body as { 'hashkey-ecopoints'?: { usd?: unknown } })['hashkey-ecopoints']?.usd;
      return toFiniteNumber(usd);
    }
    case 'kraken': {
      const c = (body as { result?: { HSKUSD?: { c?: unknown[] } } }).result?.HSKUSD?.c?.[0];
      return toFiniteNumber(c);
    }
    case 'gate': {
      const last = Array.isArray(body) ? (body[0] as { last?: unknown } | undefined)?.last : undefined;
      return toFiniteNumber(last);
    }
    case 'mexc': {
      const price = (body as { price?: unknown }).price;
      return toFiniteNumber(price);
    }
  }
}

export interface ReferenceMedianReaderOptions {
  /** Injected fetch (tests) — defaults to the global fetch. */
  fetchFn?: FetchLike;
  /** Per-source timeout ms (default 5000). */
  timeoutMs?: number;
  /** Max CoinGecko age sec (default 120). */
  maxSourceAgeSec?: number;
  /** Max spread fraction (default 0.02). */
  maxSpreadPct?: number;
  /** Min fresh sources (default 3). */
  minSources?: number;
  /** Max cache age sec (default 300). */
  maxCacheAgeSec?: number;
  /** Clock override (tests). */
  nowMs?: () => number;
}

export class ReferenceMedianReader {
  private fetchFn: FetchLike;
  private timeoutMs: number;
  private maxSourceAgeSec: number;
  private maxSpreadPct: number;
  private minSources: number;
  private maxCacheAgeSec: number;
  private nowMs: () => number;
  private lastGood: ReferenceMedianReading | null = null;

  constructor(opts: ReferenceMedianReaderOptions = {}) {
    this.fetchFn = opts.fetchFn ?? (fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxSourceAgeSec = opts.maxSourceAgeSec ?? COINGECKO_MAX_AGE_SEC;
    this.maxSpreadPct = opts.maxSpreadPct ?? MAX_SPREAD;
    this.minSources = opts.minSources ?? MIN_SOURCES;
    this.maxCacheAgeSec = opts.maxCacheAgeSec ?? MAX_CACHE_AGE_SEC;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  private async fetchJson(url: string): Promise<unknown | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null; // timeout / network failure -> source dropped
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch all four venues in parallel; drop any that fail or are stale. */
  async fetchSources(): Promise<SourceReading[]> {
    const now = this.nowMs();
    const results = await Promise.all(
      SOURCES.map(async (source): Promise<SourceReading | null> => {
        const body = await this.fetchJson(SOURCE_URLS[source]);
        if (body === null) return null;
        // CoinGecko is the only source with a timestamp — enforce it.
        if (source === 'coingecko') {
          const updated = (body as { 'hashkey-ecopoints'?: { last_updated_at?: unknown } })[
            'hashkey-ecopoints'
          ]?.last_updated_at;
          const updatedSec = typeof updated === 'number' ? updated : NaN;
          const ageSec = now / 1000 - updatedSec;
          if (!Number.isFinite(ageSec) || ageSec > this.maxSourceAgeSec || ageSec < -300) {
            return null; // stale (or implausibly future) CoinGecko quote
          }
        }
        const price = parseSourcePrice(source, body);
        if (price === null) return null;
        return { source, price, fetchedAtMs: now };
      }),
    );
    return results.filter((r): r is SourceReading => r !== null);
  }

  /**
   * One median read. Returns the reading (fresh, or from cache after a
   * fetch failure) or null on ANY rejection: too few sources, spread > 2%,
   * or cache expired. A spread rejection is never masked by the cache.
   * Callers must check `fresh` — a null reading is a missing reference.
   */
  async read(): Promise<ReferenceMedianReading | null> {
    const now = this.nowMs();
    const readings = await this.fetchSources();
    const aggregated =
      readings.length >= this.minSources
        ? aggregateMedian(readings, { minSources: this.minSources, maxSpreadPct: this.maxSpreadPct })
        : ({ ok: false, reason: `only ${readings.length} sources responded` } as const);
    if (aggregated.ok) {
      const reading: ReferenceMedianReading = {
        price: aggregated.price,
        sources: aggregated.sources,
        spreadPct: aggregated.spreadPct,
        fetchedAtMs: now,
        ageSec: 0,
        fresh: true,
        fromCache: false,
        source: REFERENCE_MEDIAN_SOURCE,
      };
      this.lastGood = reading;
      return reading;
    }
    // Fetch failed (<3 sources): serve last-good if still within 5 min.
    // A spread rejection (aggregated.ok === false with enough sources) is
    // deliberate disagreement — do NOT serve cache over it.
    const spreadRejected = readings.length >= this.minSources;
    if (!spreadRejected && this.lastGood) {
      const ageSec = (now - this.lastGood.fetchedAtMs) / 1000;
      if (ageSec <= this.maxCacheAgeSec) {
        return { ...this.lastGood, ageSec, fresh: true, fromCache: true };
      }
    }
    return null;
  }
}
