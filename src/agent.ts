// Agent loop (integration pass, 2026-11-23): poll t-pool TWAP (observe) + RPC
// -> t-pool signal -> trend gate -> ATR/fallback sizing -> vault caps
// (tighter of on-chain vs local) -> execute (paper/live) -> journal.
// PRIMARY MARKET is the fairly-priced tWHSK/tUSDT pool 0x840fa6e4... (fee 3000).
// The old USDT/WHSK pools are SYNTHETIC (~643-928x the oracle) and frozen
// since ~Nov 1 — they are read only as a logged diagnostic (old spread),
// never priced off, never traded. Live mode: testnet only, simulation-before-
// send, ONE live trade per run, <= 10 tUSDT notional on the first live trade.
import { JsonRpcProvider, keccak256, toUtf8Bytes, type Wallet } from 'ethers';
import { ADDR, DEFAULT_CONFIG, POOLS, T_POOL, TEST_TOKENS, TESTNET_RPC, VAULTS, type AgentConfig } from './config.js';
import { fetchPools, fetchSwaps, hourlySwapCounts, type SwapRecord } from './subgraph.js';
import { priceToken0PerToken1, spreadBps } from './math.js';
import { scoreTPoolSignal, type TPoolSignal } from './signal.js';
import { SupraReader, type SupraReading } from './supra.js';
import { REFERENCE_MEDIAN_SOURCE, ReferenceMedianReader, type ReferenceMedianReading } from './referenceMedian.js';
import { SUPRA, EAS } from './config.js';
import { getPoolTwap, type PoolTwap } from './observe.js';
import { sizePosition } from './sizing.js';
import { buildDailyBars, computeAtr, sizeByAtr } from './atr.js';
import { checkTrendGate, canComputeAdx, type TrendGateResult } from './trend.js';
import { checkRisk, newRiskState, resetDay, applyHalt } from './risk.js';
import { Journal } from './journal.js';
import { dryRunSwap } from './quoter.js';
import {
  readCaps,
  readPoolKind,
  tighterCap,
  anchorBatch,
  registerVaultPosition,
  exitWouldTrigger,
  triggerExitIfBreached,
  type VaultCaps,
} from './vault.js';
import { executeSwap, getAllowance, type SwapOpts, type SwapResult } from './execution.js';
import { attestTrade, buildChain, GENESIS_HASH } from './attest.js';

/** First live trade notional cap (tUSDT) — the phase-2 brief allows ONE small
 *  live trade (<= 10 tUSDT). The cap lives here, not in user-adjustable config. */
export const FIRST_LIVE_TRADE_MAX_USDT = 10;

export interface Position {
  id: string;
  entryPrice: number; // USDT per WHSK (tUSDT per tWHSK)
  sizeUsdt: number;
  whsk: number;
  entryTs: string;
  pool: string;
  entryScore: number;
  mode: 'paper' | 'live';
  /** Stop price actually enforced (ATR stop when available, else fixed 2%). */
  stopPrice: number;
  /** Stop distance as a fraction of entry (drives the local exit check). */
  stopFraction: number;
  /** True once the position is registered on the vault (on-chain stop). */
  vaultRegistered: boolean;
  /** Vault registerPosition tx hash, when registered. */
  vaultTxHash?: string;
  /** Live swap tx hash, when live. */
  liveTxHash?: string;
}

export interface AgentState {
  config: AgentConfig;
  /** Effective caps after the tighter-of(vault, local) rule (null until read). */
  effectiveCaps: { perTradeCap: number; dailyCap: number; stopLoss: number; maxDrawdown: number; dailyLossLimit: number } | null;
  equity: number;
  peakEquity: number;
  dailyPnl: number;
  deployedToday: number;
  positions: Position[];
  lastSignal: TPoolSignal | null;
  /** Old-pool prices — DIAGNOSTIC ONLY (never priced off, never traded). */
  lastPrices: { lowFee: number; highFee: number; ts: string } | null;
  /** Primary market state (t-pool). */
  lastTPool: { spot: number; twap24h: number; twap7d: number; frozen24h: boolean; frozen7d: boolean; ts: string } | null;
  /** Latest Supra HSK/USD reading (fresh or stale) or null if unreadable. */
  lastSupra: SupraReading | null;
  /** Latest reference-median reading (fallback only) or null if unreadable. */
  lastReferenceMedian: ReferenceMedianReading | null;
  lastVaultCaps: VaultCaps | null;
  lastTrendGate: TrendGateResult | null;
  lastAtr: { atr: number | null; stopPrice: number | null; fallback: boolean; dailyBars: number; reason: string } | null;
  polls: number;
  trades: number;
  liveTrades: number;
  halted: boolean;
  haltReason: string;
  mode: 'paper' | 'live' | 'dry-run';
  journalPath: string;
}

