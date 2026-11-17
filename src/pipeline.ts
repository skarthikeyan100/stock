import { resolveBracket } from './bracket.js';
import type { ClaudeRunner } from './claudeParser.js';
import type { createDeduper } from './dedupe.js';
import type { BuyRequest, OrderOutcome } from './order/gopocket.js';
import { parseSignal } from './parseSignal.js';
import type { Config } from './types.js';
import { validateSignal } from './validate.js';

export interface Broker {
  readSpot(): Promise<number>;
  buy(req: BuyRequest): Promise<OrderOutcome>;
}

export interface PipelineDeps {
  cfg: Config;
  run: ClaudeRunner;
  broker: Broker;
  deduper: ReturnType<typeof createDeduper>;
  today: () => string;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

export interface HandleResult {
  result: 'ignored' | 'duplicate' | 'skipped' | 'ordered' | 'failed';
  detail?: string;
}

let chain: Promise<unknown> = Promise.resolve();

/** Runs jobs one at a time so two messages never drive the page together. */
export function serialize<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => undefined);
  return next;
}

export async function handleMessage(messageId: string, text: string, deps: PipelineDeps): Promise<HandleResult> {
  const { cfg, broker, log } = deps;
  const done = (r: HandleResult): HandleResult => {
    log(`${r.result}${r.detail ? `: ${r.detail}` : ''}`, { messageId });
    return r;
  };

  if (deps.deduper.isDuplicate(`msg:${messageId}`)) return done({ result: 'duplicate', detail: 'message already handled' });

  const parsed = await parseSignal(text, deps.run);
  if (!parsed.signal) {
    return done({ result: parsed.reason.startsWith('claude failed') ? 'skipped' : 'ignored', detail: parsed.reason });
  }
  const { signal } = parsed;
  log('parsed signal', { via: parsed.via, signal });

  let spot: number | undefined;
  if (signal.underlying === 'NIFTY') {
    try {
      spot = await broker.readSpot();
    } catch (error) {
      return done({ result: 'skipped', detail: `could not read spot: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  const check = validateSignal(signal, { spot, today: deps.today() }, cfg);
  if (!check.ok) return done({ result: 'skipped', detail: check.reason });

  let bracket: { stopOffset: number; targetOffset: number };
  try {
    bracket = resolveBracket(signal, cfg);
  } catch (error) {
    return done({ result: 'skipped', detail: error instanceof Error ? error.message : String(error) });
  }

  if (deps.deduper.isDuplicate(`buy:${signal.underlying}:${signal.right}:${signal.strike}:${signal.expiry ?? signal.expiryMonth ?? ''}`)) {
    return done({ result: 'duplicate', detail: `${signal.strike} ${signal.right} was already ordered recently` });
  }

  const req: BuyRequest = {
    underlying: signal.underlying,
    right: signal.right,
    strike: signal.strike,
    ...(signal.expiry ? { expiry: signal.expiry } : {}),
    ...(signal.expiryMonth ? { expiryMonth: signal.expiryMonth } : {}),
    price: signal.price,
    stopOffset: bracket.stopOffset,
    targetOffset: bracket.targetOffset,
  };
  log('placing bracket buy', { ...req });

  let outcome: OrderOutcome;
  try {
    outcome = await broker.buy(req);
  } catch (error) {
    return done({ result: 'failed', detail: `unknown: order call threw (${error instanceof Error ? error.message : String(error)}); check the website` });
  }

  if (outcome.status === 'placed') return done({ result: 'ordered', detail: `${outcome.symbol ?? ''} order ${outcome.orderNo ?? '?'}`.trim() });
  if (outcome.status === 'rejected') return done({ result: 'failed', detail: `rejected: ${outcome.reason ?? 'no reason shown'} (order ${outcome.orderNo ?? '?'})` });
  if (outcome.reason === 'dry run') return done({ result: 'skipped', detail: 'dry run: form filled and checked, Buy not clicked' });
  return done({ result: 'failed', detail: `unknown outcome: ${outcome.reason ?? 'not confirmed'}; check the website` });
}
