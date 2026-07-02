import { describe, it, expect } from 'vitest';
import { roundHalfUp } from '../src/lib/money.js';

describe('roundHalfUp', () => {
  it('exact division — no rounding needed', () => {
    expect(roundHalfUp(150n, 1000n)).toBe(150n); // 1 L at 150 h/L
    expect(roundHalfUp(150n, 120_000n)).toBe(18_000n); // 120 L
  });

  it('rounds down when remainder < 500', () => {
    // 150 * 1499 / 1000 = 224.850 → 225 (rounds up because 850 >= 500)
    expect(roundHalfUp(150n, 1499n)).toBe(225n);
    // 150 * 1001 / 1000 = 150.150 → 150 (150 < 500)
    expect(roundHalfUp(150n, 1001n)).toBe(150n);
  });

  it('rounds up when remainder >= 500', () => {
    // 150 * 1005 / 1000 = 150.750 → 151
    expect(roundHalfUp(150n, 1005n)).toBe(151n);
    // 1 * 500 / 1000 = 0.500 → rounds up to 1 (half-up)
    expect(roundHalfUp(1n, 500n)).toBe(1n);
  });

  it('boundary: remainder 499 rounds down', () => {
    // 1 * 499 / 1000 → quotient=0, remainder=499 < 500 → 0
    expect(roundHalfUp(1n, 499n)).toBe(0n);
  });

  it('boundary: remainder 500 rounds up', () => {
    expect(roundHalfUp(1n, 500n)).toBe(1n);
  });

  it('boundary: remainder 501 rounds up', () => {
    expect(roundHalfUp(1n, 501n)).toBe(1n);
  });

  it('zero millilitres → zero', () => {
    expect(roundHalfUp(150n, 0n)).toBe(0n);
  });

  it('reserved never exceeds available when computed from floor formula', () => {
    // Prove: floor(available * 1000 / price) used as ml → reserved ≤ available
    const cases: [bigint, bigint][] = [
      [1000n, 300n],
      [999n, 300n],
      [501n, 300n],
      [500n, 300n],
      [50_000n, 150n],
      [1n, 125n],
    ];
    for (const [available, price] of cases) {
      const ml = (available * 1000n) / price; // BigInt floor division
      const reserved = roundHalfUp(price, ml);
      expect(reserved).toBeLessThanOrEqual(available);
    }
  });
});
