import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = {};

describe('parseConfig', () => {
  it('fills the documented defaults', () => {
    const cfg = parseConfig(base);
    expect(cfg.strikeBandPercent).toBe(10);
    expect(cfg.priceMin).toBe(1);
    expect(cfg.priceMax).toBe(1500);
    expect(cfg.dedupeWindowSeconds).toBe(300);
    expect(cfg.port).toBe(3101);
    expect(cfg.profileDir).toBe('browser-profile');
    expect(cfg.maxInvestment).toBe(50000);
  });

  it('no longer needs investment or lotSize', () => {
    const cfg = parseConfig(base) as unknown as Record<string, unknown>;
    expect(cfg.investment).toBeUndefined();
    expect(cfg.lotSize).toBeUndefined();
  });

  it('reads maxInvestment and rejects a non-positive one', () => {
    expect(parseConfig({ maxInvestment: 25000 }).maxInvestment).toBe(25000);
    expect(() => parseConfig({ maxInvestment: 0 })).toThrow(/maxInvestment/);
  });

  it('accepts stop with both percent and points', () => {
    const cfg = parseConfig({ ...base, stop: { percent: 10, points: 5 } });
    expect(cfg.stop).toEqual({ percent: 10, points: 5 });
  });
});
