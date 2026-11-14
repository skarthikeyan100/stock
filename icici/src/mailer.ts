import nodemailer from 'nodemailer';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import configService from './prism/ConfigService';

// Templates live in <repo>/templates (outside src/ so editing the wording needs no code change); this file compiles
// to dist/mailer.js, so the repo root is one level up from __dirname.
const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates');

export interface MailAttachment { filename: string; content: Buffer; contentType?: string }

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// {{key}} -> vars[key]. Unknown keys render empty rather than leaking the placeholder into a customer email.
export function renderTemplate(template: string, vars: Record<string, string>, escape: boolean): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
        const v = vars[key] ?? '';
        return escape ? escapeHtml(v) : v;
    });
}

// Sends through the Gmail REST API (users.messages.send), NOT SMTP: the refresh token has only the narrow gmail.send scope, which Gmail's SMTP
// XOAUTH2 login rejects ("Connection closed unexpectedly"); SMTP would need the full https://mail.google.com/ scope. nodemailer only builds the MIME.
// Own axios instance: the global one has an interceptor (prism/RestAPI.ts) that unwraps response.data.
const gmailHttp = axios.create({ timeout: 30000 });

async function gmailAccessToken(): Promise<string> {
    const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    const r = await gmailHttp.post('https://oauth2.googleapis.com/token', new URLSearchParams({
        client_id: GMAIL_CLIENT_ID as string, client_secret: GMAIL_CLIENT_SECRET as string, refresh_token: GMAIL_REFRESH_TOKEN as string, grant_type: 'refresh_token',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!r.data?.access_token) throw new Error('Gmail token refresh returned no access_token');
    return r.data.access_token as string;
}

export function createTransport() {
    const { GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    if (!GMAIL_USER || !GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
        throw new Error('Gmail is not configured (set GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN in .env)');
    }
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    return {
        async sendMail(mail: nodemailer.SendMailOptions): Promise<void> {
            const built: any = await builder.sendMail(mail);
            const raw = Buffer.from(built.message).toString('base64url');
            try {
                await gmailHttp.post('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw }, { headers: { Authorization: `Bearer ${await gmailAccessToken()}` } });
            } catch (e: any) {
                const d = e?.response?.data;
                throw new Error(`Gmail API send failed: ${d?.error?.message ?? d?.error_description ?? e?.message ?? e}`);
            }
        },
    };
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
    const rendered = renderPayoutPaidEmail(vars);
    // settings.eodEmailTestRecipient (config.yml) is the single "email only the owner until the content is approved" switch for every
    // customer email: while set, the mail goes to that address alone, tagged with the real recipient. Remove the key to email real users.
    const test = (configService.getConfig()?.settings as any)?.eodEmailTestRecipient;
    const recipient = test ? String(test).trim() : to;
    const subject = test ? `[TEST for ${to}] ${rendered.subject}` : rendered.subject;
    const html = rendered.html;
    const transport = createTransport();
    await transport.sendMail({
        from: process.env.GMAIL_USER,
        to: recipient,
        subject,
        html,
        attachments: attachment ? [attachment] : [],
    });
}

export function isMailConfigured(): boolean {
    const { GMAIL_USER, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
    return !!(GMAIL_USER && GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN);
}

// Sends an already-rendered email (the EOD summary). The From name is fixed; the address is the authenticated Gmail account (GMAIL_USER,
// admin@nivedhatech.com in production). Throws on any failure; the caller records it per recipient.
export async function sendRenderedEmail(to: string, subject: string, html: string, attachments: nodemailer.SendMailOptions['attachments'] = []): Promise<void> {
    const transport = createTransport();
    await transport.sendMail({ from: { name: 'Nivedha Tech', address: process.env.GMAIL_USER as string }, to, subject, html, attachments });
}
