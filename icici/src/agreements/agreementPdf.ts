/**
 * Builds the signed Researcher Services Agreement PDFs (src/agreements/content/*). A new file: it uses the shared signing helpers
 * (src/pdfSigning.ts) and the same look as src/legalPdf.ts, which is left unchanged.
 */
import * as path from 'path';
import { TEMPLATE_DIR, newSignableDoc, signDoc } from '../pdfSigning';

export type AgreementBlock =
    | { t: 'h2'; text: string }
    | { t: 'p'; text: string }
    | { t: 'li'; text: string; depth?: number }
    | { t: 'num'; n: string; text: string }
    | { t: 'table'; rows: [string, string][] }
    | { t: 'sig'; left: string[]; right: string[] };

/** The contractor's details (and the Company's) that fill the Parties clause and the other [placeholders]; anything missing stays as a bracketed placeholder. */
export interface AgreementDetails {
    name?: string; address?: string; pan?: string; gstin?: string;
    entityName?: string; analystName?: string;
    sebiNumber?: string; sebiValidUntil?: string;
    company?: { name?: string; address?: string; pan?: string };
    // Schedule values, from config at the time the agreement is prepared (so no blank remains in the PDF)
    fixedFeeFromStart?: boolean; // the clause 6A.5 confirmation was not given: the fixed fee of 6A.6 applies from the Effective Date
    profitSharePercent?: number; recHours?: { start: string; end: string }; perDay?: number; acceptedOn?: string;
    fixedFee?: number; fixedFeeMonths?: number; referenceInvestment?: number; // clause 6A.6: rupees per Fee Period, the Fee Period in months, the Reference Investment
    rules?: { maxOpenPositions?: number; noNewAfter?: string; maxInvestment?: number; dailyLossLimit?: number; dailyDrawdownPercent?: number; weeklyDrawdownPercent?: number; allocatedCapital?: number }; // Schedule 2: the limits the Platform applies to Resulting Trades
    fees?: { retainer?: number; feePerCorrect?: number; monthlyCap?: number; minDays?: number; windowMinutes?: number; neutral?: number; dailyLimit?: number; hours?: { start: string; end: string; expiryEnd: string } };
}

export interface AgreementDoc {
    /** The document title, e.g. "Research Analyst Services Agreement". */
    title: string;
    /** e.g. "Business Contractor (GSTIN)" */
    kind: string;
    version: string;
    /** the cover line, e.g. "Version 1.1 · November 2026 · Pilot programme · By invitation only" */
    cover: string;
    blocks: AgreementBlock[];
}

const NAVY = '#1f3a5f';
const GREY = '#666666';

export async function buildAgreementPdf(a: AgreementDoc, date: string): Promise<{ pdf: Buffer; sha256: string }> {
    const title = `${a.title} - ${a.kind}`;
    const sd = newSignableDoc(`${title} v${a.version} - Nivedha Tech`, date);
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
    doc.font('B').fontSize(16).fillColor(NAVY).text(a.title, left, doc.y, { width });
    doc.font('B').fontSize(12).text(a.kind, left, doc.y + 2, { width });
    doc.font('R').fontSize(9).fillColor(GREY).text(a.cover, left, doc.y + 2, { width });
    doc.moveDown(0.8).fillColor('#222222');
    for (const b of a.blocks) {
        if (b.t === 'h2') { doc.moveDown(0.7).font('B').fontSize(12).fillColor(NAVY).text(b.text, left, doc.y, { width }); doc.moveDown(0.25).fillColor('#222222'); }
        else if (b.t === 'li') { const ind = 14 + (b.depth ?? 0) * 14; doc.font('R').fontSize(9.5).text(`•  ${b.text}`, left + ind, doc.y, { width: width - ind, lineGap: 1 }); doc.moveDown(0.15); }
        else if (b.t === 'num') { doc.font('B').fontSize(9.5).text(`${b.n}  `, left + 14, doc.y, { width: width - 14, continued: true, lineGap: 1 }).font('R').text(b.text, { lineGap: 1 }); doc.moveDown(0.15); }
        else if (b.t === 'table') {
            const col1 = Math.round(width * 0.36);
            for (const [k, v] of b.rows) {
                const y = doc.y;
                const h = Math.max(doc.heightOfString(k, { width: col1 - 8 }), doc.heightOfString(v, { width: width - col1 - 8 })) + 6;
                if (y + h > doc.page.height - doc.page.margins.bottom - 20) { doc.addPage(); }
                const y0 = doc.y;
                doc.rect(left, y0, width, h).strokeColor('#cccccc').lineWidth(0.5).stroke();
                doc.moveTo(left + col1, y0).lineTo(left + col1, y0 + h).stroke();
                doc.font('B').fontSize(9.5).fillColor('#222222').text(k, left + 4, y0 + 3, { width: col1 - 8 });
                doc.font('R').fontSize(9.5).text(v, left + col1 + 4, y0 + 3, { width: width - col1 - 8 });
                doc.y = y0 + h;
            }
            doc.moveDown(0.4);
        } else if (b.t === 'sig') {
            const half = Math.round(width / 2) - 10;
            const y0 = doc.y + 4;
            const lines = Math.max(b.left.length, b.right.length);
            for (let i = 0; i < lines; i++) {
                if (b.left[i]) doc.font('R').fontSize(9.5).text(b.left[i], left, y0 + i * 16, { width: half, lineBreak: false });
                if (b.right[i]) doc.font('R').fontSize(9.5).text(b.right[i], left + half + 20, y0 + i * 16, { width: half, lineBreak: false });
            }
            doc.y = y0 + lines * 16 + 6;
        } else { doc.font('R').fontSize(9.5).text(b.text, left, doc.y, { width, lineGap: 1 }); doc.moveDown(0.45); }
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        doc.page.margins.bottom = 0; // the footer sits inside the bottom margin; writing there must not add a page
        doc.font('R').fontSize(8).fillColor(GREY).text(`${title}  ·  v${a.version}  ·  Page ${i + 1} of ${range.count}`, left, doc.page.height - 28, { width, align: 'center', lineBreak: false });
    }
    return signDoc(sd, `${title} v${a.version}: any later change invalidates this signature`);
}
