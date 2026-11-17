import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = { allowedSenders: ['x'], investment: 100000, lotSize: 65 };

describe('parseConfig', () => {
  it('fills the documented defaults', () => {
    const cfg = parseConfig(base);
    expect(cfg.strikeBandPercent).toBe(10);
    expect(cfg.priceMin).toBe(1);
    expect(cfg.priceMax).toBe(1500);
    expect(cfg.dedupeWindowSeconds).toBe(300);
    expect(cfg.port).toBe(3101);
    expect(cfg.headless).toBe(true);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.profileDir).toBe('browser-profile');
  });

  it('rejects a non-positive investment, naming the field', () => {
    expect(() => parseConfig({ ...base, investment: 0 })).toThrow(/investment/);
  });

  it('rejects a missing lotSize, naming the field', () => {
    expect(() => parseConfig({ allowedSenders: ['x'], investment: 1 })).toThrow(/lotSize/);
  });

  it('accepts stop with both percent and points', () => {
    const cfg = parseConfig({ ...base, stop: { percent: 10, points: 5 } });
    expect(cfg.stop).toEqual({ percent: 10, points: 5 });
  });
});
