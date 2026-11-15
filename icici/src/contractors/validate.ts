/** Format checks for contractor KYC (pure, no I/O). */
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const ACCOUNT_RE = /^[0-9]{9,18}$/;
/** SEBI Research Analyst registration number: INH + 9 digits. INA (Investment Adviser) is NOT accepted (spec v2.1 section 5). */
export const SEBI_RA_RE = /^INH[0-9]{9}$/;
export const EMAIL_RE = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;

export const normPan = (v: unknown) => String(v ?? '').trim().toUpperCase();
export const normGstin = (v: unknown) => String(v ?? '').trim().toUpperCase();
export const normIfsc = (v: unknown) => String(v ?? '').trim().toUpperCase();
export const normAccount = (v: unknown) => String(v ?? '').replace(/\s+/g, '');
export const normSebi = (v: unknown) => String(v ?? '').trim().toUpperCase();

export function validPan(v: string): boolean { return PAN_RE.test(v); }
/** A GSTIN is valid when it matches the format AND the PAN embedded in it (characters 3 to 12) equals the entity's PAN. */
export function gstinMatchesPan(gstin: string, pan: string): boolean { return GSTIN_RE.test(gstin) && gstin.slice(2, 12) === pan; }
export function validIfsc(v: string): boolean { return IFSC_RE.test(v); }
export function validAccount(v: string): boolean { return ACCOUNT_RE.test(v); }
export function validSebi(v: string): boolean { return SEBI_RA_RE.test(v); }
export function validEmail(v: string): boolean { return EMAIL_RE.test(v) && v.length <= 254; }
export function validIsoDate(v: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')); }

/** A registration is usable on a date when it is verified and valid-until is that day or later (IST date string compare). */
export function sebiUsable(s: { number: string; validUntil: string; verifiedAt?: unknown } | undefined, todayIst: string): boolean {
    return !!s && validSebi(s.number) && !!s.verifiedAt && validIsoDate(s.validUntil) && s.validUntil >= todayIst;
}
export function daysUntil(isoDate: string, todayIst: string): number {
    return Math.round((Date.parse(isoDate + 'T00:00:00Z') - Date.parse(todayIst + 'T00:00:00Z')) / 86_400_000);
}
