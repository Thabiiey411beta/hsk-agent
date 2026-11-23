// Risk gates — fail-closed. Any missing data blocks; any breached limit halts.
export interface RiskState {
  equity: number;
  peakEquity: number;
  dailyPnl: number; // USDT, today
  deployedToday: number;
  openPositions: number;
  halted: boolean;
  haltReason: string;
  day: string; // YYYY-MM-DD
}

export function newRiskState(equity: number): RiskState {
  return {
    equity,
    peakEquity: equity,
    dailyPnl: 0,
    deployedToday: 0,
    openPositions: 0,
    halted: false,
    haltReason: '',
    day: new Date().toISOString().slice(0, 10),
  };
}

export interface RiskCheck {
  pass: boolean;
  reasons: string[];
}

/** Evaluate all gates. `dataOk=false` (missing subgraph/RPC/quote data) always fails. */
export function checkRisk(
  state: RiskState,
  cfg: { dailyLossLimit: number; maxDrawdown: number; stopLoss: number },
  opts: { dataOk: boolean; positionPnlPct?: number; today: string },
): RiskCheck {
  const reasons: string[] = [];
  if (!opts.dataOk) reasons.push('BLOCKED: missing market data (subgraph/RPC/quote unavailable) — fail-closed');
  if (state.halted) reasons.push(`HALTED: ${state.haltReason}`);
  if (opts.today !== state.day) {
    // New day: daily counters reset by the agent; treat stale state as a block
    // until the agent resets it, so a stale process can never trade on old limits.
    reasons.push('BLOCKED: stale risk state (day rollover not yet applied)');
  }
  if (state.dailyPnl < -cfg.dailyLossLimit * state.equity) {
    reasons.push(
      `daily loss limit breached: ${state.dailyPnl.toFixed(2)} USDT < -${(cfg.dailyLossLimit * 100).toFixed(1)}% of equity`,
    );
  }
  const drawdown = (state.peakEquity - state.equity) / state.peakEquity;
  if (drawdown > cfg.maxDrawdown) {
    reasons.push(`max drawdown breached: ${(drawdown * 100).toFixed(1)}% > ${(cfg.maxDrawdown * 100).toFixed(1)}%`);
  }
  if (opts.positionPnlPct !== undefined && opts.positionPnlPct <= -cfg.stopLoss) {
    reasons.push(`stop-loss hit on open position: ${(opts.positionPnlPct * 100).toFixed(2)}% <= -${(cfg.stopLoss * 100).toFixed(1)}%`);
  }
  return { pass: reasons.length === 0, reasons };
}

export function applyHalt(state: RiskState, reason: string): void {
  state.halted = true;
  state.haltReason = reason;
}

export function resetDay(state: RiskState, today: string): void {
  state.day = today;
  state.dailyPnl = 0;
  state.deployedToday = 0;
  state.halted = false;
  state.haltReason = '';
}
