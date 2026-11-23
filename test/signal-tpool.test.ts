import { describe, expect, it } from 'vitest';
import { scoreTPoolSignal } from '../src/signal.js';

// Live t-pool values 2026-11-23: spot = 24h TWAP = 7d TWAP = 0.0868845 (frozen),
// Supra 0.08426 stale, no swaps in the last hour.
const FROZEN = { price: 0.0868845, twap24h: 0.0868845, twap7d: 0.0868845, volumeTrend: 1 };

describe('scoreTPoolSignal', () => {
  it('frozen pool scores 0: TWAP == spot, no volume, no fresh Supra', () => {
    const s = scoreTPoolSignal({ ...FROZEN, supraStatus: 'stale', supraPrice: 0.08426, oldSpreadBps: 3633 });
    expect(s.score).toBe(0);
    expect(s.direction).toBe('none');
    expect(s.components).toEqual({ supra: 0, twap: 0, volume: 0 });
    expect(s.spreadDiagnosticBps).toBe(3633);
  });
  it('old-pool spread is diagnostic only: same inputs, different spread -> same score', () => {
    const a = scoreTPoolSignal({ ...FROZEN, oldSpreadBps: 3633 });
    const b = scoreTPoolSignal({ ...FROZEN, oldSpreadBps: 0 });
    const c = scoreTPoolSignal({ ...FROZEN, oldSpreadBps: null });
    expect(a.score).toBe(b.score);
    expect(a.score).toBe(c.score);
    expect(a.reasons.join(' ')).toMatch(/DIAGNOSTIC ONLY/);
  });
  it('price 10% below the 24h TWAP scores the full 45 TWAP points', () => {
    const s = scoreTPoolSignal({ price: 0.0782, twap24h: 0.0869, twap7d: 0.0869, volumeTrend: 1 });
    expect(s.components.twap).toBe(45);
    expect(s.direction).toBe('buy-whsk');
  });
  it('price above the 24h TWAP subtracts TWAP points (signed, like v1) and direction none', () => {
    const s = scoreTPoolSignal({ price: 0.095, twap24h: 0.0869, twap7d: 0.0869, volumeTrend: 1 });
    expect(s.components.twap).toBe(-42); // +932 bps deviation -> -932/1000 * 45
    expect(s.direction).toBe('none');
  });
  it('fresh Supra below the pool adds points; above subtracts; stale scores 0', () => {
    // Pool 0.080 vs oracle 0.08426: -506 bps -> +~15 pts.
    const below = scoreTPoolSignal({ price: 0.08, twap24h: 0.084, twap7d: 0.084, volumeTrend: 1, supraPrice: 0.08426, supraStatus: 'fresh' });
    expect(below.components.supra).toBeGreaterThan(0);
    // Pool 0.095 vs oracle 0.08426: +1274 bps -> -30 (clamped).
    const above = scoreTPoolSignal({ price: 0.095, twap24h: 0.084, twap7d: 0.084, volumeTrend: 1, supraPrice: 0.08426, supraStatus: 'fresh' });
    expect(above.components.supra).toBe(-30);
    const stale = scoreTPoolSignal({ price: 0.08, twap24h: 0.084, twap7d: 0.084, volumeTrend: 1, supraPrice: 0.08426, supraStatus: 'stale' });
    expect(stale.components.supra).toBe(0);
    expect(stale.supraDeviationBps).toBeNull();
  });
  it('volume trend 2x scores the full 25 volume points', () => {
    const s = scoreTPoolSignal({ price: 0.0869, twap24h: 0.0869, twap7d: 0.0869, volumeTrend: 2 });
    expect(s.components.volume).toBe(25);
  });
  it('no single component can reach threshold 60 (supra 30 / twap 45 / volume 25)', () => {
    const twapOnly = scoreTPoolSignal({ price: 0.07, twap24h: 0.0869, twap7d: 0.0869, volumeTrend: 1 });
    expect(twapOnly.score).toBe(45);
    const volOnly = scoreTPoolSignal({ ...FROZEN, volumeTrend: 5 });
    expect(volOnly.score).toBe(25);
  });
  it('missing TWAP scores 0 on that component and does not crash', () => {
    const s = scoreTPoolSignal({ price: 0.0869, twap24h: 0, twap7d: 0, volumeTrend: 1 });
    expect(s.components.twap).toBe(0);
    expect(s.twapDeviationBps).toBe(0);
  });
});
