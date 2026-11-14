/**
 * The end-of-day report PDF attached to the EOD email: Summary, Trades, Payment information. It is DIGITALLY SIGNED (PKCS#7 detached, via the
 * PKCS#12 file in PDF_SIGN_P12 / PDF_SIGN_P12_PASSPHRASE), so any change to the file after signing breaks the signature in a PDF viewer; the
 * SHA-256 of the signed bytes is returned too, so a copy can also be checked against what was sent (stored in Mongo `eodEmails.pdfSha256`).
 * The certificate is self-signed: viewers say "signer unknown" but still report whether the document was modified.
 * Signing and fonts: src/pdfSigning.ts.
 */
import * as path from 'path';
import type { EodReport, EodPayment } from './eodEmail';
import { dayLabel, hhmm, inr, istDayBounds, pnlColor, signedInr } from './eodEmail';
import { TEMPLATE_DIR, isPdfSigningConfigured, newSignableDoc, signDoc } from './pdfSigning';

export { isPdfSigningConfigured };
const NAVY = '#1f3a5f';
const GREY = '#666666';
const LINE = '#e3e5e8';

function paymentLines(p: EodPayment): Array<[string, string, boolean?]> {
    if (!p.available) return [['Estimate', 'Not available right now']];
    const lines: Array<[string, string, boolean?]> = [['Proficiency level', p.level], ['Gross profit this week', signedInr(p.grossProfit)]];
    if (!p.blocked) {
        lines.push([`Your share (${p.profitSplitPercent}%)`, `₹${inr(p.splitAmount)}`], ['TDS', `-₹${inr(p.tdsAmount)}`],
            ['GST', `₹${inr(p.gstAmount)}`], ['Estimated net payout', `₹${inr(p.netAmount)}`, true]);
    } else {
        lines.push(['Estimated net payout', '₹0.00', true]);
    }
    return lines;
}

function paymentNote(p: EodPayment): string {
    if (!p.available) return 'We could not compute your payout estimate for this week. It will be included in the next summary.';
    if (p.blocked) return p.grossProfit <= 0 && !/forfeit|exceeds/i.test(p.blockReason ?? '')
        ? 'No payout is due for this week so far: there is no net profit yet.'
        : `No payout is due for this week: ${p.blockReason ?? 'it is blocked'}`;
    return 'Payouts are for the Wednesday to Tuesday trading week.';
}

