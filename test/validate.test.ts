import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { validateSignal } from '../src/validate.js';
import type { Signal } from '../src/types.js';

const cfg = parseConfig({ allowedSenders: ['x'] });
const ctx = { spot: 25387, today: '2026-11-17' };
const good: Signal = { action: 'buy', underlying: 'NIFTY', right: 'CE', strike: 25400, price: 54, stop: 41, target: 68 };
const reason = (s: Partial<Signal>) => {
  const r = validateSignal({ ...good, ...s }, ctx, cfg);
  return r.ok ? 'ok' : r.reason;
};

describe('validateSignal', () => {
  it('accepts a sane signal', () => expect(reason({})).toBe('ok'));
  it('rejects a strike far from spot', () => expect(reason({ strike: 2540 })).toMatch(/strike/));
  it('rejects an unreadable spot (0) with a spot reason', () => expect(validateSignal({ action: 'buy', underlying: 'NIFTY', right: 'CE', strike: 25400, price: 54 }, { spot: 0, today: '2026-11-17' }, cfg)).toMatchObject({ ok: false, reason: expect.stringMatching(/invalid spot/) }));
  it('rejects an implausible price', () => expect(reason({ price: 5400 })).toMatch(/price/));
  it('rejects a stop at or above the entry', () => expect(reason({ stop: 60 })).toMatch(/stop/));
  it('rejects a target at or below the entry', () => expect(reason({ target: 50 })).toMatch(/target/));
  it('rejects a past expiry', () => expect(reason({ expiry: '2026-11-10' })).toMatch(/expiry/));
  it('accepts today as expiry', () => expect(reason({ expiry: '2026-11-17' })).toBe('ok'));
  const stock = (s: Partial<Signal>): string => {
    const r = validateSignal({ ...good, underlying: 'PAYTM', strike: 2000, price: 20.5, stop: 17, target: 22.5, ...s }, { today: '2026-11-17' }, cfg);
    return r.ok ? 'ok' : r.reason;
  };
  it('accepts a stock option with no spot, whatever the strike or price', () => {
    expect(stock({})).toBe('ok');
    expect(stock({ price: 5400, stop: 5000, target: 5800 })).toBe('ok');
  });
  it('still checks stop, target and expiry for a stock option', () => {
    expect(stock({ stop: 25 })).toMatch(/stop/);
    expect(stock({ target: 20 })).toMatch(/target/);
    expect(stock({ expiry: '2026-11-10' })).toMatch(/expiry/);
  });
});