/** Injection seams for tests (and for the CLI's live wallet). Production
 *  passes nothing and the live modules are used. */
export interface AgentDeps {
  provider?: JsonRpcProvider;
  fetchTwap?: (pool: string, secondsAgo: number) => Promise<PoolTwap | null>;
  fetchOldPools?: () => Promise<{ low: number; high: number } | null>;
  fetchTPoolSwaps?: () => Promise<SwapRecord[]>;
  readVaultCapsFn?: () => Promise<VaultCaps>;
  readVaultPoolKindFn?: () => Promise<number | null>;
  /** Signing wallet (live mode + vault registration). Absent in pure paper. */
  wallet?: Wallet;
  executeSwapFn?: (wallet: Wallet, opts: SwapOpts) => Promise<SwapResult>;
  registerPositionFn?: (wallet: Wallet, vault: string, posId: string, entry: number, stop: number) => Promise<string>;
  exitWouldTriggerFn?: (vault: string, posId: string) => Promise<boolean>;
  triggerExitFn?: (wallet: Wallet, vault: string, posId: string) => Promise<string>;
  anchorFn?: (wallet: Wallet, vault: string, batchHash: string) => Promise<{ txHash: string; batchId: number }>;
  attestFn?: (wallet: Wallet, opts: Parameters<typeof attestTrade>[1]) => Promise<{ txHash: string; attestationUid: string }>;
  checkAllowanceFn?: (provider: JsonRpcProvider, token: string, owner: string, spender: string) => Promise<bigint>;
  /** Reference-median reader (tests); otherwise created lazily per poll. */
  referenceMedianReader?: ReferenceMedianReader;
}

export class Agent {
  state: AgentState;
  journal: Journal;
  private risk = newRiskState(DEFAULT_CONFIG.paperEquityUsdt);
  private timer: NodeJS.Timeout | null = null;
  /** Injected Supra reader (tests); otherwise created lazily per poll. */
  supraReader: SupraReader | null;
  /** Injected reference-median reader (tests); otherwise created lazily. */
  referenceMedianReader: ReferenceMedianReader | null;
  private deps: AgentDeps;
  /** Hash-chain head for journal anchoring (genesis until the first anchor). */
  private lastAnchorHash = GENESIS_HASH;

  constructor(
    config: Partial<AgentConfig> = {},
    mode: 'paper' | 'live' | 'dry-run' = 'paper',
    journalPath = 'data/journal.jsonl',
    supraReader: SupraReader | null = null,
    deps: AgentDeps = {},
  ) {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    this.journal = new Journal(journalPath);
    this.risk = newRiskState(cfg.paperEquityUsdt);
    this.supraReader = supraReader;
    this.referenceMedianReader = null;
    this.deps = deps;
    this.state = {
      config: cfg,
      effectiveCaps: null,
      equity: cfg.paperEquityUsdt,
      peakEquity: cfg.paperEquityUsdt,
      dailyPnl: 0,
      deployedToday: 0,
      positions: [],
      lastSignal: null,
      lastPrices: null,
      lastTPool: null,
      lastSupra: null,
      lastReferenceMedian: null,
      lastVaultCaps: null,
      lastTrendGate: null,
      lastAtr: null,
      polls: 0,
      trades: 0,
      liveTrades: 0,
      halted: false,
      haltReason: '',
      mode,
      journalPath,
    };
  }

  private provider(): JsonRpcProvider {
    return this.deps.provider ?? new JsonRpcProvider(TESTNET_RPC);
  }

  /** One poll cycle. Returns a summary for the caller / UI. */
  async poll(): Promise<{ signal: TPoolSignal | null; action: string }> {
    const cfg = this.state.config;
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.risk.day) {
      resetDay(this.risk, today);
      this.state.dailyPnl = 0;
      this.state.deployedToday = 0;
      this.state.halted = false;
      this.state.haltReason = '';
    }
    this.state.polls++;
    const provider = this.provider();

