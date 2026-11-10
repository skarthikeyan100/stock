// Parses the indicator names a RuleBasedStrategy rule lists (e.g. RSI_5_80_20, RSI_5_80_20_REV, EMA_5_13, MACD_12_26_9,
// Bollinger_20_2, ADX_14, Stochastic_14_3 or Stoch_14_3). A name must be one the live stats builder computes (lib/indicator-config.ts);
// anything else throws, so a misspelt or unsupported indicator stops the rule instead of silently never agreeing.

import { RSI_PARAMS, MACD_PARAMS, EMA_PARAMS, BOLLINGER_PARAMS, ADX_PARAMS, STOCHASTIC_PARAMS } from '../lib/indicator-config';

export type RuleIndicator =
    | { family: 'RSI'; reversed: boolean; period: number; overbought: number; oversold: number }
    | { family: 'MACD'; shortPeriod: number; longPeriod: number; signalPeriod: number }
    | { family: 'EMA'; shortPeriod: number; longPeriod: number }
    | { family: 'Bollinger'; period: number; numDeviations: number }
    | { family: 'ADX'; period: number }
    | { family: 'Stoch'; kPeriod: number; dPeriod: number };

const NUMBER = /^\d+(\.\d+)?$/;

function numbersOf(parts: string[], from: number, to: number, name: string): number[] {
    const out: number[] = [];
    for (let i = from; i < to; i++) {
        if (!NUMBER.test(parts[i])) throw new Error(`indicator '${name}': '${parts[i]}' is not a number`);
        out.push(Number(parts[i]));
    }
    return out;
}

function notComputed(name: string, available: string): Error {
    return new Error(`indicator '${name}' is not computed by the live stats builder (available: ${available})`);
}

export function parseRuleIndicator(name: string): RuleIndicator {
    const raw = String(name ?? '').trim();
    const parts = raw.split('_');
    const head = parts[0];

    if (head === 'RSI' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'REV'))) {
        const [period, overbought, oversold] = numbersOf(parts, 1, 4, raw);
        const hit = RSI_PARAMS.find((p) => p.period === period && p.overbought === overbought && p.oversold === oversold);
        if (!hit) throw notComputed(raw, 'RSI_<period>_<overbought>_<oversold> from lib/indicator-config.ts RSI_PARAMS');
        return { family: 'RSI', reversed: parts.length === 5, period, overbought, oversold };
    }

    if (head === 'MACD' && parts.length === 4) {
        const [shortPeriod, longPeriod, signalPeriod] = numbersOf(parts, 1, 4, raw);
        if (!MACD_PARAMS.some((p) => p.shortPeriod === shortPeriod && p.longPeriod === longPeriod && p.signalPeriod === signalPeriod)) {
            throw notComputed(raw, 'MACD_<fast>_<slow>_<signal> from MACD_PARAMS');
        }
        return { family: 'MACD', shortPeriod, longPeriod, signalPeriod };
    }

    if (head === 'EMA' && parts.length === 3) {
        const [shortPeriod, longPeriod] = numbersOf(parts, 1, 3, raw);
        if (!EMA_PARAMS.some((p) => p.shortPeriod === shortPeriod && p.longPeriod === longPeriod)) {
            throw notComputed(raw, 'EMA_<short>_<long> from EMA_PARAMS');
        }
        return { family: 'EMA', shortPeriod, longPeriod };
    }

    if (head === 'Bollinger' && parts.length === 3) {
        const [period] = numbersOf(parts, 1, 2, raw);
        const numDeviations = Number(parts[2]);
        if (!NUMBER.test(parts[2])) throw new Error(`indicator '${raw}': '${parts[2]}' is not a number`);
        if (!BOLLINGER_PARAMS.some((p) => p.period === period && p.numDeviations === numDeviations)) {
            throw notComputed(raw, 'Bollinger_<period>_<deviations> from BOLLINGER_PARAMS');
        }
        return { family: 'Bollinger', period, numDeviations };
    }

    if (head === 'ADX' && parts.length === 2) {
        const [period] = numbersOf(parts, 1, 2, raw);
        if (!ADX_PARAMS.some((p) => p.period === period)) throw notComputed(raw, 'ADX_<period> from ADX_PARAMS');
        return { family: 'ADX', period };
    }

    // "Stochastic" is the name the docs and configs use; "Stoch" is accepted too.
    if ((head === 'Stochastic' || head === 'Stoch') && parts.length === 3) {
        const [kPeriod, dPeriod] = numbersOf(parts, 1, 3, raw);
        if (!STOCHASTIC_PARAMS.some((p) => p.kPeriod === kPeriod && p.dPeriod === dPeriod)) {
            throw notComputed(raw, 'Stochastic_<k>_<d> from STOCHASTIC_PARAMS');
        }
        return { family: 'Stoch', kPeriod, dPeriod };
    }

    throw new Error(`unknown indicator '${raw}' (expected RSI_p_ob_os[_REV], MACD_f_s_sig, EMA_s_l, Bollinger_p_dev, ADX_p or Stochastic_k_d)`);
}

