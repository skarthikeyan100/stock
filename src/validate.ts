import type { Config, Signal } from './types.js';

export type Validation = { ok: true } | { ok: false; reason: string };

export function validateSignal(s: Signal, ctx: { spot: number; today: string }, cfg: Config): Validation {
  if (!Number.isFinite(ctx.spot) || ctx.spot <= 0) return { ok: false, reason: `invalid spot ${ctx.spot}: NIFTY level not read` };
  const away = (Math.abs(s.strike - ctx.spot) / ctx.spot) * 100;
  if (away > cfg.strikeBandPercent) return { ok: false, reason: `strike ${s.strike} is ${away.toFixed(1)}% from spot ${ctx.spot} (limit ${cfg.strikeBandPercent}%)` };
  if (s.price < cfg.priceMin || s.price > cfg.priceMax) return { ok: false, reason: `price ${s.price} outside ${cfg.priceMin}-${cfg.priceMax}` };
  if (s.stop !== undefined && s.stop >= s.price) return { ok: false, reason: `stop ${s.stop} is not below price ${s.price}` };
  if (s.target !== undefined && s.target <= s.price) return { ok: false, reason: `target ${s.target} is not above price ${s.price}` };
  if (s.expiry !== undefined && s.expiry < ctx.today) return { ok: false, reason: `expiry ${s.expiry} is in the past` };
  return { ok: true };
}