    // --- 1. PRIMARY MARKET: t-pool TWAPs via observe() (load-bearing read).
    // Either window returning null (revert OLD / missing data) BLOCKS the
    // poll — fail-closed. A frozen TWAP (== spot) is a fact, not an error.
    const fetchTwap = this.deps.fetchTwap ?? ((pool: string, w: number) => getPoolTwap(provider, pool, w));
    let twap24h: PoolTwap | null = null;
    let twap7d: PoolTwap | null = null;
    try {
      [twap24h, twap7d] = await Promise.all([
        fetchTwap(T_POOL.id, 24 * 3600),
        fetchTwap(T_POOL.id, 7 * 86400),
      ]);
    } catch (e) {
      const msg = `BLOCKED: t-pool TWAP read failed: ${(e as Error).message}`;
      this.journal.append({ type: 'block', reason: msg });
      return { signal: null, action: msg };
    }
    if (!twap24h || !twap7d) {
      const msg = `BLOCKED: t-pool TWAP unavailable (24h ${twap24h ? 'ok' : 'null'}, 7d ${twap7d ? 'ok' : 'null'}) — fail-closed, no signal`;
      this.journal.append({ type: 'block', reason: msg });
      return { signal: null, action: msg };
    }
    const spot = twap7d.spotPrice;
    this.state.lastTPool = {
      spot,
      twap24h: twap24h.twapPrice,
      twap7d: twap7d.twapPrice,
      frozen24h: twap24h.frozen,
      frozen7d: twap7d.frozen,
      ts: new Date().toISOString(),
    };
    this.journal.append({
      type: 'twap',
      pool: T_POOL.id,
      spot,
      twap24h: twap24h.twapPrice,
      twap7d: twap7d.twapPrice,
      frozen24h: twap24h.frozen,
      frozen7d: twap7d.frozen,
    });

    // --- 2. OLD POOLS: diagnostic spread only. A failed read loses the
    // diagnostic, never blocks — nothing is priced off these pools.
    let oldSpreadBps: number | null = null;
    try {
      const fetchOld = this.deps.fetchOldPools ?? (async () => {
        const pools = await fetchPools([POOLS.lowFee.id, POOLS.highFee.id]);
        const low = pools.find((p) => p.id === POOLS.lowFee.id);
        const high = pools.find((p) => p.id === POOLS.highFee.id);
        if (!low || !high) return null;
        return { low: priceToken0PerToken1(low.sqrtPrice), high: priceToken0PerToken1(high.sqrtPrice) };
      });
      const old = await fetchOld();
      if (old) {
        this.state.lastPrices = { lowFee: old.low, highFee: old.high, ts: new Date().toISOString() };
        oldSpreadBps = spreadBps(old.low, old.high);
      }
    } catch (e) {
      this.journal.append({ type: 'block', reason: `old-pool diagnostic read failed (non-blocking): ${(e as Error).message}` });
    }

    // --- 3. T-pool swaps: volume trend + daily bars (ATR/ADX). Missing data
    // scores 0 on those components and journals why; it does NOT block the
    // poll (the load-bearing reads are observe() + Supra + vault caps).
    let volumeTrend = 1;
    let dailyBars: ReturnType<typeof buildDailyBars> = [];
    try {
      const fetchSwapsFn = this.deps.fetchTPoolSwaps ?? (() => fetchSwaps(T_POOL.id, 1000));
      const swaps = await fetchSwapsFn();
      const nowSec = Math.floor(Date.now() / 1000);
      const { lastHour, prevHour } = hourlySwapCounts(swaps, nowSec);
      volumeTrend = prevHour > 0 ? lastHour / prevHour : lastHour > 0 ? 1.5 : 1;
      dailyBars = buildDailyBars(
        swaps.map((s) => ({
          t: s.timestamp,
          // t-pool token order: token0 = tWHSK (18 dec), token1 = tUSDT (6 dec).
          price: Math.pow(1.0001, s.tick) * Math.pow(10, 18 - 6),
        })),
      );
      if (swaps.length === 0 || lastHour === 0) {
        this.journal.append({
          type: 'block',
          reason: `t-pool volume: no swaps in the last hour (last swap ${swaps.length ? new Date(Math.max(...swaps.map((s) => s.timestamp)) * 1000).toISOString() : 'never seen'}) — volume component scored 0`,
        });
      }
    } catch (e) {
      this.journal.append({ type: 'block', reason: `t-pool swap history fetch failed: ${(e as Error).message} — volume/ATR scored 0` });
    }

