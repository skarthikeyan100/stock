/** AES-256-GCM field encryption for contractor KYC (PAN, GSTIN, bank account). Key: KYC_ENCRYPTION_KEY, 64 hex chars (openssl rand -hex 32). */
import * as crypto from 'crypto';

function key(): Buffer {
    const hex = process.env.KYC_ENCRYPTION_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('KYC_ENCRYPTION_KEY (64 hex chars) is not set: refusing to store or read contractor KYC');
    return Buffer.from(hex, 'hex');
}
export function isKycCryptoConfigured(): boolean { return /^[0-9a-fA-F]{64}$/.test(process.env.KYC_ENCRYPTION_KEY ?? ''); }

export function encryptField(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
export function decryptField(stored: string): string {
    const [v, iv, tag, ct] = String(stored).split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('malformed encrypted field');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
/** XXXXXX1234: everything but the last four characters masked. */
export function maskLast4(plain: string): string { return plain.length <= 4 ? 'X'.repeat(plain.length) : 'X'.repeat(plain.length - 4) + plain.slice(-4); }
export function maskedField(stored: string | undefined): string | undefined {
    if (!stored) return undefined;
    try { return maskLast4(decryptField(stored)); } catch { return 'XXXX'; }
}
