import { describe, expect, it } from 'vitest';
import type { ClaudeRunner } from '../src/claudeParser.js';
import { parseConfig } from '../src/config.js';
import { createDeduper } from '../src/dedupe.js';
import type { BuyRequest, OrderOutcome } from '../src/order/gopocket.js';
import { handleMessage, serialize, type Broker } from '../src/pipeline.js';
import { AGAIN_REPOST, CASH_POSTS, PAYTM_CALL, PAYTM_CALL_CLAUDE } from './fixtures/channel.js';

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
    cfg: parseConfig({}),
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

  it('ignores a stock option (the real PAYTM post): no spot read, no order', async () => {
    const spotCalls = { n: 0 };
    const { deps, buys } = setup({ spotCalls, out: PAYTM_CALL_CLAUDE });
    expect((await handleMessage('m1', PAYTM_CALL, deps)).result).toBe('ignored');
    expect(spotCalls.n).toBe(0);
    expect(buys).toHaveLength(0);
  });

  it('orders a BANKNIFTY option without reading the NIFTY spot', async () => {
    const spotCalls = { n: 0 };
    const { deps, buys } = setup({ spotCalls, spot: new Error('must not be called'), out: { ...sampleOut, instrument: 'BANKNIFTY', strike: 58000 } });
    expect((await handleMessage('m1', SAMPLE, deps)).result).toBe('ordered');
    expect(spotCalls.n).toBe(0);
    expect(buys).toEqual([{ underlying: 'BANKNIFTY', right: 'CE', strike: 58000, price: 54, stopOffset: 13, targetOffset: 14 }]);
  });

  it('passes the stated expiry month to the broker and treats another month as another contract', async () => {
    const month = (expiryMonth: string) => ({ ...sampleOut, instrument: 'BANKNIFTY', expiryMonth });
    const a = setup({ out: month('NOV') });
    await handleMessage('m1', SAMPLE, a.deps);
    const b = { ...a.deps, run: (async () => JSON.stringify({ structured_output: month('DEC') })) as ClaudeRunner };
    expect((await handleMessage('m2', SAMPLE, b)).result).toBe('ordered');
    expect(a.buys.map((x) => x.expiryMonth)).toEqual(['NOV', 'DEC']);
  });

  it('treats the same strike on different underlyings as different contracts', async () => {
    const a = setup({ out: { ...sampleOut, instrument: 'BANKNIFTY' } });
    await handleMessage('m1', SAMPLE, a.deps);
    const b = { ...a.deps, run: (async () => JSON.stringify({ structured_output: { ...sampleOut, instrument: 'SENSEX' } })) as ClaudeRunner };
    expect((await handleMessage('m2', SAMPLE, b)).result).toBe('ordered');
    expect(a.buys.map((x) => x.underlying)).toEqual(['BANKNIFTY', 'SENSEX']);
  });

  it('ignores the real "Again" repost and the real cash posts before any Claude call', async () => {
    const { deps, buys } = setup();
    expect((await handleMessage('m1', AGAIN_REPOST, deps)).result).toBe('ignored');
    for (const [i, text] of CASH_POSTS.entries()) expect((await handleMessage(`c${i}`, text, deps)).result).toBe('ignored');
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

  it('reports an order the broker did not place for lack of budget as skipped', async () => {
    const { deps } = setup({ outcome: { status: 'skipped', reason: 'one lot costs 52000, over maxInvestment 50000' } });
    expect(await handleMessage('m1', SAMPLE, deps)).toEqual({ result: 'skipped', detail: 'one lot costs 52000, over maxInvestment 50000' });
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