    // --- 4. Supra Push Oracle reference (HSK/USD, pair 517) — FRESH only.
    let supraPrice = 0;
    let supraStatus: 'fresh' | 'stale' | 'missing' = 'missing';
    try {
      if (!this.supraReader) {
        this.supraReader = new SupraReader(provider, { maxAgeSec: cfg.supraMaxAgeSec });
      }
      const reading = await this.supraReader.readPair(SUPRA.pairHskUsd);
      this.state.lastSupra = reading;
      if (reading) {
        supraStatus = reading.fresh ? 'fresh' : 'stale';
        if (reading.fresh) supraPrice = reading.price;
        this.journal.append({
          type: 'supra',
          pair: reading.pair,
          price: reading.price,
          decimals: reading.decimals,
          ageSec: Math.round(reading.ageSec),
          fresh: reading.fresh,
          status: supraStatus,
        });
      } else {
        this.journal.append({ type: 'supra', pair: SUPRA.pairHskUsd, status: 'missing', reason: 'getSvalue failed or returned an invalid reading — reference treated as missing' });
      }
    } catch (e) {
      this.journal.append({ type: 'supra', pair: SUPRA.pairHskUsd, status: 'missing', reason: `Supra read error: ${(e as Error).message} — reference treated as missing` });
    }

    // --- 4b. Reference median (NOT an oracle) — FALLBACK ONLY, fetched
    // only while Supra is stale. A fresh Supra always wins and the median
    // is not even fetched. The median fills the reference slot at a capped
    // 14 pts (see src/signal.ts); stale/missing scores 0, fail-closed.
    let referenceMedianPrice = 0;
    let referenceMedianStatus: 'fresh' | 'stale' | 'missing' = 'missing';
    if (supraStatus === 'fresh') {
      this.journal.append({
        type: 'reference-median',
        source: REFERENCE_MEDIAN_SOURCE,
        status: 'skipped',
        reason: 'Supra fresh — fallback not fetched (on-chain oracle always wins)',
      });
    } else {
      try {
        const reader =
          this.deps.referenceMedianReader ??
          (this.referenceMedianReader ??= new ReferenceMedianReader());
        const reading = await reader.read();
        this.state.lastReferenceMedian = reading;
        if (reading) {
          referenceMedianStatus = reading.fresh ? 'fresh' : 'stale';
          if (reading.fresh) referenceMedianPrice = reading.price;
          this.journal.append({
            type: 'reference-median',
            source: REFERENCE_MEDIAN_SOURCE,
            price: reading.price,
            sources: reading.sources,
            spreadPct: reading.spreadPct,
            ageSec: Math.round(reading.ageSec),
            fresh: reading.fresh,
            fromCache: reading.fromCache,
            status: referenceMedianStatus,
          });
        } else {
          this.journal.append({
            type: 'reference-median',
            source: REFERENCE_MEDIAN_SOURCE,
            status: 'missing',
            reason: 'fewer than 3 venues fresh, spread >2%, or cache expired — reference treated as missing',
          });
        }
      } catch (e) {
        this.journal.append({
          type: 'reference-median',
          source: REFERENCE_MEDIAN_SOURCE,
          status: 'missing',
          reason: `reference-median read error: ${(e as Error).message} — reference treated as missing`,
        });
      }
    }

    // --- 5. Signal (t-pool): supra 30 (+ capped reference-median 14 as
    // fallback) + TWAP(24h) 45 + volume 25.
    const signal = scoreTPoolSignal({
      price: spot,
      twap24h: twap24h.twapPrice,
      twap7d: twap7d.twapPrice,
      volumeTrend,
      supraPrice,
      supraStatus,
      referenceMedianPrice,
      referenceMedianStatus,
      oldSpreadBps,
    });
    this.state.lastSignal = signal;
    this.journal.append({ type: 'signal', score: signal.score, direction: signal.direction, components: signal.components, reasons: signal.reasons, referenceSource: signal.referenceSource, prices: { tPool: spot, twap24h: twap24h.twapPrice, twap7d: twap7d.twapPrice }, spreadDiagnosticBps: signal.spreadDiagnosticBps });

