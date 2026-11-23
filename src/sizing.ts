// Position sizing inside hard caps. Pure function, unit-tested.
import { clamp } from './math.js';

export interface SizingInput {
  equity: number; // USDT
  signalScore: number; // 0-100
  perTradeCap: number; // fraction of equity
  dailyCap: number; // fraction of equity
  deployedToday: number; // USDT already deployed today
  riskAppetite: number; // 0-1
  minScore: number;
}

export interface SizingResult {
  sizeUsdt: number;
  blocked: boolean;
  reason: string;
}

/** Size = perTradeCap * equity * (score/100) * (0.5 + riskAppetite), capped by daily headroom. */
export function sizePosition(input: SizingInput): SizingResult {
  if (input.signalScore < input.minScore) {
    return { sizeUsdt: 0, blocked: true, reason: `score ${input.signalScore} below threshold ${input.minScore}` };
  }
  const dailyHeadroom = input.dailyCap * input.equity - input.deployedToday;
  if (dailyHeadroom <= 0) {
    return { sizeUsdt: 0, blocked: true, reason: `daily cap reached (deployed ${input.deployedToday.toFixed(2)} of ${(input.dailyCap * input.equity).toFixed(2)} USDT)` };
  }
  const base = input.perTradeCap * input.equity;
  const scoreScale = input.signalScore / 100;
  const appetiteScale = 0.5 + clamp(input.riskAppetite, 0, 1);
  const size = Math.min(base * scoreScale * appetiteScale, dailyHeadroom);
  if (size <= 0) return { sizeUsdt: 0, blocked: true, reason: 'computed size is zero' };
  return {
    sizeUsdt: Math.round(size * 100) / 100,
    blocked: false,
    reason: `size ${size.toFixed(2)} USDT = cap ${(base).toFixed(2)} x score ${scoreScale.toFixed(2)} x appetite ${appetiteScale.toFixed(2)}, daily headroom ${dailyHeadroom.toFixed(2)}`,
  };
}
