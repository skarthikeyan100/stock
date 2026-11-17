import type { Config, Signal } from './types.js';

export type Validation = { ok: true } | { ok: false; reason: string };

/**
 * NIFTY calls are checked against the live NIFTY level and the price range. Other underlyings have no spot
 * to compare with (owner's rule: use the message price as given), so only the structural checks apply.
 */
export function validateSignal(s: Signal, ctx: { spot?: number; today: string }, cfg: Config): Validation {
  if (s.underlying === 'NIFTY') {
    const spot = ctx.spot ?? 0;
    if (!Number.isFinite(spot) || spot <= 0) return { ok: false, reason: `invalid spot ${ctx.spot}: NIFTY level not read` };
    const away = (Math.abs(s.strike - spot) / spot) * 100;
    if (away > cfg.strikeBandPercent) return { ok: false, reason: `strike ${s.strike} is ${away.toFixed(1)}% from spot ${spot} (limit ${cfg.strikeBandPercent}%)` };
    if (s.price < cfg.priceMin || s.price > cfg.priceMax) return { ok: false, reason: `price ${s.price} outside ${cfg.priceMin}-${cfg.priceMax}` };
  }
  if (s.stop !== undefined && s.stop >= s.price) return { ok: false, reason: `stop ${s.stop} is not below price ${s.price}` };
  if (s.target !== undefined && s.target <= s.price) return { ok: false, reason: `target ${s.target} is not above price ${s.price}` };
  if (s.expiry !== undefined && s.expiry < ctx.today) return { ok: false, reason: `expiry ${s.expiry} is in the past` };
  return { ok: true };
}