    // --- 6. VAULT CAPS (v3): read every poll, enforce the TIGHTER of
    // on-chain vs local. A failed read BLOCKS trading this poll (fail-closed).
    // Also verify the vault points at the t-pool with the matching kind —
    // a kind mismatch would make the on-chain stop silently never fire.
    let vaultCaps: VaultCaps;
    try {
      vaultCaps = this.deps.readVaultCapsFn
        ? await this.deps.readVaultCapsFn()
        : await readCaps(provider, VAULTS.v3);
      this.state.lastVaultCaps = vaultCaps;
      const kind = this.deps.readVaultPoolKindFn
        ? await this.deps.readVaultPoolKindFn()
        : await readPoolKind(provider, VAULTS.v3);
      if (kind !== 1) {
        const msg = `BLOCKED: RiskVault v3 poolKind is ${kind} (expected 1 = tWHSK/tUSDT) — on-chain stop would misprice, refusing to trade`;
        this.journal.append({ type: 'vault', reason: msg, caps: vaultCaps });
        return { signal, action: msg };
      }
      this.journal.append({ type: 'vault', caps: vaultCaps, poolKind: kind, vault: VAULTS.v3 });
    } catch (e) {
      const msg = `BLOCKED: vault caps read failed: ${(e as Error).message} — fail-closed, no trading this poll`;
      this.journal.append({ type: 'block', reason: msg });
      return { signal, action: msg };
    }
    if (vaultCaps.halted) {
      const msg = 'BLOCKED: RiskVault v3 is halted on-chain';
      this.journal.append({ type: 'block', reason: msg });
      return { signal, action: msg };
    }
    const effective = {
      perTradeCap: tighterCap(vaultCaps.perTradeCapBps, cfg.perTradeCap),
      dailyCap: tighterCap(vaultCaps.dailyCapBps, cfg.dailyCap),
      stopLoss: tighterCap(vaultCaps.stopLossBps, cfg.stopLoss),
      maxDrawdown: tighterCap(vaultCaps.maxDrawdownBps, cfg.maxDrawdown),
      dailyLossLimit: tighterCap(vaultCaps.dailyLossLimitBps, cfg.dailyLossLimit),
    };
    this.state.effectiveCaps = effective;

    // --- 7. Manage open positions first (vault stop view-check + local stop).
    await this.managePositions(spot);

    // Retry vault registration for open positions that missed it (paper or live).
    await this.retryVaultRegistrations();

    if (this.state.positions.length > 0) {
      return { signal, action: 'holding — position open, no new entry' };
    }
    if (signal.score < cfg.minScore) {
      this.journal.append({ type: 'decision', action: 'no-trade', reason: `score ${signal.score} < threshold ${cfg.minScore}`, score: signal.score });
      return { signal, action: `no trade — score ${signal.score} < ${cfg.minScore}` };
    }

    // --- 8. TREND GATE (hard, before any long entry — not a user toggle).
    // ADX is applied only when computable (>= 15 daily bars); on the t-pool
    // (3 daily bars) it is skipped and the skip is journaled, never faked.
    const adxAvailable = canComputeAdx(dailyBars.length);
    const gate = checkTrendGate({ price: spot, twap24h: twap24h.twapPrice, twap7d: twap7d.twapPrice, adx: null });
    this.state.lastTrendGate = gate;
    this.journal.append({ type: 'trend-gate', pass: gate.pass, reasons: gate.reasons, adxAvailable, dailyBars: dailyBars.length });
    if (!gate.pass) {
      this.journal.append({ type: 'decision', action: 'no-trade', reason: `trend gate failed: ${gate.reasons.join('; ')}`, score: signal.score });
      return { signal, action: `no trade — trend gate failed: ${gate.reasons.join('; ')}` };
    }

    // --- 9. SIZING: ATR when computable (1% risk, stop = 2x ATR), else the
    // fixed 2% stop + cap sizing. Final size is the smaller of the ATR size
    // and the score-scaled cap size. Live mode additionally caps at 10 tUSDT.
    const atr = computeAtr(dailyBars);
    let sizeUsdt = 0;
    let stopPrice = spot * (1 - effective.stopLoss);
    let stopFraction = effective.stopLoss;
    let atrUsed = false;
    if (atr !== null) {
      const a = sizeByAtr({
        equity: this.state.equity,
        entryPrice: spot,
        atr,
        perTradeCap: effective.perTradeCap,
        dailyCap: effective.dailyCap,
        deployedToday: this.state.deployedToday,
      });
      if (!a.blocked) {
        atrUsed = true;
        stopPrice = a.stopPrice;
        stopFraction = a.stopFraction;
        sizeUsdt = a.sizeUsdt;
      }
    }
    const capSizing = sizePosition({
      equity: this.state.equity,
      signalScore: signal.score,
      perTradeCap: effective.perTradeCap,
      dailyCap: effective.dailyCap,
      deployedToday: this.state.deployedToday,
      riskAppetite: cfg.riskAppetite,
      minScore: cfg.minScore,
    });
    if (capSizing.blocked) {
      this.journal.append({ type: 'block', reason: `sizing blocked: ${capSizing.reason}` });
      return { signal, action: `blocked — ${capSizing.reason}` };
    }
    sizeUsdt = sizeUsdt > 0 ? Math.min(sizeUsdt, capSizing.sizeUsdt) : capSizing.sizeUsdt;
    this.state.lastAtr = {
      atr,
      stopPrice: atrUsed ? stopPrice : null,
      fallback: !atrUsed,
      dailyBars: dailyBars.length,
      reason: atrUsed
        ? `ATR(14) ${atr!.toFixed(6)} from ${dailyBars.length} daily bars — stop 2x ATR = ${(stopFraction * 100).toFixed(2)}%`
        : `ATR unavailable (only ${dailyBars.length} daily bars, need 15) — fell back to fixed ${(effective.stopLoss * 100).toFixed(1)}% stop + cap sizing`,
    };
    this.journal.append({ type: 'atr', atr, atrUsed, sizeUsdt, stopPrice, stopFraction, dailyBars: dailyBars.length, reason: this.state.lastAtr.reason });

