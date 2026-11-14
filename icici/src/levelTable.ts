/**
 * THE one source of the Beginner / Advanced comparison table: the welcome and upgrade emails, GET /level-rules (the public rules page and the in-app
 * rules page) all render these rows. Every number comes from config.yml (settings.levelRules, settings.targetPoints / stopLossPoints) through levelRules().
 */
import { levelRules } from './levelRules';
import { escapeHtml } from './mailer';

export interface LevelTableRow { label: string; beginner: string; advanced: string }

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pctOf = (percent: number, capital: number) => `${percent}% (${inr(capital * percent / 100)})`;

export function levelTableRows(settings: Record<string, any> | undefined): LevelTableRow[] {
    const b = levelRules(settings, 'beginner');
    const a = levelRules(settings, 'advanced');
    const target = Number(settings?.targetPoints);
    const stop = Number(settings?.stopLossPoints);
    const fixedExits = Number.isFinite(target) && target > 0 && Number.isFinite(stop) && stop > 0 ? `Fixed (target ${target}, stop-loss ${stop} points)` : 'Fixed';
    return [
        { label: 'Flash Trade', beginner: 'Yes', advanced: 'Yes' },
        { label: 'Search & Buy', beginner: 'No', advanced: 'Yes (index options incl. SENSEX, and stock options, any strike and expiry)' },
        { label: 'Target & stop-loss', beginner: fixedExits, advanced: 'Your own (defaults pre-filled, up to the per-trade loss cap)' },
        { label: 'Max loss on one trade', beginner: pctOf(b.maxLossPerTradePercent, b.capital), advanced: `Up to ${pctOf(a.maxLossPerTradePercent, a.capital)}` },
        { label: 'Position sizing', beginner: 'Investment amount', advanced: 'Your choice: investment amount or fixed lots' },
        { label: 'Trades per day', beginner: '3', advanced: '3 (investment-amount mode only; fixed-lot mode has no trade cap)' },
        { label: 'Capital', beginner: inr(b.capital), advanced: `${inr(a.capital)}; more on request after 2 successful weeks` },
        { label: 'Daily loss limit', beginner: pctOf(b.maxDailyDrawdownPercent, b.capital), advanced: pctOf(a.maxDailyDrawdownPercent, a.capital) },
        { label: 'Weekly loss limit', beginner: pctOf(b.maxWeeklyDrawdownPercent, b.capital), advanced: pctOf(a.maxWeeklyDrawdownPercent, a.capital) },
        { label: 'Your profit share', beginner: `${b.profitSplitPercent}%`, advanced: `${a.profitSplitPercent}%` },
        { label: 'Becoming Advanced', beginner: 'Request it and an admin approves. Give a GSTIN and it is immediate, but an invoice is due for every payment or the account is closed', advanced: '-' },
        { label: 'Can switch back?', beginner: '-', advanced: 'No' },
    ];
}

/** Inline-styled table for emails. Every cell is escaped. */
export function renderLevelTableHtml(rows: LevelTableRow[]): string {
    const td = 'padding:7px 8px;border-bottom:1px solid #eef0f2;vertical-align:top';
    const body = rows.map((r) => `<tr><td style="${td};font-weight:bold;width:28%">${escapeHtml(r.label)}</td><td style="${td}">${escapeHtml(r.beginner)}</td><td style="${td}">${escapeHtml(r.advanced)}</td></tr>`).join('');
    return `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:0 0 18px"><thead><tr><th style="${td};text-align:left"></th><th style="${td};text-align:left;color:#1f3a5f">Beginner</th><th style="${td};text-align:left;color:#1f3a5f">Advanced</th></tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * The Advanced terms a user accepts when upgrading (and that the upgrade email attaches as a PDF). DRAFT wording for the owner's review: numbers are
 * not repeated here, the comparison table on the Platform carries them.
 */
export const ADVANCED_TERMS_TEXT: string[] = [
    'DRAFT FOR REVIEW: wording not yet approved by the Company. Advanced Level Addendum to the Trading Participation Agreement.',
    'The Advanced level gives the Trader Search & Buy (index and stock options, any strike and expiry), their own target and stop-loss and a choice of position sizing. It also means more risk: the allocated capital and the daily and weekly loss limits are those shown for the Advanced level in the comparison table on the Platform.',
    'The Trader\'s share of profit at the Advanced level is the Advanced share shown in the comparison table. The level in force when a payout is made applies to the whole payment week, including a week in which the Trader upgraded.',
    'Upgrading to the Advanced level is permanent. The Trader cannot return to the Beginner level.',
    'A Trader who becomes Advanced by providing a GSTIN must give the Company an invoice for every payment within 2 days of the payment (by end of day, India time). If the invoice is not received by then, the Company may close the Trader\'s account; it is reopened once the invoice is received.',
    'The Trader\'s own target and stop-loss are limited so that one stopped-out trade cannot lose more than the per-trade percentage of capital shown in the comparison table; positions are sized down automatically to respect it.',
    'All other terms of the Trading Participation Agreement, the Terms & Conditions and the Privacy Policy continue to apply.',
];
