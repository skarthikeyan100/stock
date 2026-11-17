import type { Config, OffsetRule, Signal } from './types.js';

const TICK = 0.05;

export function roundTick(x: number): number {
  return Number((Math.round(x / TICK) * TICK).toFixed(2));
}

function fromRule(rule: OffsetRule | undefined, price: number, name: string): number {
  if (rule?.percent !== undefined) return roundTick((price * rule.percent) / 100);
  if (rule?.points !== undefined) return roundTick(rule.points);
  throw new Error(`no ${name} in the message and none configured`);
}

export function resolveBracket(signal: Signal, cfg: Config): { stopOffset: number; targetOffset: number } {
  const stopOffset = signal.stop !== undefined ? roundTick(signal.price - signal.stop) : fromRule(cfg.stop, signal.price, 'stop');
  const targetOffset = signal.target !== undefined ? roundTick(signal.target - signal.price) : fromRule(cfg.target, signal.price, 'target');
  return { stopOffset, targetOffset };
}
