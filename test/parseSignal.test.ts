import { describe, expect, it } from 'vitest';
import { parseSignal } from '../src/parseSignal.js';

const SAMPLE = 'BUY NIFRY (25400.00 CE) CMP 54:)) STOPLLOSS 41:00 TARGET 68:00-80:00-100:00++(LOT SIZE 65)';
const claudeSays = (structured: unknown) => {
  const calls = { n: 0 };
  const run = async () => {
    calls.n++;
    return JSON.stringify({ structured_output: structured });
  };
  return { run, calls };
};
const sampleOut = { relevant: true, instrument: 'NIFTY', action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, targets: [68, 80, 100] };

describe('parseSignal', () => {
  it('always asks Claude, even for a clean message', async () => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal('Nifty 25400 ce Cmp 54 target 68 sl 41', run);
    expect(r).toEqual({ signal: { action: 'buy', underlying: 'NIFTY', right: 'CE', strike: 25400, price: 54, stop: 41, target: 68 }, via: 'claude' });
    expect(calls.n).toBe(1);
  });

  it('parses the typo-ridden sample', async () => {
    const { run } = claudeSays(sampleOut);
    expect((await parseSignal(SAMPLE, run)).signal?.underlying).toBe('NIFTY');
  });

  it('accepts a non-NIFTY underlying', async () => {
    const { run } = claudeSays({ relevant: true, instrument: 'PAYTM', action: 'buy', right: 'CE', strike: 2000, price: 20.5, stop: 17, targets: [22.5] });
    const r = await parseSignal('# BUY Paytm ( NOV: 2000.00 CE) at above 20.50 STOPLOSS 17.00 TARGET 22.50++', run);
    expect(r.signal).toMatchObject({ underlying: 'PAYTM', strike: 2000, price: 20.5 });
  });

  it.each([['Again RISKY JACKPOT BUY NIFTY 25800 CE'], ['( T+4) # BUY FEDERAL BANK (CASH) AT ABOVE 360'], ['buy x cash 1 CE'], ['AGAIN nifty ce 100'], ['(cash)']])('skips %s without calling Claude', async (text) => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal(text, run);
    expect(r.signal).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/again|cash/i);
    expect(calls.n).toBe(0);
  });

  it('does not skip words that merely contain "again" or "cash"', async () => {
    const { run, calls } = claudeSays(sampleOut);
    await parseSignal('Nifty 25400 CE cashew againstit 54', run);
    expect(calls.n).toBe(1);
  });

  it('turns a Claude "not relevant" into a not-a-signal reason', async () => {
    const { run } = claudeSays({ relevant: false });
    const r = await parseSignal('good morning everyone', run);
    expect(r.signal).toBeNull();
  });

  it('turns a Claude failure into a skip reason', async () => {
    const r = await parseSignal(SAMPLE, async () => { throw new Error('timeout'); });
    expect(r.signal).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/^claude failed/);
  });
});
