import { describe, expect, it } from 'vitest';
import { orderQty, resolveBracket, roundTick } from '../src/bracket.js';
import { parseConfig } from '../src/config.js';
import type { Signal } from '../src/types.js';

const cfg = (extra: object = {}) => parseConfig(extra);
const sig = (s: Partial<Signal>): Signal => ({ action: 'buy', underlying: 'NIFTY', right: 'CE', strike: 25400, price: 54, ...s });

describe('roundTick', () => {
  it('rounds to the nearest 0.05', () => {
    expect(roundTick(20.67)).toBe(20.65);
    expect(roundTick(5.4)).toBe(5.4);
  });
});

describe('resolveBracket', () => {
  it('uses message stop and target as differences from the price', () => {
    expect(resolveBracket(sig({ stop: 41, target: 68 }), cfg())).toEqual({ stopOffset: 13, targetOffset: 14 });
  });
  it('tick-rounds the differences', () => {
    expect(resolveBracket(sig({ price: 171, stop: 150.33, target: 190 }), cfg())).toEqual({ stopOffset: 20.65, targetOffset: 19 });
  });
  it('falls back to configured percent of price for a missing stop', () => {
    expect(resolveBracket(sig({ target: 68 }), cfg({ stop: { percent: 10 } })).stopOffset).toBe(5.4);
  });
  it('percent wins over points when both are configured', () => {
    expect(resolveBracket(sig({ target: 68 }), cfg({ stop: { points: 8, percent: 10 } })).stopOffset).toBe(5.4);
  });
  it('uses points when only points are configured', () => {
    expect(resolveBracket(sig({ stop: 41 }), cfg({ target: { points: 12 } })).targetOffset).toBe(12);
  });
  it('throws when stop is missing and not configured', () => {
    expect(() => resolveBracket(sig({ target: 68 }), cfg())).toThrow(/stop/);
  });
  it('throws when target is missing and not configured', () => {
    expect(() => resolveBracket(sig({ stop: 41 }), cfg())).toThrow(/target/);
  });
});

describe('orderQty', () => {
  it.each([
    [54, 65, 910], // 14 lots = 49140; 15 lots would be 52650
    [250, 20, 200], // 10 lots = exactly 50000
    [769.2, 65, 65], // one lot = 49998
  ])('at %d with lot %d buys %d', (price, lot, qty) => expect(orderQty(50000, price, lot)).toBe(qty));
  it('is 0 when one lot costs more than the limit', () => expect(orderQty(50000, 800, 65)).toBe(0));
});
