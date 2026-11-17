import { describe, expect, it } from 'vitest';
import { parseSignal } from '../src/parseSignal.js';

import { AGAIN_REPOST, APOLLO_UPDATE, CASH_POSTS, HAL_CALL, HAL_CALL_CLAUDE, NIFTY_CALL, NIFTY_CALL_CLAUDE, PAYTM_BOOK_UPDATE, PAYTM_BOOK_UPDATE_CLAUDE, PAYTM_CALL, PAYTM_CALL_CLAUDE } from './fixtures/channel.js';

// The user's own typo-ridden sample (also a real message): "NIFRY", "STOPLLOSS", ":" for "."
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

describe('parseSignal on real channel posts', () => {
  it('parses the NIFTY call through Claude', async () => {
    const { run, calls } = claudeSays(NIFTY_CALL_CLAUDE);
    expect(await parseSignal(NIFTY_CALL, run)).toEqual({ signal: { action: 'buy', underlying: 'NIFTY', right: 'CE', strike: 25800, price: 79, stop: 61, target: 100 }, via: 'claude' });
    expect(calls.n).toBe(1);
  });
  it('parses the PAYTM call (a stock option)', async () => {
    const { run } = claudeSays(PAYTM_CALL_CLAUDE);
    expect((await parseSignal(PAYTM_CALL, run)).signal).toEqual({ action: 'buy', underlying: 'PAYTM', right: 'CE', strike: 2000, price: 20.5, stop: 17, target: 22.5, expiryMonth: 'NOV' });
  });
  it('parses the HAL call (a stock option)', async () => {
    const { run } = claudeSays(HAL_CALL_CLAUDE);
    expect((await parseSignal(HAL_CALL, run)).signal).toMatchObject({ underlying: 'HAL', strike: 5400, price: 13.5, stop: 6, target: 18, expiryMonth: 'NOV' });
  });
  it('parses the typo-ridden sample', async () => {
    const { run } = claudeSays(sampleOut);
    expect((await parseSignal(SAMPLE, run)).signal).toMatchObject({ underlying: 'NIFTY', strike: 25400, price: 54, stop: 41, target: 68 });
  });
  it('sends a profit-booking update to Claude, which calls it an exit', async () => {
    const { run, calls } = claudeSays(PAYTM_BOOK_UPDATE_CLAUDE);
    const r = await parseSignal(PAYTM_BOOK_UPDATE, run);
    expect(r.signal).toBeNull();
    expect(calls.n).toBe(1);
  });
  it('skips the "Again" repost without calling Claude', async () => {
    const { run, calls } = claudeSays(NIFTY_CALL_CLAUDE);
    const r = await parseSignal(AGAIN_REPOST, run);
    expect((r as { reason: string }).reason).toMatch(/again/i);
    expect(calls.n).toBe(0);
  });
  it.each(CASH_POSTS.map((t) => [t.slice(0, 60), t]))('skips the cash post "%s" without calling Claude', async (_name, text) => {
    const { run, calls } = claudeSays(NIFTY_CALL_CLAUDE);
    const r = await parseSignal(text, run);
    expect((r as { reason: string }).reason).toMatch(/cash/i);
    expect(calls.n).toBe(0);
  });
  it('skips the APOLLO update (no CE or PE) without calling Claude', async () => {
    const { run, calls } = claudeSays(NIFTY_CALL_CLAUDE);
    const r = await parseSignal(APOLLO_UPDATE, run);
    expect((r as { reason: string }).reason).toMatch(/CE or PE/);
    expect(calls.n).toBe(0);
  });
  it('turns a Claude failure into a skip reason', async () => {
    const r = await parseSignal(NIFTY_CALL, async () => { throw new Error('timeout'); });
    expect((r as { reason: string }).reason).toMatch(/^claude failed/);
  });
});

// Edge cases of the word rules. These are synthetic: no real post has them.
describe('word rules', () => {
  it('does not treat "cashew" or "againstit" as the skip words', async () => {
    const { run, calls } = claudeSays(sampleOut);
    await parseSignal('Nifty 25400 CE cashew againstit 54', run);
    expect(calls.n).toBe(1);
  });
  it.each([['BUY NIFTY 25400PE 54'], ['BUY NIFTY 25400 ce 54']])('counts CE/PE in "%s"', async (text) => {
    const { run, calls } = claudeSays(sampleOut);
    await parseSignal(text, run);
    expect(calls.n).toBe(1);
  });
  it('does not count "PRICE" or "PEAK" as CE/PE', async () => {
    const { run, calls } = claudeSays(sampleOut);
    await parseSignal('the PRICE is a PEAK', run);
    expect(calls.n).toBe(0);
  });
});