// The trend one parsed indicator reports for a stats snapshot's `results` ('UP' | 'DOWN' | 'NEUTRAL'), or null when the snapshot has
// no value for it. Shared by RuleBasedStrategy (live) and the RuleBased backtest so both read signals the same way.
export function ruleSignal(ind: RuleIndicator, results: any): string | null {
    if (!results) return null;
    switch (ind.family) {
        case 'RSI': {
            const list = ind.reversed ? results.rsiReversed : results.rsi;
            const match = (list || []).find((x: any) =>
                x.period === ind.period && x.overbought === ind.overbought && x.oversold === ind.oversold);
            return match?.trend ?? null;
        }
        case 'MACD': {
            const match = (results.macd || []).find((x: any) =>
                x.shortPeriod === ind.shortPeriod && x.longPeriod === ind.longPeriod && x.signalPeriod === ind.signalPeriod);
            return match?.trend ?? null;
        }
        case 'EMA': {
            const match = (results.ema || []).find((x: any) => x.shortPeriod === ind.shortPeriod && x.longPeriod === ind.longPeriod);
            return match?.trend ?? null;
        }
        case 'Bollinger': {
            const match = (results.bollinger || []).find((x: any) => x.period === ind.period && x.numDeviations === ind.numDeviations);
            return match?.trend ?? null;
        }
        case 'ADX': {
            const match = (results.adx || []).find((x: any) => x.period === ind.period);
            return match?.trend ?? null;
        }
        case 'Stoch': {
            const match = (results.stochastic || []).find((x: any) => x.kPeriod === ind.kPeriod && x.dPeriod === ind.dPeriod);
            return match?.trend ?? null;
        }
    }
}

// The rule's direction from its signals: 'UP' (CALL), 'DOWN' (PUT) or null. requireAll: every signal must be UP or every one DOWN, and a
// null or NEUTRAL blocks. Majority: more than half of the signals must be UP or DOWN; null/NEUTRAL cast no vote.
export function consensusOf(signals: Array<string | null>, requireAll: boolean): 'UP' | 'DOWN' | null {
    const n = signals.length;
    if (n === 0) return null;
    const up = signals.filter((s) => s === 'UP').length;
    const down = signals.filter((s) => s === 'DOWN').length;
    if (requireAll) {
        if (signals.some((s) => s === null || s === 'NEUTRAL')) return null;
        if (up === n) return 'UP';
        if (down === n) return 'DOWN';
        return null;
    }
    if (up * 2 > n) return 'UP';
    if (down * 2 > n) return 'DOWN';
    return null;
}

// The rules of a RuleBased block. Each item of `indicators` is one RULE; commas inside an item join indicators that must agree within that
// rule (a string instead of a list is one rule). Empty names are dropped; an item with no names is dropped.
export function parseRuleLines(raw: unknown): string[][] {
    const items: unknown[] = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const rules: string[][] = [];
    for (const item of items) {
        const names = String(item).split(',').map((n) => n.trim()).filter((n) => n.length > 0);
        if (names.length > 0) rules.push(names);
    }
    return rules;
}

// Combines the directions of the block's rules: any rule UP and any rule DOWN is a conflict and gives no trade. Otherwise the one side that
// fired (UP or DOWN), or null when no rule fired.
export function combineRules(ruleDirections: Array<'UP' | 'DOWN' | null>): { direction: 'UP' | 'DOWN' | null; conflict: boolean } {
    const up = ruleDirections.includes('UP');
    const down = ruleDirections.includes('DOWN');
    if (up && down) return { direction: null, conflict: true };
    return { direction: up ? 'UP' : down ? 'DOWN' : null, conflict: false };
}
