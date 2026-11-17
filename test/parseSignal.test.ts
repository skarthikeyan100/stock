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
  it('uses the regex when it finds price, stop and target (no Claude call)', async () => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal('Nifty 23400 ce Cmp 120 target 150 sl 100', run);
    expect(r).toEqual({ signal: { action: 'buy', right: 'CE', strike: 23400, price: 120, stop: 100, target: 150 }, via: 'regex' });
    expect(calls.n).toBe(0);
  });

  it('sends the typo-ridden sample to Claude', async () => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal(SAMPLE, run);
    expect(r).toEqual({ signal: { action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, target: 68 }, via: 'claude' });
    expect(calls.n).toBe(1);
  });

  it('ignores another instrument without calling Claude', async () => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal('Banknifty 45000 CE cmp 180 target 200 sl 150', run);
    expect(r.signal).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('ignores chatter without calling Claude', async () => {
    const { run, calls } = claudeSays(sampleOut);
    expect((await parseSignal('good morning everyone', run)).signal).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('sends a regex result that lacks stop/target to Claude', async () => {
    const { run, calls } = claudeSays(sampleOut);
    await parseSignal('Nifty 23400 ce Cmp 120', run);
    expect(calls.n).toBe(1);
  });

  it('ignores exit messages without calling Claude', async () => {
    const { run, calls } = claudeSays(sampleOut);
    const r = await parseSignal('Exit Nifty 23400 ce @ 150', run);
    expect(r.signal).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/exit/);
    expect(calls.n).toBe(0);
  });

  it('turns a Claude failure into a skip reason', async () => {
    const r = await parseSignal(SAMPLE, async () => { throw new Error('timeout'); });
    expect(r.signal).toBeNull();
    expect((r as { reason: string }).reason).toMatch(/^claude failed/);
  });
});
