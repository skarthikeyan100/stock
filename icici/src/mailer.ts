import nodemailer from 'nodemailer';
import * as fs from 'fs';
import * as path from 'path';

// Templates live in <repo>/templates (outside src/ so editing the wording needs no code change); this file compiles
// to dist/mailer.js, so the repo root is one level up from __dirname.
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates');

export interface MailAttachment { filename: string; content: Buffer; contentType?: string }

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// {{key}} -> vars[key]. Unknown keys render empty rather than leaking the placeholder into a customer email.
export function renderTemplate(template: string, vars: Record<string, string>, escape: boolean): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
        const v = vars[key] ?? '';
        return escape ? escapeHtml(v) : v;
    });
}

function createTransport() {
    const { GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    if (!GMAIL_USER || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
        throw new Error('Gmail is not configured (set GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env)');
    }
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { type: 'OAuth2', user: GMAIL_USER, clientId: GMAIL_CLIENT_ID, clientSecret: GMAIL_CLIENT_SECRET, refreshToken: GMAIL_REFRESH_TOKEN },
    });
}

export interface PayoutPaidEmailVars {
    name: string;
    invoiceNumber: string;
    period: string;
    netAmount: string;
    paidDate: string;
    destination: string;
    paymentRef: string;
    note: string;
}

export function renderPayoutPaidEmail(vars: PayoutPaidEmailVars): { subject: string; html: string } {
    const html = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'payoutPaidEmail.html'), 'utf8'), { ...vars }, true);
    // The subject is plain text: header-injection safe by collapsing any line breaks.
    const subject = renderTemplate(fs.readFileSync(path.join(TEMPLATE_DIR, 'payoutPaidEmail.subject.txt'), 'utf8'), { ...vars }, false)
        .replace(/\s+/g, ' ').trim();
    return { subject, html };
}

// Throws on any failure (config, template, SMTP); the caller records the failure instead of failing the payout.
export async function sendPayoutPaidEmail(to: string, vars: PayoutPaidEmailVars, attachment?: MailAttachment): Promise<void> {
    const { subject, html } = renderPayoutPaidEmail(vars);
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject,
        html,
        attachments: attachment ? [attachment] : [],
    });
}