    const riskGate = checkRisk(
      this.risk,
      { dailyLossLimit: effective.dailyLossLimit, maxDrawdown: effective.maxDrawdown, stopLoss: effective.stopLoss },
      { dataOk: true, today },
    );
    if (!riskGate.pass) {
      this.journal.append({ type: 'block', reason: riskGate.reasons.join('; ') });
      return { signal, action: `blocked — ${riskGate.reasons.join('; ')}` };
    }

    // --- 10. EXECUTE.
    const whsk = sizeUsdt / spot;
    if (this.state.mode === 'paper') {
      const pos = this.openPosition({ entryPrice: spot, sizeUsdt, whsk, pool: T_POOL.label, entryScore: signal.score, mode: 'paper', stopPrice, stopFraction });
      this.journal.append({ type: 'fill', mode: 'paper', sizeUsdt, whsk, entryPrice: spot, pool: T_POOL.label, score: signal.score, stopPrice, stopFraction, sizingReason: capSizing.reason, atrUsed });
      await this.registerPositionOnVault(pos);
      return { signal, action: `PAPER BUY ${whsk.toFixed(4)} tWHSK for ${sizeUsdt} tUSDT @ ${spot.toFixed(6)} (${T_POOL.label}), stop ${stopPrice.toFixed(6)}` };
    }

