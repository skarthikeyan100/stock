import { describe, expect, it } from 'vitest';
import type { ClaudeRunner } from '../src/claudeParser.js';
import { parseConfig } from '../src/config.js';
import { createDeduper } from '../src/dedupe.js';
import type { BuyRequest, OrderOutcome } from '../src/order/gopocket.js';
import { handleMessage, serialize, type Broker } from '../src/pipeline.js';

const SAMPLE = 'BUY NIFRY (25400.00 CE) CMP 54:)) STOPLLOSS 41:00 TARGET 68:00-80:00-100:00++(LOT SIZE 65)';
const sampleOut = { relevant: true, instrument: 'NIFTY', action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, targets: [68, 80, 100] };

function setup(over: { spot?: number | Error; outcome?: OrderOutcome; investment?: number } = {}) {
  const buys: BuyRequest[] = [];
  const logs: string[] = [];
  const broker: Broker = {
    readSpot: async () => {
      if (over.spot instanceof Error) throw over.spot;
      return over.spot ?? 25387;
    },
    buy: async (req) => {
      buys.push(req);
      return over.outcome ?? { status: 'placed', orderNo: '1', symbol: 'NIFTY23NOV26C25400' };
    },
  };
  const run: ClaudeRunner = async () => JSON.stringify({ structured_output: sampleOut });
  const deps = {
    cfg: parseConfig({ allowedSenders: ['x'], investment: over.investment ?? 100000, lotSize: 65 }),
    run,
    broker,
    deduper: createDeduper(300_000, () => 0),
    today: () => '2026-11-17',
    log: (m: string) => void logs.push(m),
  };
  return { deps, buys, logs };
}

describe('handleMessage', () => {
  it('orders the sample: 28 lots at 54 with stop 13 and target 14', async () => {
    const { deps, buys } = setup();
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('ordered');
    expect(buys).toEqual([{ right: 'CE', strike: 25400, price: 54, lots: 28, stopOffset: 13, targetOffset: 14 }]);
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

  it('skips when one lot costs more than the investment', async () => {
    const { deps, buys } = setup({ investment: 3000 });
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('skipped');
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
    const { deps, buys } = setup();
    expect((await handleMessage('m1', 'Exit Nifty 25400 ce @ 70', deps)).result).toBe('ignored');
    expect(buys).toHaveLength(0);
  });

  it('ignores chatter', async () => {
    const { deps } = setup();
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
