/**
 * The agreement PDFs the Platform serves and hashes at acceptance. Files live in agreements/<version>/ (built by src/tools/buildAgreements.ts or
 * placed by the owner through POST /owner/agreements); the SHA-256 is computed from the file bytes at serve and at accept time, never trusted
 * from a manifest. The current version is the latest `agreementVersions` entry whose effective date has arrived (default 1.1).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Mongo from '../tools/mongo';
import { ContractorType } from './types';
import { daysUntil } from './validate';

export const AGREEMENTS_DIR = path.resolve(__dirname, '..', '..', 'agreements');
export const DEFAULT_AGREEMENT_VERSION = '1.1';
export const VERSION_RE = /^[0-9]+\.[0-9]+$/;
const FILE_FOR: Record<ContractorType, (v: string) => string> = {
    INDIVIDUAL: (v) => `Forecasting-Agreement-Individual-PAN-v${v}.pdf`,
    BUSINESS: (v) => `Forecasting-Agreement-Business-GSTIN-v${v}.pdf`,
};

export interface AgreementFile { version: string; type: ContractorType; filename: string; bytes: Buffer; sha256: string }

export function istDate(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function agreementPath(type: ContractorType, version: string): string {
    if (!VERSION_RE.test(version)) throw new Error('bad agreement version');
    return path.join(AGREEMENTS_DIR, `v${version}`, FILE_FOR[type](version));
}

export function readAgreement(type: ContractorType, version: string): AgreementFile {
    const p = agreementPath(type, version);
    const bytes = fs.readFileSync(p);
    return { version, type, filename: path.basename(p), bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function versionAvailable(version: string): boolean {
    return VERSION_RE.test(version) && (['INDIVIDUAL', 'BUSINESS'] as ContractorType[]).every((t) => fs.existsSync(agreementPath(t, version)));
}

const cmpVersion = (a: string, b: string) => { const [a1, a2] = a.split('.').map(Number), [b1, b2] = b.split('.').map(Number); return a1 - b1 || a2 - b2; };

export interface AgreementVersionDoc { version: string; effectiveDate: string; createdAt: Date; createdBy: string }

export async function listVersions(): Promise<AgreementVersionDoc[]> {
    return (await Mongo.getInstance().db.collection('agreementVersions').find({}).toArray() as AgreementVersionDoc[]).sort((a, b) => cmpVersion(a.version, b.version));
}

/** The version in force on `today` (IST): the highest whose effective date has arrived and whose files exist; the built-in default when none is recorded. */
export async function currentVersion(today = istDate()): Promise<string> {
    const eligible = (await listVersions()).filter((v) => v.effectiveDate <= today && versionAvailable(v.version));
    return eligible.length ? eligible[eligible.length - 1].version : DEFAULT_AGREEMENT_VERSION;
}

/** A version scheduled for a future date: shown to contractors from 15 days before (spec section 4). */
export async function upcomingVersion(today = istDate()): Promise<{ version: string; effectiveDate: string; daysLeft: number } | null> {
    const next = (await listVersions()).find((v) => v.effectiveDate > today && versionAvailable(v.version));
    if (!next) return null;
    const daysLeft = daysUntil(next.effectiveDate, today);
    return daysLeft <= 15 ? { version: next.version, effectiveDate: next.effectiveDate, daysLeft } : null;
}

/** Records a version (files already in agreements/v<version>/). The effective date must not be in the past. */
export async function scheduleVersion(version: string, effectiveDate: string, by: string, today = istDate()): Promise<AgreementVersionDoc> {
    if (!versionAvailable(version)) throw new Error(`agreements/v${version}/ does not hold both PDFs`);
    if (effectiveDate < today) throw new Error('effective date is in the past');
    const col = Mongo.getInstance().db.collection('agreementVersions');
    if (await col.findOne({ version })) throw new Error(`version ${version} is already recorded`);
    const doc: AgreementVersionDoc = { version, effectiveDate, createdAt: new Date(), createdBy: by };
    await col.insertOne(doc);
    return doc;
}
