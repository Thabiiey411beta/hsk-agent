// Conversational interface: parse plain-English commands into agent actions.
// Commands: positions / pnl / status / set size <n>% / set frequency <seconds> /
// set risk <low|medium|high> / set target <USDT/WHSK|...> / halt / resume / help
import type { Agent } from './agent.js';

export interface ChatResult {
  reply: string;
  changed?: string;
}

export function handleChat(agent: Agent, raw: string): ChatResult {
  const text = raw.trim().toLowerCase();
  const s = agent.state;
  const cfg = s.config;

  if (/^(help|commands|\?)$/.test(text)) {
    return {
      reply: [
        'Commands I understand:',
        '- "show positions" / "pnl" / "status" — live positions, P&L, last signal',
        '- "show supra" / "show twap" / "show vault" — oracle, TWAPs, on-chain caps (read-only)',
        '- "set position size to 5%" — per-trade cap (1–25%)',
        '- "set trade frequency to 30 seconds" — poll interval (15s–1h)',
        '- "set risk to low / medium / high" — risk appetite + stop-loss',
        '- "set target asset to tWHSK/tUSDT" — target pair (only tWHSK/tUSDT on testnet)',
        '- "halt" / "resume" — pause / resume trading',
        'The trend gate is a safety rule, not a toggle — it cannot be switched off.',
      ].join('\n'),
    };
  }
  if (/show supra/.test(text)) {
    const sup = s.lastSupra;
    if (!sup) return { reply: 'No Supra reading yet — first poll pending.' };
    return {
      reply: `Supra HSK/USD (pair 517): $${sup.price} — age ${Math.round(sup.ageSec)}s (${(sup.ageSec / 86400).toFixed(2)}d), ${sup.fresh ? 'FRESH — scores in the signal' : 'STALE — treated as missing, scores 0'}.`,
    };
  }
  if (/show twap/.test(text)) {
    const t = s.lastTPool;
    if (!t) return { reply: 'No t-pool TWAP yet — first poll pending.' };
    return {
      reply: [
        `tWHSK/tUSDT pool: spot ${t.spot.toFixed(6)} tUSDT/tWHSK`,
        `24h observe() TWAP ${t.twap24h.toFixed(6)} (${t.frozen24h ? 'frozen — no trades in window' : 'live'})`,
        `7d observe() TWAP ${t.twap7d.toFixed(6)} (${t.frozen7d ? 'frozen — no trades in window' : 'live'})`,
      ].join('\n'),
    };
  }
  if (/show vault/.test(text)) {
    const v = s.lastVaultCaps;
    if (!v) return { reply: 'No vault caps read yet — first poll pending.' };
    const e = s.effectiveCaps;
    return {
      reply: [
        `RiskVault v3 caps (on-chain): per-trade ${(v.perTradeCapBps / 100).toFixed(0)}%, daily ${(v.dailyCapBps / 100).toFixed(0)}%, stop-loss ${(v.stopLossBps / 100).toFixed(0)}%, max drawdown ${(v.maxDrawdownBps / 100).toFixed(0)}%, daily loss ${(v.dailyLossLimitBps / 100).toFixed(0)}%, halted: ${v.halted ? 'YES' : 'no'}`,
        e ? `Effective (tighter of vault vs local): per-trade ${(e.perTradeCap * 100).toFixed(0)}%, daily ${(e.dailyCap * 100).toFixed(0)}%, stop-loss ${(e.stopLoss * 100).toFixed(1)}%` : '',
      ].join('\n'),
    };
  }
  if (/position|holding/.test(text)) {
    if (s.positions.length === 0) return { reply: 'No open positions. Paper equity is ' + s.equity.toFixed(2) + ' USDT.' };
    return {
      reply: s.positions
        .map((p) => `${p.mode.toUpperCase()} ${p.whsk.toFixed(4)} WHSK entered @ ${p.entryPrice.toFixed(2)} USDT/WHSK, size ${p.sizeUsdt} USDT, pool ${p.pool}, score ${p.entryScore}`)
        .join('\n'),
    };
  }
  if (/p\W?l|profit|loss/.test(text)) {
    const pnl = s.equity - cfg.paperEquityUsdt;
    return {
      reply: `Paper P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (${((pnl / cfg.paperEquityUsdt) * 100).toFixed(2)}%) on ${cfg.paperEquityUsdt} USDT starting equity. Daily P&L ${s.dailyPnl.toFixed(2)} USDT. Trades so far: ${s.trades}. (Paper numbers — not live profit.)`,
    };
  }
  if (/status/.test(text)) {
    const sig = s.lastSignal;
    const t = s.lastTPool;
    const g = s.lastTrendGate;
    const a = s.lastAtr;
    return {
      reply: [
        `Mode: ${s.mode} | Halted: ${s.halted ? 'YES — ' + s.haltReason : 'no'}`,
        `Equity: ${s.equity.toFixed(2)} USDT | Positions: ${s.positions.length} | Polls: ${s.polls} | Live trades this run: ${s.liveTrades}`,
        sig ? `Last signal: score ${sig.score}/100 (${sig.direction}), supra ${sig.components.supra}, twap ${sig.components.twap}, volume ${sig.components.volume}` : 'No signal yet — first poll pending.',
        t ? `t-pool: spot ${t.spot.toFixed(6)}, 24h TWAP ${t.twap24h.toFixed(6)}, 7d TWAP ${t.twap7d.toFixed(6)}` : '',
        s.lastPrices ? `Old pools (diagnostic only): 0.05% ${s.lastPrices.lowFee.toFixed(2)} USDT/WHSK, 0.3% ${s.lastPrices.highFee.toFixed(2)}` : '',
        g ? `Trend gate: ${g.pass ? 'PASS' : 'FAIL'} — ${g.reasons.join('; ')}` : '',
        a ? `ATR: ${a.fallback ? `fallback (${a.reason})` : `ATR ${a.atr!.toFixed(6)}, stop ${a.stopPrice!.toFixed(6)}`}` : '',
        `Caps: per-trade ${(cfg.perTradeCap * 100).toFixed(0)}%, daily ${(cfg.dailyCap * 100).toFixed(0)}%, stop-loss ${(cfg.stopLoss * 100).toFixed(1)}%, poll every ${cfg.pollSeconds}s, risk appetite ${cfg.riskAppetite}`,
      ].join('\n'),
    };
  }
  const sizeMatch = text.match(/position size (?:to )?(\d+(?:\.\d+)?)\s*%/);
  if (sizeMatch) {
    const pct = Number(sizeMatch[1]);
    if (pct < 1 || pct > 25) return { reply: 'Position size must be between 1% and 25% of equity.' };
    cfg.perTradeCap = pct / 100;
    return { reply: `Per-trade cap set to ${pct}% of equity.`, changed: `perTradeCap=${pct}%` };
  }
  const freqMatch = text.match(/frequen\w+ (?:to )?(\d+)\s*(second|minute|hour)/);
  if (freqMatch) {
    const n = Number(freqMatch[1]);
    const unit = freqMatch[2];
    const secs = unit.startsWith('minute') ? n * 60 : unit.startsWith('hour') ? n * 3600 : n;
    if (secs < 15 || secs > 3600) return { reply: 'Trade frequency must be between 15 seconds and 1 hour.' };
    cfg.pollSeconds = secs;
    return { reply: `Polling every ${secs} seconds now.`, changed: `pollSeconds=${secs}` };
  }
  const riskMatch = text.match(/risk (?:to )?(low|medium|high)/);
  if (riskMatch) {
    const level = riskMatch[1];
    if (level === 'low') {
      cfg.riskAppetite = 0.25;
      cfg.stopLoss = 0.01;
      cfg.perTradeCap = Math.min(cfg.perTradeCap, 0.05);
    } else if (level === 'medium') {
      cfg.riskAppetite = 0.5;
      cfg.stopLoss = 0.02;
    } else {
      cfg.riskAppetite = 0.9;
      cfg.stopLoss = 0.03;
      cfg.perTradeCap = Math.min(Math.max(cfg.perTradeCap, 0.1), 0.25);
    }
    return { reply: `Risk appetite set to ${level} (appetite ${cfg.riskAppetite}, stop-loss ${(cfg.stopLoss * 100).toFixed(1)}%).`, changed: `risk=${level}` };
  }
  const targetMatch = text.match(/target (?:asset|pair)? ?(?:to )?([a-z]+\/[a-z]+)/);
  if (targetMatch) {
    const pair = targetMatch[1].toUpperCase();
    if (pair === 'TWHSK/TUSDT' || pair === 'TUSDT/TWHSK') {
      return { reply: 'Target asset is tWHSK/tUSDT — already the active pair.' };
    }
    if (pair === 'USDT/WHSK') {
      return { reply: 'USDT/WHSK is no longer the traded pair — those pools are synthetic and frozen; they are read as a diagnostic only. The active pair is tWHSK/tUSDT. Target unchanged.' };
    }
    return { reply: `${pair} is not available on HSK testnet with verified pools — only tWHSK/tUSDT is supported. Target unchanged.` };
  }
  if (/^halt|pause|stop trading/.test(text)) {
    s.halted = true;
    s.haltReason = 'halted by user via chat';
    agent.stop();
    return { reply: 'Trading halted. Open positions stay open; say "resume" to restart polling.', changed: 'halted' };
  }
  if (/^resume|restart/.test(text)) {
    s.halted = false;
    s.haltReason = '';
    agent.start();
    return { reply: 'Trading resumed.', changed: 'resumed' };
  }
  return {
    reply: `I didn't understand "${raw.trim()}". Try "help", "show positions", "pnl", "status", or "set risk to low".`,
  };
}
