import { describe, expect, it } from 'vitest';
import { underlyingRow } from '../src/order/gopocket.js';

describe('underlyingRow', () => {
  it('matches the underlying and not a longer name that ends with it', () => {
    expect(underlyingRow('NIFTY 17th NOV 25400 CE NFO', 'NIFTY')).toBe(true);
    expect(underlyingRow('FINNIFTY 23rd NOV 25400 CE NFO', 'NIFTY')).toBe(false);
    expect(underlyingRow('BANKNIFTY 24th NOV 58000 CE NFO', 'NIFTY')).toBe(false);
  });
  it('matches a stock and ignores case', () => {
    expect(underlyingRow('PAYTM 24th NOV 2000 CE NFO', 'paytm')).toBe(true);
    expect(underlyingRow('PAYTM 24th NOV 2000 CE NFO', 'HAL')).toBe(false);
  });
  it('rejects a row that is not an option (no date after the name)', () => {
    expect(underlyingRow('NIFTY 50 NSE', 'NIFTY')).toBe(false);
  });
});

import { preferNfo } from '../src/order/gopocket.js';
describe('preferNfo', () => {
  const paytm = ['PAYTM 23rd NOV 2000 CE NFO', 'PAYTM 26th NOV 2000 CE BFO', 'PAYTM 29th DEC 2000 CE NFO', 'PAYTM 31st DEC 2000 CE BFO'];
  it('keeps only NFO rows when the underlying has them', () => {
    expect(preferNfo(paytm)).toEqual(['PAYTM 23rd NOV 2000 CE NFO', 'PAYTM 29th DEC 2000 CE NFO']);
  });
  it('falls back to all rows (BFO) when there is no NFO row, e.g. SENSEX', () => {
    const sensex = ['SENSEX 19th NOV 84000 CE BFO', 'SENSEX 26th NOV 84000 CE BFO'];
    expect(preferNfo(sensex)).toEqual(sensex);
  });
});