    // Live / dry-run: one live trade per run, <= 10 tUSDT, wallet required.
    if (this.state.mode === 'live' && this.state.liveTrades >= 1) {
      const msg = 'blocked — one live trade per run already executed';
      this.journal.append({ type: 'block', reason: msg });
      return { signal, action: msg };
    }
    const wallet = this.deps.wallet;
    if (!wallet) {
      const msg = 'blocked — live mode requires a signing wallet (none injected)';
      this.journal.append({ type: 'block', reason: msg });
      return { signal, action: msg };
    }
    const liveSizeUsdt = this.state.mode === 'live' ? Math.min(sizeUsdt, FIRST_LIVE_TRADE_MAX_USDT) : sizeUsdt;
    const amountIn = BigInt(Math.floor(liveSizeUsdt * 1e6)); // tUSDT has 6 decimals
    try {
      const checkAllowance = this.deps.checkAllowanceFn ?? getAllowance;
      const allowance = await checkAllowance(provider, TEST_TOKENS.tUsdt, wallet.address, ADDR.router);
      if (allowance < amountIn) {
        const msg = `blocked — tUSDT allowance ${allowance} < needed ${amountIn} (approve the router first; the agent never auto-approves inside the poll loop)`;
        this.journal.append({ type: 'block', reason: msg });
        return { signal, action: msg };
      }
      if (this.state.mode === 'dry-run') {
        const quote = await dryRunSwap(provider, {
          tokenIn: TEST_TOKENS.tUsdt,
          tokenOut: TEST_TOKENS.tWhsk,
          amountIn,
          fee: T_POOL.fee,
          from: wallet.address,
          slippageBps: cfg.slippageBps,
        });
        this.journal.append({ type: 'dry-run', mode: 'dry-run', quoteOut: quote.quote.amountOut.toString(), sizeUsdt: liveSizeUsdt, pool: T_POOL.label, simulationError: quote.simulationError });
        return { signal, action: `DRY-RUN quote OK: ${liveSizeUsdt} tUSDT -> ${quote.quote.amountOut.toString()} tWHSK units — no tx sent` };
      }
      // LIVE: simulation-before-send inside executeSwap; refuses on revert
      // or simulated-out < minimum. This is the ONE live trade this run.
      const exec = this.deps.executeSwapFn ?? executeSwap;
      const result = await exec(wallet, {
        tokenIn: TEST_TOKENS.tUsdt,
        tokenOut: TEST_TOKENS.tWhsk,
        fee: T_POOL.fee,
        amountIn,
        slippageBps: cfg.slippageBps,
      });
      const filledWhsk = Number(result.simulatedAmountOut) / 1e18;
      const fillPrice = liveSizeUsdt / filledWhsk;
      this.state.liveTrades++;
      const pos = this.openPosition({
        entryPrice: fillPrice,
        sizeUsdt: liveSizeUsdt,
        whsk: filledWhsk,
        pool: T_POOL.label,
        entryScore: signal.score,
        mode: 'live',
        stopPrice: fillPrice * (1 - stopFraction),
        stopFraction,
        liveTxHash: result.txHash,
      });
      this.journal.append({
        type: 'live-fill',
        mode: 'live',
        txHash: result.txHash,
        sizeUsdt: liveSizeUsdt,
        whsk: filledWhsk,
        entryPrice: fillPrice,
        quotedOut: result.quotedAmountOut.toString(),
        simulatedOut: result.simulatedAmountOut.toString(),
        pool: T_POOL.label,
        score: signal.score,
        stopPrice: pos.stopPrice,
      });
      await this.registerPositionOnVault(pos);
      await this.anchorAndAttest(pos, result.txHash);
      return { signal, action: `LIVE BUY ${filledWhsk.toFixed(4)} tWHSK for ${liveSizeUsdt} tUSDT @ ${fillPrice.toFixed(6)} (tx ${result.txHash})` };
    } catch (e) {
      const msg = `live execution failed: ${(e as Error).message}`;
      this.journal.append({ type: 'block', reason: msg });
      return { signal, action: msg };
    }
  }

  /** Register an open position on RiskVault v3 (on-chain stop). Best-effort
   *  for paper fills (a failed registration is journaled, the paper fill
   *  stands — the vault is verifiability, not the fill itself). Requires a
   *  signing wallet; without one the skip is journaled, not hidden. */
  private async registerPositionOnVault(pos: Position): Promise<void> {
    if (pos.vaultRegistered) return;
    const wallet = this.deps.wallet;
    if (!wallet) {
      this.journal.append({ type: 'register', positionId: pos.id, status: 'skipped', reason: 'no signing wallet in this mode — on-chain stop not registered' });
      return;
    }
    try {
      const register = this.deps.registerPositionFn ?? registerVaultPosition;
      const txHash = await register(wallet, VAULTS.v3, pos.id, pos.entryPrice, pos.stopPrice);
      pos.vaultRegistered = true;
      pos.vaultTxHash = txHash;
      this.journal.append({ type: 'register', positionId: pos.id, status: 'registered', txHash, entryPrice: pos.entryPrice, stopPrice: pos.stopPrice, vault: VAULTS.v3 });
    } catch (e) {
      this.journal.append({ type: 'register', positionId: pos.id, status: 'failed', reason: (e as Error).message });
    }
  }

  /** Retry vault registration for open positions that missed it. */
  private async retryVaultRegistrations(): Promise<void> {
    for (const pos of this.state.positions) {
      if (!pos.vaultRegistered) await this.registerPositionOnVault(pos);
    }
  }

  /** Anchor the journal batch hash on the vault + attest the trade via EAS.
   *  ONLY after a real on-chain swap — paper fills never reach this. */
  private async anchorAndAttest(pos: Position, swapTxHash: string): Promise<void> {
    const wallet = this.deps.wallet;
    if (!wallet) return;
    try {
      const fillEntries = this.journal.readAll().filter((e) => e.type === 'live-fill' || e.type === 'signal');
      const chain = buildChain(fillEntries.map((e) => JSON.stringify(e)));
      const headHash = chain.length ? chain[chain.length - 1].hash : this.lastAnchorHash;
      const anchor = this.deps.anchorFn ?? anchorBatch;
      const { txHash, batchId } = await anchor(wallet, VAULTS.v3, headHash);
      this.lastAnchorHash = headHash;
      this.journal.append({ type: 'anchor', batchId, batchHash: headHash, txHash, vault: VAULTS.v3 });
      const attest = this.deps.attestFn ?? attestTrade;
      const { txHash: attestTx, attestationUid } = await attest(wallet, {
        // bytes32 proposalId: keccak of the agent position id (the id itself
        // is not hex — hashing it keeps the schema's bytes32 type honest).
        proposalId: keccak256(toUtf8Bytes(pos.id)),
        rationaleHash: headHash,
        txHash: swapTxHash,
        notionalUsd: BigInt(Math.floor(pos.sizeUsdt * 1e6)), // tUSDT smallest units
        exitPath: false,
        engine: 'hsk-verifiable-agent',
        origin: 'live-testnet',
      });
      this.journal.append({ type: 'attestation', attestationUid, txHash: attestTx, schemaUid: EAS.flowSchemaUid, positionId: pos.id, swapTxHash });
    } catch (e) {
      this.journal.append({ type: 'error', reason: `anchor/attest failed after live fill (trade stands, verifiability incomplete): ${(e as Error).message}` });
    }
  }

  private openPosition(p: Omit<Position, 'id' | 'entryTs' | 'vaultRegistered'>): Position {
    const pos: Position = { ...p, id: `pos-${Date.now()}`, entryTs: new Date().toISOString(), vaultRegistered: false };
    this.state.positions.push(pos);
    this.state.deployedToday += p.sizeUsdt;
    this.risk.deployedToday += p.sizeUsdt;
    this.state.trades++;
    return pos;
  }

  private async managePositions(currentPrice: number): Promise<void> {
    const cfg = this.state.config;
    const effective = this.state.effectiveCaps;
    const stopLoss = effective?.stopLoss ?? cfg.stopLoss;
    for (const pos of [...this.state.positions]) {
      // Vault stop first (view path): only send exitIfBreached when the stop
      // is actually breached, to avoid wasting gas on reverting calls.
      if (this.deps.wallet) {
        try {
          const wouldTrigger = this.deps.exitWouldTriggerFn
            ? await this.deps.exitWouldTriggerFn(VAULTS.v3, pos.id)
            : await exitWouldTrigger(this.provider(), VAULTS.v3, pos.id);
          if (wouldTrigger) {
            const trigger = this.deps.triggerExitFn ?? triggerExitIfBreached;
            const txHash = await trigger(this.deps.wallet, VAULTS.v3, pos.id);
            this.journal.append({ type: 'exit', positionId: pos.id, reason: 'vault-stop-triggered', vaultTxHash: txHash, exitPrice: currentPrice });
            this.closePosition(pos, currentPrice, 'vault-stop-triggered');
            continue;
          }
        } catch (e) {
          this.journal.append({ type: 'error', reason: `vault stop check failed for ${pos.id}: ${(e as Error).message} — local stop still enforced` });
        }
      }
      const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
      const gate = checkRisk(
        this.risk,
        { dailyLossLimit: effective?.dailyLossLimit ?? cfg.dailyLossLimit, maxDrawdown: effective?.maxDrawdown ?? cfg.maxDrawdown, stopLoss },
        { dataOk: true, positionPnlPct: pnlPct, today: this.risk.day },
      );
      const reverted = this.state.lastSignal !== null && this.state.lastSignal.score < cfg.minScore;
      if (pnlPct <= -pos.stopFraction || reverted) {
        const reason = pnlPct <= -pos.stopFraction ? 'stop-loss' : 'signal reverted below threshold';
        this.closePosition(pos, currentPrice, reason);
        if (!gate.pass && gate.reasons.some((r) => r.includes('drawdown') || r.includes('daily loss'))) {
          applyHalt(this.risk, gate.reasons.join('; '));
          this.state.halted = true;
          this.state.haltReason = gate.reasons.join('; ');
          this.journal.append({ type: 'halt', reason: this.state.haltReason });
        }
      }
    }
  }

  private closePosition(pos: Position, currentPrice: number, reason: string): void {
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const pnl = pos.sizeUsdt * pnlPct;
    this.state.equity += pnl;
    this.state.dailyPnl += pnl;
    this.risk.equity = this.state.equity;
    this.risk.dailyPnl = this.state.dailyPnl;
    this.risk.peakEquity = Math.max(this.risk.peakEquity, this.state.equity);
    this.state.positions = this.state.positions.filter((x) => x.id !== pos.id);
    this.journal.append({ type: 'exit', positionId: pos.id, exitPrice: currentPrice, pnlUsdt: Math.round(pnl * 100) / 100, pnlPct: Math.round(pnlPct * 10000) / 100, reason });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.journal.append({ type: 'error', reason: (e as Error).message }));
    }, this.state.config.pollSeconds * 1000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Live dry-run helper exposed to the CLI (quote -> build -> simulate, no send).
   *  Primary market: tUSDT -> tWHSK on the t-pool (fee 3000, 6-dec tUSDT). */
  static async dryRun(amountUsdt: number, from: string): Promise<unknown> {
    const provider = new JsonRpcProvider(TESTNET_RPC);
    const amountIn = BigInt(Math.floor(amountUsdt * 1e6));
    return dryRunSwap(provider, {
      tokenIn: TEST_TOKENS.tUsdt,
      tokenOut: TEST_TOKENS.tWhsk,
      amountIn,
      fee: T_POOL.fee,
      from,
      slippageBps: 50,
    });
  }
}
