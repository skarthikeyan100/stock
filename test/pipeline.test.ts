import { describe, expect, it } from 'vitest';
import type { ClaudeRunner } from '../src/claudeParser.js';
import { parseConfig } from '../src/config.js';
import { createDeduper } from '../src/dedupe.js';
import type { BuyRequest, OrderOutcome } from '../src/order/gopocket.js';
import { handleMessage, serialize, type Broker } from '../src/pipeline.js';

const SAMPLE = 'BUY NIFRY (25400.00 CE) CMP 54:)) STOPLLOSS 41:00 TARGET 68:00-80:00-100:00++(LOT SIZE 65)';
const sampleOut = { relevant: true, instrument: 'NIFTY', action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, targets: [68, 80, 100] };

function setup(over: { spot?: number | Error; outcome?: OrderOutcome; out?: Record<string, unknown>; spotCalls?: { n: number } } = {}) {
  const buys: BuyRequest[] = [];
  const logs: string[] = [];
  const broker: Broker = {
    readSpot: async () => {
      if (over.spotCalls) over.spotCalls.n++;
      if (over.spot instanceof Error) throw over.spot;
      return over.spot ?? 25387;
    },
    buy: async (req) => {
      buys.push(req);
      return over.outcome ?? { status: 'placed', orderNo: '1', symbol: 'NIFTY23NOV26C25400' };
    },
  };
  const run: ClaudeRunner = async () => JSON.stringify({ structured_output: over.out ?? sampleOut });
  const deps = {
    cfg: parseConfig({ allowedSenders: ['x'] }),
    run,
    broker,
    deduper: createDeduper(300_000, () => 0),
    today: () => '2026-11-17',
    log: (m: string) => void logs.push(m),
  };
  return { deps, buys, logs };
}

describe('handleMessage', () => {
  it('orders the sample as one lot at 54 with stop 13 and target 14', async () => {
    const { deps, buys } = setup();
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('ordered');
    expect(buys).toEqual([{ underlying: 'NIFTY', right: 'CE', strike: 25400, price: 54, stopOffset: 13, targetOffset: 14 }]);
  });

  it('does not order the same message id twice', async () => {
    const { deps, buys } = setup();
    await handleMessage('m1', SAMPLE, deps);
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('duplicate');
    expect(buys).toHaveLength(1);
  });

  it('does not order the same contract again in a new message within the window', async () => {
    const { deps, buys } = setup();
    await handleMessage('m1', SAMPLE, deps);
    expect((await handleMessage('m2', SAMPLE, deps)).result).toBe('duplicate');
    expect(buys).toHaveLength(1);
  });

  it('skips when the strike is far from the spot', async () => {
    const { deps, buys } = setup({ spot: 20000 });
    const r = await handleMessage('m1', SAMPLE, deps);
    expect(r.result).toBe('skipped');
    expect(r.detail).toMatch(/strike/);
    expect(buys).toHaveLength(0);
  });

  it('orders a stock option without reading the NIFTY spot', async () => {
    const spotCalls = { n: 0 };
    const { deps, buys } = setup({
      spotCalls,
      spot: new Error('must not be called'),
      out: { relevant: true, instrument: 'PAYTM', action: 'buy', right: 'CE', strike: 2000, price: 20.5, stop: 17, targets: [22.5] },
    });
    expect((await handleMessage('m1', 'BUY PAYTM 2000 CE at 20.50 SL 17 T 22.5', deps)).result).toBe('ordered');
    expect(spotCalls.n).toBe(0);
    expect(buys).toEqual([{ underlying: 'PAYTM', right: 'CE', strike: 2000, price: 20.5, stopOffset: 3.5, targetOffset: 2 }]);
  });

  it('treats the same strike on different underlyings as different contracts', async () => {
    const mk = (u: string) => ({ relevant: true, instrument: u, action: 'buy', right: 'CE', strike: 2000, price: 20, stop: 15, targets: [25] });
    const a = setup({ out: mk('PAYTM'), spot: 2000 });
    await handleMessage('m1', 'BUY PAYTM 2000 CE', a.deps);
    const b = { ...a.deps, run: (async () => JSON.stringify({ structured_output: mk('HAL') })) as ClaudeRunner };
    expect((await handleMessage('m2', 'BUY HAL 2000 CE', b)).result).toBe('ordered');
    expect(a.buys.map((x) => x.underlying)).toEqual(['PAYTM', 'HAL']);
  });

  it('ignores a message with "Again" or "cash" before any Claude call', async () => {
    const { deps, buys } = setup();
    expect((await handleMessage('m1', 'Again ' + SAMPLE, deps)).result).toBe('ignored');
    expect((await handleMessage('m2', 'FEDERAL BANK (CASH) 360', deps)).result).toBe('ignored');
    expect(buys).toHaveLength(0);
  });

  it('skips when the spot cannot be read (fail closed)', async () => {
    const { deps, buys } = setup({ spot: new Error('no spot') });
    const r = await handleMessage('m1', SAMPLE, deps);
    expect(r.result).toBe('skipped');
    expect(r.detail).toMatch(/spot/);
    expect(buys).toHaveLength(0);
  });

  it('reports a rejected order with the site reason', async () => {
    const { deps } = setup({ outcome: { status: 'rejected', orderNo: '9', reason: "RED:'BO' Orders are disallowed after system square off" } });
    const r = await handleMessage('m1', SAMPLE, deps);
    expect(r.result).toBe('failed');
    expect(r.detail).toMatch(/square off/);
  });

  it('reports an unconfirmed order as unknown, not placed', async () => {
    const { deps } = setup({ outcome: { status: 'unknown', reason: 'no confirmation' } });
    const r = await handleMessage('m1', SAMPLE, deps);
    expect(r.result).toBe('failed');
    expect(r.detail).toMatch(/unknown/);
  });

  it('treats a dry run as skipped', async () => {
    const { deps } = setup({ outcome: { status: 'unknown', reason: 'dry run' } });
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('skipped');
  });

  it('ignores an exit message', async () => {
    const { deps, buys } = setup({ out: { relevant: true, instrument: 'NIFTY', action: 'exit', right: 'CE', strike: 25400, price: 70 } });
    expect((await handleMessage('m1', 'Exit Nifty 25400 ce @ 70', deps)).result).toBe('ignored');
    expect(buys).toHaveLength(0);
  });

  it('ignores chatter', async () => {
    const { deps } = setup();
    deps.run = (async () => JSON.stringify({ structured_output: { relevant: false } })) as ClaudeRunner;
    expect((await handleMessage('m1', 'good morning', deps)).result).toBe('ignored');
  });
});

describe('serialize', () => {
  it('never runs two jobs at once', async () => {
    let active = 0;
    let peak = 0;
    const job = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    };
    await Promise.all([serialize(job), serialize(job), serialize(job)]);
    expect(peak).toBe(1);
  });
});
