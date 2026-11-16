/** Contractor emails through the existing Gmail mailer. While settings.eodEmailTestRecipient is set, EVERY customer email goes only to that address (same switch as the EOD / payout emails). */
import * as fs from 'fs';
import * as path from 'path';
import { isMailConfigured, renderTemplate, sendRenderedEmail } from '../mailer';
import { testRecipient } from '../eodEmail';

const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', 'templates');
export const publicBaseUrl = () => (process.env.PUBLIC_BASE_URL || 'https://www.nivedhatech.com').replace(/\/+$/, '');

export interface Sent { to: string; redirectedTo?: string }

export async function sendContractorEmail(to: string, subject: string, html: string, attachments: any[] = []): Promise<Sent> {
    if (!isMailConfigured()) throw new Error('Gmail is not configured');
    const test = testRecipient();
    await sendRenderedEmail(test ?? to, test ? `[TEST for ${to}] ${subject}` : subject, html, attachments);
    return { to, redirectedTo: test ?? undefined };
}

/** Business (GSTIN) contractors submit recommendations; Individual (PAN) contractors submit forecasts. */
export const programmeName = (type: string) => (type === 'BUSINESS' ? 'recommendations programme' : 'forecasting programme');

export async function sendInviteEmail(to: string, type: string, link: string, expires: Date): Promise<Sent> {
    const kind = type === 'BUSINESS' ? 'Business (GSTIN)' : 'Individual (PAN)';
    const programme = programmeName(type);
    const vars = { kind, programme, link, expires: expires.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) };
    const html = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'contractorInviteEmail.html'), 'utf8'), vars, true);
    const subject = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'contractorInviteEmail.subject.txt'), 'utf8').replace(/\s+/g, ' ').trim(), { programme }, false);
    return sendContractorEmail(to, subject, html);
}
