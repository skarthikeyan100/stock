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
    expect(cfg.headless).toBe(true);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.profileDir).toBe('browser-profile');
  });

  it('no longer needs investment or lotSize', () => {
    const cfg = parseConfig(base) as unknown as Record<string, unknown>;
    expect(cfg.investment).toBeUndefined();
    expect(cfg.lotSize).toBeUndefined();
  });

  it('accepts stop with both percent and points', () => {
    const cfg = parseConfig({ ...base, stop: { percent: 10, points: 5 } });
    expect(cfg.stop).toEqual({ percent: 10, points: 5 });
  });
});
