import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateMedian,
  computeMedian,
  parseSourcePrice,
  REFERENCE_MEDIAN_SOURCE,
  ReferenceMedianReader,
  type FetchLike,
  type MedianSource,
} from '../src/referenceMedian.js';
import { scoreTPoolSignal, REFERENCE_MEDIAN_MAX_POINTS } from '../src/signal.js';
import { Agent } from '../src/agent.js';
import { SupraReader, type SupraContractLike } from '../src/supra.js';
import type { PoolTwap } from '../src/observe.js';

// Recorded live responses, 2026-11-23 ~11:04 UTC (13:04 SAST) — frozen as
// fixtures. Median $0.0806235, spread 0.20%.
const LIVE = {
  coingecko: { 'hashkey-ecopoints': { usd: 0.080567, usd_24h_change: 0.10507, last_updated_at: 1795431811 } },
  kraken: { result: { HSKUSD: { a: ['0.080920000'], b: ['0.080690000'], c: ['0.080540000'], v: ['2122.00000'], p: ['0.080493147', '0.080540000'], o: '0.080590000' } } },
  gate: [{ currency_pair: 'HSK_USDT', last: '0.0807', lowest_ask: '0.08084', highest_bid: '0.0807', change_percentage: '-0.12', base_volume: '106716', high_24h: '0.08128', low_24h: '0.07999' }],
  mexc: { symbol: 'HSKUSDT', price: '0.08068' },
};
const NOW_MS = 1795431840000; // 2026-11-23 11:04:00 UTC; CoinGecko quote 29 s old

function stubFetch(bodies: Partial<Record<string, unknown>>, fail: string[] = []): FetchLike {
  return async (url: string) => {
    const key = Object.keys(bodies).find((k) => url.includes(k));
    if (!key || fail.includes(key)) throw new Error(`fetch failed: ${url}`);
    return { ok: true, status: 200, json: async () => bodies[key] };
  };
}

const liveFetch = () =>
  stubFetch({
    'coingecko.com': LIVE.coingecko,
    'kraken.com': LIVE.kraken,
    'gateio.ws': LIVE.gate,
    'mexc.com': LIVE.mexc,
  });

describe('computeMedian', () => {
  it('odd count returns the middle value; even count averages the two middles', () => {
    expect(computeMedian([3, 1, 2])).toBe(2);
    expect(computeMedian([0.08054, 0.080567, 0.08068, 0.0807])).toBeCloseTo(0.0806235, 9);
  });
  it('a +5% outlier does not move a 4-source median (it is not a middle value)', () => {
    const clean = computeMedian([0.08054, 0.080567, 0.08068, 0.0807]);
    const withOutlier = computeMedian([0.08054, 0.080567, 0.08068, 0.0847]);
    expect(withOutlier).toBeCloseTo(clean, 9);
  });
});

describe('parseSourcePrice', () => {
  it('parses the recorded live response shape of each venue', () => {
    expect(parseSourcePrice('coingecko', LIVE.coingecko)).toBeCloseTo(0.080567, 9);
    expect(parseSourcePrice('kraken', LIVE.kraken)).toBeCloseTo(0.08054, 9);
    expect(parseSourcePrice('gate', LIVE.gate)).toBeCloseTo(0.0807, 9);
    expect(parseSourcePrice('mexc', LIVE.mexc)).toBeCloseTo(0.08068, 9);
  });
  it('rejects missing, zero, negative and non-numeric prices', () => {
    expect(parseSourcePrice('mexc', { price: '0' })).toBeNull();
    expect(parseSourcePrice('mexc', { price: '-1' })).toBeNull();
    expect(parseSourcePrice('mexc', {})).toBeNull();
    expect(parseSourcePrice('kraken', { result: {} })).toBeNull();
    expect(parseSourcePrice('gate', [])).toBeNull();
  });
  it('uses hashkey-ecopoints, not hashkey-platform-token', () => {
    expect(parseSourcePrice('coingecko', { 'hashkey-platform-token': { usd: 1 } })).toBeNull();
  });
});