/** Builds and signs the report PDF. Throws when the certificate is missing or signing fails: the caller must then send nothing. */
export async function buildSignedEodPdf(r: EodReport): Promise<{ pdf: Buffer; sha256: string; filename: string }> {
    const { start } = istDayBounds(r.date);
    const label = dayLabel(start);
    const sd = newSignableDoc(`Trading summary ${label}`, r.date);
    const doc = sd.doc;
    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    // header band: logo + name
    doc.rect(0, 0, doc.page.width, 70).fill(NAVY);
    doc.image(path.join(TEMPLATE_DIR, 'logo.png'), left, 20, { width: 28, height: 28 });
    doc.fillColor('#ffffff').font('B').fontSize(17).text('Nivedha Tech', left + 38, 20, { lineBreak: false });
    doc.font('R').fontSize(10).text(`End-of-day trading summary · ${label}`, left + 38, 44, { lineBreak: false });
    doc.fillColor('#222222');
    doc.y = 90;

    const heading = (t: string) => { doc.moveDown(0.6); doc.font('B').fontSize(12).fillColor(NAVY).text(t, left, doc.y); doc.moveDown(0.3); doc.fillColor('#222222'); };

    doc.font('R').fontSize(10).text(`Hi ${r.name},`, left, doc.y);
    doc.text(`Here is your trading summary for ${label}.`);

    heading('Summary');
    const tileW = (width - 20) / 3;
    const tiles: Array<[string, string, string, string]> = [
        ['Day P&L (realized)', signedInr(r.dayPnl), pnlColor(r.dayPnl), ''],
        ['Closed trades', String(r.closedCount), '#222222', `${r.wins} won / ${r.losses} lost`],
        ['Open positions', String(r.openCount), '#222222', ''],
    ];
    const ty = doc.y;
    tiles.forEach(([t, v, c, sub], i) => {
        const x = left + i * (tileW + 10);
        doc.rect(x, ty, tileW, 58).strokeColor(LINE).stroke();
        doc.font('R').fontSize(8).fillColor(GREY).text(t, x + 8, ty + 8, { width: tileW - 16 });
        doc.font('B').fontSize(15).fillColor(c).text(v, x + 8, ty + 22, { width: tileW - 16 });
        if (sub) doc.font('R').fontSize(8).fillColor(GREY).text(sub, x + 8, ty + 43, { width: tileW - 16 });
    });
    doc.fillColor('#222222');
    doc.y = ty + 70;

    heading('Trades');
    const cols = [{ h: 'Time', w: 0.18, a: 'left' }, { h: 'Contract', w: 0.30, a: 'left' }, { h: 'Qty', w: 0.10, a: 'right' }, { h: 'Entry', w: 0.14, a: 'right' }, { h: 'Exit', w: 0.14, a: 'right' }, { h: 'P&L', w: 0.14, a: 'right' }] as const;
    const row = (cells: string[], bold: boolean, colors?: Array<string | undefined>) => {
        if (doc.y > doc.page.height - 70) { doc.addPage(); doc.y = doc.page.margins.top; }
        const y = doc.y;
        let x = left;
        cols.forEach((c, i) => {
            doc.font(bold ? 'B' : 'R').fontSize(8.5).fillColor(colors?.[i] ?? '#222222').text(cells[i], x + 3, y, { width: width * c.w - 6, align: c.a, lineBreak: false });
            x += width * c.w;
        });
        doc.y = y + 15;
        doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).strokeColor(LINE).stroke();
    };
    row(cols.map((c) => c.h), true);
    if (r.rows.length === 0) { doc.font('R').fontSize(9).fillColor(GREY).text('No trades.', left + 3, doc.y); doc.moveDown(0.5); }
    for (const t of r.rows) {
        row([`${hhmm(t.entryTime)}${t.exitTime ? ` → ${hhmm(t.exitTime)}` : ''}`, t.contract, String(t.quantity), t.entryPrice === null ? '-' : inr(t.entryPrice),
            t.exitPrice === null ? '-' : inr(t.exitPrice), t.pnl === null ? 'Open' : signedInr(t.pnl)], false, [undefined, undefined, undefined, undefined, undefined, pnlColor(t.pnl)]);
    }

    heading('Payment information');
    doc.font('R').fontSize(9).fillColor(GREY).text(`Week ${dayLabel(r.payment.weekStart)} to ${dayLabel(new Date(r.payment.weekEnd.getTime() - 1))}`, left, doc.y);
    doc.moveDown(0.4);
    for (const [k, v, bold] of paymentLines(r.payment)) {
        if (doc.y > doc.page.height - 70) { doc.addPage(); doc.y = doc.page.margins.top; }
        const y = doc.y;
        doc.font('R').fontSize(9.5).fillColor(GREY).text(k, left + 3, y, { width: width * 0.6, lineBreak: false });
        doc.font(bold ? 'B' : 'R').fillColor('#222222').text(v, left + width * 0.6, y, { width: width * 0.4 - 3, align: 'right', lineBreak: false });
        doc.y = y + 16;
        doc.moveTo(left, doc.y - 3).lineTo(left + width, doc.y - 3).strokeColor(LINE).stroke();
    }
    doc.moveDown(0.4);
    doc.font('R').fontSize(9).fillColor(GREY).text(paymentNote(r.payment), left, doc.y, { width });
    doc.moveDown(0.5);
    doc.font('B').fontSize(9).fillColor('#222222').text('Proficiency level: ', left, doc.y, { width, continued: true }).font('R').text('Your proficiency level (Beginner or Advanced) at the time of payment applies to the entire payment week. Payout estimates shown before the payment date are indicative and can change if your proficiency level changes.');

    const { pdf, sha256 } = await signDoc(sd, 'End-of-day trading report: any later change invalidates this signature');
    const local = r.user.split('@')[0].replace(/[^A-Za-z0-9._-]/g, '_');
    return { pdf, sha256, filename: `trading-summary-${local}-${r.date}.pdf` };
}
