/**
 * Shared PDF signing for every PDF this system emails (EOD report, welcome-email legal documents). PKCS#7 detached signature from the PKCS#12
 * file in PDF_SIGN_P12 / PDF_SIGN_P12_PASSPHRASE: any change to the file afterwards breaks the signature in a PDF viewer. The certificate is
 * self-signed, so viewers say "signer unknown" but still report whether the document was modified. Plain pdfkit only (Chrome print-to-pdf output
 * cannot be signed by @signpdf).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { pdfkitAddPlaceholder } from '@signpdf/placeholder-pdfkit';
import signpdf from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';

export const TEMPLATE_DIR = path.resolve(__dirname, '..', 'templates');
const SIGNATURE_LENGTH = 16384; // bytes reserved for the signature; a 3072-bit RSA PKCS#7 needs far less

export function isPdfSigningConfigured(): boolean {
    return !!process.env.PDF_SIGN_P12 && fs.existsSync(path.resolve(process.env.PDF_SIGN_P12));
}

export interface SignableDoc { doc: PDFKit.PDFDocument; done: Promise<Buffer> }

/** A new A4 document with the bundled fonts registered as 'R' / 'B'. `date` pins the creation date so a rebuild of the same report is reproducible. */
export function newSignableDoc(title: string, date: string): SignableDoc {
    if (!isPdfSigningConfigured()) throw new Error('PDF signing is not configured (set PDF_SIGN_P12 and PDF_SIGN_P12_PASSPHRASE in .env)');
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, autoFirstPage: true, info: { Title: title, Author: 'Nivedha Tech' } });
    doc.info.CreationDate = new Date(`${date}T00:00:00Z`) as any;
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => { doc.on('data', (c: Buffer) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
    doc.registerFont('R', path.join(TEMPLATE_DIR, 'fonts', 'DejaVuSans.ttf'));
    doc.registerFont('B', path.join(TEMPLATE_DIR, 'fonts', 'DejaVuSans-Bold.ttf'));
    return { doc, done };
}

/** Adds the signature field, ends the document and signs the finished bytes. */
export async function signDoc({ doc, done }: SignableDoc, reason: string): Promise<{ pdf: Buffer; sha256: string }> {
    // pdfkit 0.15 ends the placeholder refs itself in doc.end(); ending them here too writes the signature object twice ("multiple ByteRange placeholders").
    pdfkitAddPlaceholder({ pdf: doc, pdfBuffer: Buffer.from([doc as any]), reason, contactInfo: process.env.GMAIL_USER || 'admin@nivedhatech.com',
        name: 'Nivedha Tech', location: 'India', signatureLength: SIGNATURE_LENGTH });
    doc.end();
    const unsigned = await done;
    const signer = new P12Signer(fs.readFileSync(path.resolve(process.env.PDF_SIGN_P12 as string)), { passphrase: process.env.PDF_SIGN_P12_PASSPHRASE ?? '' });
    const pdf = await signpdf.sign(unsigned, signer);
    return { pdf, sha256: crypto.createHash('sha256').update(pdf).digest('hex') };
}
