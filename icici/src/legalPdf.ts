/**
 * The three signed PDFs attached to the welcome email: Agreement (personalised, drafted from the commercial sections of the Terms),
 * Terms & Conditions and Privacy Policy (the website's wording, extracted by src/tools/extractLegal.ts into templates/legal/*.json).
 * Signing: src/pdfSigning.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LegalBlock, LegalDoc } from './tools/extractLegal';
import { TEMPLATE_DIR, newSignableDoc, signDoc } from './pdfSigning';

const NAVY = '#1f3a5f';
const GREY = '#666666';

export interface LegalPdf { pdf: Buffer; sha256: string; filename: string }

export function loadLegal(name: 'terms' | 'privacy'): LegalDoc {
    return JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, 'legal', `${name}.json`), 'utf8')) as LegalDoc;
}

async function buildPdf(title: string, subtitle: string, blocks: LegalBlock[], date: string, filename: string, lead?: string[]): Promise<LegalPdf> {
    const sd = newSignableDoc(`${title} - Nivedha Tech`, date);
    const doc = sd.doc;
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    doc.rect(0, 0, doc.page.width, 70).fill(NAVY);
    doc.image(path.join(TEMPLATE_DIR, 'logo.png'), left, 20, { width: 28, height: 28 });
    doc.fillColor('#ffffff').font('B').fontSize(17).text('Nivedha Tech', left + 38, 20, { lineBreak: false });
    doc.font('R').fontSize(10).text(title, left + 38, 44, { lineBreak: false });
    doc.fillColor('#222222');
    doc.y = 90;
    doc.x = left;
    doc.font('B').fontSize(16).fillColor(NAVY).text(title, left, doc.y, { width });
    doc.font('R').fontSize(9).fillColor(GREY).text(subtitle, left, doc.y + 2, { width });
    doc.moveDown(0.8).fillColor('#222222');
    for (const t of lead ?? []) { doc.font('R').fontSize(9.5).text(t, left, doc.y, { width }); doc.moveDown(0.5); }
    for (const b of blocks) {
        if (b.t === 'h2') { doc.moveDown(0.7).font('B').fontSize(12).fillColor(NAVY).text(b.text, left, doc.y, { width }); doc.moveDown(0.25).fillColor('#222222'); }
        else if (b.t === 'h3') { doc.moveDown(0.3).font('B').fontSize(10).fillColor('#222222').text(b.text, left, doc.y, { width }); doc.moveDown(0.15); }
        else if (b.t === 'li') { const ind = 14 + (b.depth ?? 0) * 14; doc.font('R').fontSize(9.5).text(`•  ${b.text}`, left + ind, doc.y, { width: width - ind, lineGap: 1 }); doc.moveDown(0.15); }
        else { doc.font('R').fontSize(9.5).text(b.text, left, doc.y, { width, lineGap: 1 }); doc.moveDown(0.45); }
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0; // footers sit inside the bottom margin; writing there must not add a page
        doc.font('R').fontSize(8).fillColor(GREY).text(`${title}  ·  Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: 'center', lineBreak: false });
    }
    const { pdf, sha256 } = await signDoc(sd, `${title}: any later change invalidates this signature`);
    return { pdf, sha256, filename };
}

export function buildLegalPdf(which: 'terms' | 'privacy', date: string): Promise<LegalPdf> {
    const d = loadLegal(which);
    return buildPdf(d.title, d.lastUpdated, d.blocks, date, which === 'terms' ? 'Terms-and-Conditions.pdf' : 'Privacy-Policy.pdf');
}

export interface AgreementInput {
    name: string; email: string; date: string; // date = IST YYYY-MM-DD the agreement is issued
    profitSplitPercent: number; allocatedCapital: number; weeklyLimitPercent: number;
    profitSplit: { beginner: number; advanced: number }; // the Trader's profit share for each proficiency level (config.yml settings.levelRules)
    levelCapital: { beginner: number; advanced: number }; // starting allocated capital for each level
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export function agreementBlocks(a: AgreementInput): LegalBlock[] {
    const h2 = (text: string): LegalBlock => ({ t: 'h2', text });
    const p = (text: string): LegalBlock => ({ t: 'p', text });
    const li = (text: string): LegalBlock => ({ t: 'li', text });
    const weekly = a.allocatedCapital * a.weeklyLimitPercent / 100;
    return [
        h2('1. Parties'),
        p(`This Trading Participation Agreement is between PropFirm ("Company"), which operates the PropFirm Trading Platform ("Platform"), and ${a.name} (${a.email}) ("Trader"). It is issued on ${a.date}.`),
        h2('2. Arrangement'),
        li('The Company allocates trading capital and infrastructure to the Trader to trade NIFTY index options through its authorized broker partners.'),
        li("Every trade is placed from the Company's own account and capital."),
        li('No upfront capital contribution is required from the Trader.'),
        h2('3. Commercial terms for this Trader'),
        li(`Profit share: the Trader retains ${a.profitSplitPercent}% of net profits and the Company retains ${100 - a.profitSplitPercent}%.`),
        li(`Allocated capital: ${rupees(a.allocatedCapital)}.`),
        li('Daily loss limit: a percentage of allocated capital that depends on the Trader\'s proficiency level (Beginner or Advanced), as shown on the Platform. On breach, active positions are squared off, further orders are restricted until the next trading day, and all profit accumulated since the last payout is forfeited.'),
        li(`Weekly loss limit: ${a.weeklyLimitPercent}% of allocated capital (${rupees(weekly)}) over the trading week (Wednesday to Tuesday). On breach, open positions are squared off and the account is closed.`),
        li('Profits are calculated on closed trades (realized profit and loss only) and are payable weekly, every Wednesday, to the bank account registered by the Trader.'),
        li(`Profit share by level: the Trader retains ${a.profitSplit.beginner}% of net profits at the Beginner level and ${a.profitSplit.advanced}% at the Advanced level. Starting allocated capital is ${rupees(a.levelCapital.beginner)} at the Beginner level and ${rupees(a.levelCapital.advanced)} at the Advanced level.`),
        li('Your proficiency level (Beginner or Advanced) at the time of payment applies to the entire payment week. Payout estimates shown before the payment date are indicative and can change if your proficiency level changes.'),
        h2('4. Losses and risk'),
        p('The Trader bears full responsibility for all losses incurred. There is no compensation, reimbursement or loss recovery for trading losses. Trading in options involves risk and returns are not guaranteed.'),
        h2('5. Tax'),
        p('The Trader is solely responsible for all tax obligations on trading profits. Tax deducted at source and GST are applied to payouts as the law requires, and the Company does not provide tax advice.'),
        h2('6. Terms, Privacy Policy and disputes'),
        li('The Terms & Conditions and the Privacy Policy, delivered with this Agreement, form part of it. Together they are the entire agreement between the Trader and the Company.'),
        li('Disputes are first raised in writing with support, and are resolved by binding arbitration under the Arbitration and Conciliation Act, 1996, conducted in English in India. The laws of India govern this Agreement.'),
        h2('7. Acceptance'),
        p('This Agreement takes effect when the Trader accepts the Terms & Conditions on the Platform. By accepting, the Trader confirms having read and understood this Agreement, the Terms & Conditions and the Privacy Policy.'),
    ];
}

export function buildAgreementPdf(a: AgreementInput): Promise<LegalPdf> {
    return buildPdf('Trading Participation Agreement', `Issued ${a.date} to ${a.name} (${a.email})`, agreementBlocks(a), a.date, 'Agreement.pdf');
}
