/**
 * The email sent once when a user becomes Advanced (admin approval or a GSTIN): the new capital and profit share, the comparison table, the invoice
 * note for GSTIN users, and two signed PDFs (the updated Agreement and the Advanced terms). Sent from the server right after the upgrade (fire and forget).
 * Once-only marker: mailStorage claimUpgrade (a sibling `<user>.upgrade` folder). While settings.eodEmailTestRecipient is set every email goes only to
 * that address (subject prefixed `[TEST for <user>]`), exactly like the welcome email.
 */
import * as fs from 'fs';
import * as path from 'path';
import Log from './util/Log';
import configService from './prism/ConfigService';
import { normalizeLevel } from './levelRules';
import { getUser } from './user';
import { escapeHtml, isMailConfigured, renderTemplate, sendRenderedEmail } from './mailer';
import { testRecipient, todayIst } from './eodEmail';
import { claimUpgrade, commitClaim, releaseClaim, writeFiles } from './mailStorage';
import { buildAgreementPdf, buildAdvancedAddendumPdf } from './legalPdf';
import { TEMPLATE_DIR } from './pdfSigning';
import { levelTableRows, renderLevelTableHtml } from './levelTable';
import { welcomeFacts, WelcomeSendResult } from './welcomeEmail';

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function renderUpgradeEmail(f: { name: string; capital: number; profitSplitPercent: number; viaGstin: boolean }): { subject: string; html: string } {
    const invoiceNote = f.viaGstin
        ? '<p style="margin:0 0 14px;padding:10px 12px;background:#fff8e6;border:1px solid #f0d98c;border-radius:6px"><strong>Invoice for every payment.</strong> Because you became Advanced by giving a GSTIN, you must send us an invoice for every payment within 2 days of the payment (by the end of the day, India time). If we do not receive it by then, your account will be closed.</p>'
        : '';
    const levelTable = renderLevelTableHtml(levelTableRows((configService.getConfig()?.settings ?? {}) as Record<string, any>));
    const html = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'upgradeEmail.html'), 'utf8'),
        { name: escapeHtml(f.name), capital: rupees(f.capital), share: String(f.profitSplitPercent), invoiceNote, levelTable }, false);
    const subject = fs.readFileSync(path.join(TEMPLATE_DIR, 'upgradeEmail.subject.txt'), 'utf8').replace(/\s+/g, ' ').trim();
    return { subject, html };
}

export async function sendUpgradeEmail(email: string): Promise<WelcomeSendResult> {
    const u = await getUser(email);
    if (!u) throw new Error(`User not found: ${email}`);
    const test = testRecipient();
    const to = test ?? u.email;
    if (normalizeLevel(u.proficiencyLevel) !== 'advanced') return { user: u.email, to, status: 'skipped', reason: 'not an Advanced user' };
    if (!isMailConfigured()) throw new Error('Gmail is not configured (set GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env)');
    const claim = claimUpgrade(u.email, !!test);
    if (claim.state === 'sent') return { user: u.email, to, status: 'skipped', reason: `already sent (${claim.dir} exists)` };
    if (claim.state === 'inProgress') return { user: u.email, to, status: 'skipped', reason: `a send is in progress or was interrupted (${claim.dir}); check whether the email went out, then delete that folder` };
    const f = welcomeFacts(u, todayIst());
    const rendered = renderUpgradeEmail({ name: f.name, capital: f.allocatedCapital, profitSplitPercent: f.profitSplitPercent, viaGstin: u.advancedVia === 'gstin' });
    const subject = test ? `[TEST for ${u.email}] ${rendered.subject}` : rendered.subject;
    try {
        const pdfs = [
            await buildAgreementPdf({ name: f.name, email: f.email, date: f.date, profitSplitPercent: f.profitSplitPercent, allocatedCapital: f.allocatedCapital, weeklyLimitPercent: f.weeklyLimitPercent, profitSplit: f.profitSplit, levelCapital: f.levelCapital }),
            await buildAdvancedAddendumPdf(f.date),
        ];
        writeFiles(claim.dir, pdfs.map((p) => ({ filename: p.filename, content: p.pdf })));
        await sendRenderedEmail(to, subject, rendered.html, [
            { filename: 'logo.png', path: path.join(TEMPLATE_DIR, 'logo.png'), cid: 'nivedha-logo', contentDisposition: 'inline' },
            ...pdfs.map((p) => ({ filename: p.filename, content: p.pdf, contentType: 'application/pdf' })),
        ]);
        try { commitClaim(claim); } catch (e: any) { Log.log(`[upgrade-email] ALERT: email to ${to} (for ${u.email}) was SENT but ${claim.dir} could not be renamed (${e?.message ?? e}); rename it by hand`); }
        return { user: u.email, to, status: 'sent', subject, pdfs: pdfs.map((p) => ({ filename: p.filename, bytes: p.pdf.length, sha256: p.sha256 })) };
    } catch (e: any) {
        releaseClaim(claim);
        const error = e?.message ?? String(e);
        Log.log(`[upgrade-email] send to ${to} (for ${u.email}) failed: ${error}`);
        return { user: u.email, to, status: 'failed', reason: error };
    }
}
