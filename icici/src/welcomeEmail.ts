/**
 * Welcome email for new users: the trading rules in the body, and three signed PDFs (Agreement, Terms & Conditions, Privacy Policy). Run ONLY from
 * this machine as part of the end-of-day process: `npm run welcome-email` (src/tools/sendWelcomeEmails.ts; deliberately NO HTTP endpoint, NO options).
 *
 * Who: every enabled non-admin user who has no folder under ./storage yet. The user folder IS the "already sent" marker (src/mailStorage.ts): after a
 * send, copies of the three PDFs are kept there; delete a user's folder to send them the welcome email again.
 * Test mode: while settings.eodEmailTestRecipient is set every email goes to that one address with a `[TEST for <user>]` subject prefix, and the
 * copies go under storage/_test/ so testing never marks a real user as welcomed. That key is the single "customer emails only to the owner until
 * approved" switch (see eodEmail.ts). Signed PDFs: src/pdfSigning.ts, src/legalPdf.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import Log from './util/Log';
import configService from './prism/ConfigService';
import { levelRules } from './levelRules';
import { DEFAULT_PROFIT_SPLIT_PERCENT } from './constants';
import { getAllUsers, normalizeEmail, User } from './user';
import { escapeHtml, isMailConfigured, renderTemplate, sendRenderedEmail } from './mailer';
import { testRecipient, todayIst } from './eodEmail';
import { claimWelcome, commitClaim, releaseClaim, writeFiles } from './mailStorage';
import { buildAgreementPdf, buildLegalPdf, AgreementInput } from './legalPdf';
import { TEMPLATE_DIR } from './pdfSigning';

export interface WelcomeFacts { name: string; email: string; date: string; profitSplitPercent: number; allocatedCapital: number; weeklyLimitPercent: number; profitSplit: { beginner: number; advanced: number }; levelCapital: { beginner: number; advanced: number } }

export function welcomeFacts(u: User, date: string): WelcomeFacts {
    const settings = (configService.getConfig()?.settings ?? {}) as Record<string, any>;
    return {
        name: u.legalName || u.name || u.email, email: u.email, date,
        profitSplitPercent: u.profitSplitPercent ?? DEFAULT_PROFIT_SPLIT_PERCENT,
        allocatedCapital: u.accountCapital ?? u.investmentAmount ?? 100000,
        weeklyLimitPercent: levelRules(settings, u.proficiencyLevel).maxWeeklyDrawdownPercent,
        profitSplit: { beginner: levelRules(settings, 'beginner').profitSplitPercent, advanced: levelRules(settings, 'advanced').profitSplitPercent },
        levelCapital: { beginner: levelRules(settings, 'beginner').capital, advanced: levelRules(settings, 'advanced').capital },
    };
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

// The rules of the website's Rules page (frontend/src/pages/RulesPage.tsx); the daily limit is stated generically because it depends on the
// user's proficiency level, the weekly one carries this user's own amount.
export function tradingRules(f: WelcomeFacts): string[] {
    return [
        'The number of simultaneous trades depends on how your account is configured. If your account trades by fixed lot size, multiple positions can run at the same time. If it trades by total investment amount, your entire allocated capital is committed to each trade, and at most 3 trades per day are allowed. These trade-count and investment limits are checked before every order is placed (on the first leg of the trade) and simply reject it if breached.',
        'Maximum daily drawdown: your realized loss on any single day may not exceed a percentage of your allocated investment amount that depends on your proficiency level (Beginner or Advanced). If this limit is reached, your active positions will be automatically squared off, further order placement will be restricted until the next trading day, and all profit accumulated since your last payout is forfeited, even if you had made 100% profit before that day.',
        `Maximum weekly loss: your total realized loss across a trading week (Wednesday through Tuesday) may not exceed ${f.weeklyLimitPercent}% of your allocated investment amount (${rupees(f.allocatedCapital * f.weeklyLimitPercent / 100)} for your account). If this limit is breached, remaining open positions will be automatically squared off and your account will be closed.`,
        `Profit share: you receive ${f.profitSplit.beginner}% of your gross profit at the Beginner level and ${f.profitSplit.advanced}% at the Advanced level. Your proficiency level at the time of payment applies to the entire payment week.`,
        'Trades per day: in investment-amount mode you can place at most 3 trades a day.',
    ];
}

export function renderWelcomeEmail(f: WelcomeFacts): { subject: string; html: string } {
    const td = 'padding:8px;border-bottom:1px solid #eef0f2;vertical-align:top';
    const rulesRows = tradingRules(f).map((r, i) => `<tr><td style="${td};width:28px;font-weight:bold;color:#1f3a5f">${i + 1}</td><td style="${td}">${escapeHtml(r)}</td></tr>`).join('');
    const html = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'welcomeEmail.html'), 'utf8'), { name: escapeHtml(f.name), rulesRows }, false);
    const subject = fs.readFileSync(path.join(TEMPLATE_DIR, 'welcomeEmail.subject.txt'), 'utf8').replace(/\s+/g, ' ').trim();
    return { subject, html };
}

export interface WelcomeSendResult { user: string; to: string; status: 'sent' | 'skipped' | 'failed'; reason?: string; subject?: string; pdfs?: Array<{ filename: string; bytes: number; sha256: string }> }

/** `onlyUsers` is for tests and one-off checks from code; the command line takes no options. */
export async function sendWelcomeEmails(onlyUsers?: string[]): Promise<{ mode: 'test' | 'live'; testRecipient: string | null; results: WelcomeSendResult[] }> {
    const test = testRecipient();
    const mode = test ? 'test' : 'live';
    const today = todayIst();
    if (!isMailConfigured()) throw new Error('Gmail is not configured (set GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env)');
    const only = onlyUsers?.map(normalizeEmail);
    const wanted = (await getAllUsers()).filter((u) => u.enabled !== false && u.role !== 'admin' && (!only || only.includes(normalizeEmail(u.email))));
    const results: WelcomeSendResult[] = [];
    for (const u of wanted) {
        const f = welcomeFacts(u, today);
        const to = test ?? u.email;
        const rendered = renderWelcomeEmail(f);
        const subject = test ? `[TEST for ${u.email}] ${rendered.subject}` : rendered.subject;
        let claim;
        try { claim = claimWelcome(u.email, !!test); } catch (e: any) { results.push({ user: u.email, to, status: 'failed', reason: `storage: ${e?.message ?? e}` }); continue; }
        if (claim.state === 'sent') { results.push({ user: u.email, to, status: 'skipped', reason: `already sent (folder ${claim.dir} exists)` }); continue; }
        if (claim.state === 'inProgress') { results.push({ user: u.email, to, status: 'skipped', reason: `a send is in progress or was interrupted (${claim.dir}); check whether the email went out, then delete that folder` }); continue; }
        try {
            // The PDFs are part of the email: if any cannot be built and signed, nothing is sent. The copies are written BEFORE sending so a send
            // can never succeed without its copy on disk; a failed send removes the claim again.
            const agreement: AgreementInput = { name: f.name, email: f.email, date: f.date, profitSplitPercent: f.profitSplitPercent, allocatedCapital: f.allocatedCapital, weeklyLimitPercent: f.weeklyLimitPercent, profitSplit: f.profitSplit, levelCapital: f.levelCapital };
            const pdfs = [await buildAgreementPdf(agreement), await buildLegalPdf('terms', today), await buildLegalPdf('privacy', today)];
            writeFiles(claim.dir, pdfs.map((p) => ({ filename: p.filename, content: p.pdf })));
            await sendRenderedEmail(to, subject, rendered.html, [
                { filename: 'logo.png', path: path.join(TEMPLATE_DIR, 'logo.png'), cid: 'nivedha-logo', contentDisposition: 'inline' },
                ...pdfs.map((p) => ({ filename: p.filename, content: p.pdf, contentType: 'application/pdf' })),
            ]);
            try { commitClaim(claim); } catch (e: any) { Log.log(`[welcome-email] ALERT: email to ${to} (for ${u.email}) was SENT but ${claim.dir} could not be renamed (${e?.message ?? e}); rename it to the user folder by hand`); }
            results.push({ user: u.email, to, status: 'sent', subject, pdfs: pdfs.map((p) => ({ filename: p.filename, bytes: p.pdf.length, sha256: p.sha256 })) });
        } catch (e: any) {
            releaseClaim(claim);
            const error = e?.message ?? String(e);
            Log.log(`[welcome-email] send to ${to} (for ${u.email}) failed: ${error}`);
            results.push({ user: u.email, to, status: 'failed', reason: error });
        }
    }
    return { mode, testRecipient: test, results };
}