describe('aggregateMedian', () => {
  const readings = (prices: number[]): SourceReading[] =>
    prices.map((price, i) => ({ source: ['coingecko', 'kraken', 'gate', 'mexc'][i] as MedianSource, price, fetchedAtMs: NOW_MS }));

  it('live 2026-11-23 fixtures: median $0.0806235, spread 0.20%', () => {
    const r = aggregateMedian(readings([0.08054, 0.080567, 0.08068, 0.0807]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.price).toBeCloseTo(0.0806235, 9);
      expect(r.spreadPct).toBeCloseTo(0.00198, 4);
      expect(r.sources).toHaveLength(4);
    }
  });
  it('fewer than 3 sources -> rejected', () => {
    expect(aggregateMedian(readings([0.08054, 0.080567]))).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(aggregateMedian([]).ok).toBe(false);
  });
  it('spread >2% -> rejected (HashKey Exchange USD outlier shape: +4.7%)', () => {
    const r = aggregateMedian(readings([0.08054, 0.080567, 0.08068, 0.08434]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/spread .* exceeds 2%/);
  });
  it('3 sources within 2% pass', () => {
    const r = aggregateMedian(readings([0.08054, 0.080567, 0.08068]));
    expect(r.ok).toBe(true);
  });
});

describe('ReferenceMedianReader (stubbed fetch)', () => {
  it('returns a fresh median from all 4 live fixtures with the NOT-an-oracle label', async () => {
    const reader = new ReferenceMedianReader({ fetchFn: liveFetch(), nowMs: () => NOW_MS });
    const r = await reader.read();
    expect(r).not.toBeNull();
    expect(r!.price).toBeCloseTo(0.0806235, 9);
    expect(r!.sources).toEqual(['coingecko', 'kraken', 'gate', 'mexc']);
    expect(r!.spreadPct).toBeLessThan(0.02);
    expect(r!.fresh).toBe(true);
    expect(r!.fromCache).toBe(false);
    expect(r!.source).toBe(REFERENCE_MEDIAN_SOURCE);
    expect(r!.source).toBe('reference-median (NOT an oracle)');
  });
  it('one source down -> still returns from the other 3', async () => {
    const reader = new ReferenceMedianReader({
      fetchFn: stubFetch(
        { 'coingecko.com': LIVE.coingecko, 'kraken.com': LIVE.kraken, 'gateio.ws': LIVE.gate, 'mexc.com': LIVE.mexc },
        ['mexc.com'],
      ),
      nowMs: () => NOW_MS,
    });
    const r = await reader.read();
    expect(r).not.toBeNull();
    expect(r!.sources).toHaveLength(3);
    expect(r!.sources).not.toContain('mexc');
    expect(r!.price).toBeCloseTo(0.080567, 6); // median of 3 = middle value
  });
  it('stale CoinGecko timestamp -> that source dropped, median still returns from 3', async () => {
    const staleGecko = { 'hashkey-ecopoints': { usd: 0.080567, last_updated_at: 1795431811 - 600 } }; // 629 s old
    const reader = new ReferenceMedianReader({
      fetchFn: stubFetch({ 'coingecko.com': staleGecko, 'kraken.com': LIVE.kraken, 'gateio.ws': LIVE.gate, 'mexc.com': LIVE.mexc }),
      nowMs: () => NOW_MS,
    });
    const r = await reader.read();
    expect(r).not.toBeNull();
    expect(r!.sources).not.toContain('coingecko');
    expect(r!.sources).toHaveLength(3);
  });
  it('fewer than 3 sources responding -> null (fail-closed)', async () => {
    const reader = new ReferenceMedianReader({
      fetchFn: stubFetch({ 'coingecko.com': LIVE.coingecko, 'kraken.com': LIVE.kraken }, ['gateio.ws', 'mexc.com']),
      nowMs: () => NOW_MS,
    });
    expect(await reader.read()).toBeNull();
  });
  it('spread >2% across venues -> null (fail-closed, not a median)', async () => {
    const diverged = { ...LIVE, gate: [{ ...LIVE.gate[0], last: '0.08434' }] }; // HashKey-Exchange-style outlier
    const reader = new ReferenceMedianReader({
      fetchFn: stubFetch({ 'coingecko.com': diverged.coingecko, 'kraken.com': diverged.kraken, 'gateio.ws': diverged.gate, 'mexc.com': diverged.mexc }),
      nowMs: () => NOW_MS,
    });
    expect(await reader.read()).toBeNull();
  });

  it('cache: fetch failure serves last-good within 5 min (flagged fromCache), then expires', async () => {
    let now = NOW_MS;
    let fail = false;
    const fetchFn: FetchLike = async (url: string) => {
      if (fail) throw new Error('down');
      return liveFetch()(url);
    };
    const reader = new ReferenceMedianReader({ fetchFn, nowMs: () => now });
    const first = await reader.read();
    expect(first?.fromCache).toBe(false);
    fail = true;
    now = NOW_MS + 240_000; // +4 min: still within cache
    const cached = await reader.read();
    expect(cached).not.toBeNull();
    expect(cached!.fromCache).toBe(true);
    expect(cached!.price).toBeCloseTo(first!.price, 9);
    expect(cached!.ageSec).toBeCloseTo(240, 0);
    now = NOW_MS + 301_000; // +5m01s: cache expired
    expect(await reader.read()).toBeNull();
  });
  it('cache is NOT served over a spread rejection (venue disagreement is evidence)', async () => {
    let now = NOW_MS;
    let diverged = false;
    const fetchFn: FetchLike = async (url: string) => {
      if (!diverged) return liveFetch()(url);
      const res = await liveFetch()(url);
      if (url.includes('gateio.ws')) {
        return { ok: true, status: 200, json: async () => [{ ...LIVE.gate[0], last: '0.08434' }] };
      }
      return res;
    };
    const reader = new ReferenceMedianReader({ fetchFn, nowMs: () => now });
    expect((await reader.read())?.fromCache).toBe(false);
    diverged = true;
    now = NOW_MS + 60_000; // 1 min later, cache still valid — but spread rejects
    expect(await reader.read()).toBeNull();
  });
});

describe('scoreTPoolSignal with the reference median (fallback-only)', () => {
  const BASE = { price: 0.08, twap24h: 0.084, twap7d: 0.084, volumeTrend: 1 };

  it('median fills the reference slot while Supra is stale, capped at 14 pts', () => {
    // Pool 0.08 vs median 0.08426: -506 bps -> +506/1000 * 14 = ~7 pts.
    const s = scoreTPoolSignal({ ...BASE, supraStatus: 'stale', supraPrice: 0.08426, referenceMedianPrice: 0.08426, referenceMedianStatus: 'fresh' });
    expect(s.referenceSource).toBe('reference-median');
    expect(s.components.supra).toBe(7);
    expect(s.reasons.join(' ')).toMatch(/reference-median \(NOT an oracle\)/);
  });
  it('median component saturates at 14, never 30', () => {
    const s = scoreTPoolSignal({ price: 0.07, twap24h: 0.084, twap7d: 0.084, volumeTrend: 1, supraStatus: 'stale', referenceMedianPrice: 0.08426, referenceMedianStatus: 'fresh' });
    expect(s.components.supra).toBe(14);
  });
  it('fresh Supra ALWAYS wins over the median (precedence)', () => {
    // Supra 0.08426 says pool cheap (+15); a divergent median 0.07 would say
    // pool expensive (-14). The score must follow Supra, not the median.
    const s = scoreTPoolSignal({ ...BASE, supraPrice: 0.08426, supraStatus: 'fresh', referenceMedianPrice: 0.07, referenceMedianStatus: 'fresh' });
    expect(s.referenceSource).toBe('supra');
    expect(s.components.supra).toBe(15);
  });
  it('median can never push the score over threshold 60 on its own: twap 45 + median 14 = 59', () => {
    // Price 0.075 is 13.7% below the 24h TWAP (full 45) and 11.0% below the
    // median (full capped 14): 45 + 14 = 59, still below threshold 60.
    const s = scoreTPoolSignal({ price: 0.075, twap24h: 0.0869, twap7d: 0.0869, volumeTrend: 1, supraStatus: 'stale', referenceMedianPrice: 0.08426, referenceMedianStatus: 'fresh' });
    expect(s.components.twap).toBe(45);
    expect(s.components.supra).toBe(14);
    expect(s.score).toBe(59);
    expect(s.score).toBeLessThan(60);
  });
  it('stale/missing median scores 0 and reports referenceSource none', () => {
    const stale = scoreTPoolSignal({ ...BASE, supraStatus: 'stale', referenceMedianPrice: 0.08426, referenceMedianStatus: 'stale' });
    expect(stale.components.supra).toBe(0);
    expect(stale.referenceSource).toBe('none');
    expect(stale.supraDeviationBps).toBeNull();
    const missing = scoreTPoolSignal({ ...BASE, supraStatus: 'missing' });
    expect(missing.components.supra).toBe(0);
    expect(missing.referenceSource).toBe('none');
  });
});

describe('Agent poll with the reference median (fakes)', () => {
  const NOW = 1795430000000;
  const STALE_SUPRA: SupraContractLike = {
    getSvalue: async () => ({ round: 1n, decimals: 18n, time: BigInt(NOW - 7 * 86400_000), price: 84260000000000000n }),
  };
  const CAPS = { perTradeCapBps: 1000, dailyCapBps: 3000, stopLossBps: 200, maxDrawdownBps: 1000, dailyLossLimitBps: 500, halted: false };
  function twap(twapPrice: number, spotPrice: number, secondsAgo: number): PoolTwap {
    return {
      pool: '0x840fa6e439F52cEa60dABec8BBB820DE80dDb542',
      twapPrice,
      meanTick: -300757,
      spotPrice,
      spotTick: -300757,
      secondsAgo,
      frozen: twapPrice === spotPrice,
      timestamp: Math.floor(NOW / 1000),
      token0: '0x198c3EC5530463290e2F16988Bf6B8006F4C6995',
      token1: '0xD57a8171b83E154145f47DcE512786173a9A36ca',
    };
  }
  function journalDir() {
    return mkdtempSync(join(tmpdir(), 'hsk-agent-median-'));
  }

  it('Supra stale + fresh median: signal uses the median (labelled), journal carries the label', async () => {
    const medianReader = new ReferenceMedianReader({ fetchFn: liveFetch(), nowMs: () => NOW_MS });
    const agent = new Agent({}, 'paper', join(journalDir(), 'j.jsonl'), new SupraReader(null, { contract: STALE_SUPRA, maxAgeSec: 86400, nowMs: () => NOW }), {
      fetchTwap: async (_p, w) => twap(0.0868845, 0.0868845, w),
      fetchOldPools: async () => ({ low: 78.24, high: 54.18 }),
      fetchTPoolSwaps: async () => [],
      readVaultCapsFn: async () => CAPS,
      readVaultPoolKindFn: async () => 1,
      referenceMedianReader: medianReader,
    });
    const out = await agent.poll();
    expect(agent.state.lastReferenceMedian?.price).toBeCloseTo(0.0806235, 9);
    expect(agent.state.lastSignal?.referenceSource).toBe('reference-median');
    // Pool 0.0868845 vs median 0.0806235: +776 bps -> -776/1000 * 14 = -11.
    expect(agent.state.lastSignal?.components.supra).toBe(-11);
    expect(agent.state.lastSignal?.score).toBe(0); // clamped, no trade
    expect(out.action).toMatch(/no trade — score 0 < 60/);
    const entries = agent.journal.readAll();
    const medianEntry = entries.find((e) => e.type === 'reference-median');
    expect(medianEntry?.source).toBe('reference-median (NOT an oracle)');
    expect(medianEntry?.status).toBe('fresh');
    const signalEntry = entries.find((e) => e.type === 'signal');
    expect(signalEntry?.referenceSource).toBe('reference-median');
  });
});
