/**
 * The agreement a contractor actually accepts: the v1.1 text with the Parties clause (and 3.4, Schedule 1) filled from the details they gave, signed like every
 * platform PDF and stored under storage/_agreements/<contractorId>/. The SHA-256 recorded at acceptance is the hash of THIS file. Versions uploaded by the owner as
 * plain PDFs (no built-in text) are served as they are. Spec v2.1 section 4.
 */
import * as fs from 'fs';
import * as path from 'path';
import configService from '../prism/ConfigService';
import { buildAgreementPdf, AgreementDetails } from '../agreements/agreementPdf';
import { businessDoc } from '../agreements/content/business-v1.1';
import { individualDoc } from '../agreements/content/individual-v1.1';
import { storageRoot } from '../mailStorage';
import { decryptField } from './kycCrypto';
import { istDate } from './agreements';
import { Contractor, ContractorType } from './types';
import { levelDefaultsFor } from '../user';
import { recommendationRules } from './recommendations';
import { feeCfg, feeModelOn, fixedFeeMonths, referenceInvestment } from './statements';
import { getForecastConfig } from '../forecast/rules';
import * as crypto from 'crypto';

export const BUILT_IN_VERSION = '1.1';
export const canPersonalise = (version: string) => version === BUILT_IN_VERSION;

/** The values of the Schedule that come from config: the agreement carries real numbers, never blanks. */
export function scheduleDetails(): AgreementDetails {
    const rr = recommendationRules(), fc = getForecastConfig(), fees = feeCfg();
    const fc2: any = (configService.getConfig() as any)?.forecast ?? {};
    const fixed = Number(fc2.fixedFeePerPeriod);
    const orders = fc2.orders ?? {};
    return {
        company: companyDetails(), acceptedOn: istDate(),
        profitSharePercent: levelDefaultsFor('advanced').profitSplitPercent, recHours: { start: rr.start, end: rr.end }, perDay: rr.perDay,
        fixedFee: fixed > 0 ? fixed : undefined, fixedFeeMonths: fixedFeeMonths(), referenceInvestment: referenceInvestment(),
        rules: { maxOpenPositions: Number(orders.maxOpenPositions) || 0, noNewAfter: orders.noNewAfter ? String(orders.noNewAfter) : undefined, maxInvestment: referenceInvestment(), dailyLossLimit: Number(orders.dailyLossLimit) || 0 },
        fees: { retainer: Number(fees.retainerMonthly), feePerCorrect: Number(fees.feePerCorrect), monthlyCap: Number(fees.monthlyCap), minDays: Number(fees.minParticipationDays), windowMinutes: fc.windowMinutes, neutral: fc.neutralThresholdPoints, dailyLimit: fc.dailyLimit, hours: fc.hours },
    };
}

export function companyDetails(): { name?: string; address?: string; pan?: string } {
    const c: any = (configService.getConfig() as any)?.forecast?.company ?? {};
    const t = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return { name: t(c.name), address: t(c.address), pan: t(c.pan) };
}

/** Details from what the contractor typed (plain values) while they fill in the form. */
export function detailsFromForm(type: ContractorType, name: string, k: any, fixedFeeFromStart = false): AgreementDetails {
    const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
    const base: AgreementDetails = { ...scheduleDetails(), address: String(k?.address ?? '').trim() || undefined, fixedFeeFromStart };
    if (type === 'INDIVIDUAL') return { ...base, name: String(k?.legalName ?? name ?? '').trim() || undefined, pan: up(k?.pan) || undefined };
    const gstin = up(k?.gstin);
    return { ...base, entityName: String(k?.entityName ?? '').trim() || undefined, gstin: gstin || undefined, pan: gstin.length >= 12 ? gstin.slice(2, 12) : undefined,
        analystName: String(name ?? '').trim() || undefined, sebiNumber: up(k?.sebiNumber) || undefined, sebiValidUntil: String(k?.sebiValidUntil ?? '').trim() || undefined };
}

/** Details from a stored contractor (encrypted KYC decrypted here). */
export function usesFixedFee(c: Contractor, today = istDate()): boolean { return c.type === 'BUSINESS' && feeModelOn(c.feeModels, today, 25).model === 'FIXED_PERIOD'; }

export function detailsFromContractor(c: Contractor, fixedFeeFromStart = usesFixedFee(c)): AgreementDetails {
    const k: any = c.kyc ?? {};
    const dec = (v?: string) => { try { return v ? decryptField(v) : undefined; } catch { return undefined; } };
    const base: AgreementDetails = { ...scheduleDetails(), address: k.address, fixedFeeFromStart };
    if (c.type === 'INDIVIDUAL') return { ...base, name: k.legalName ?? c.name, pan: dec(k.panEnc) };
    return { ...base, entityName: k.entityName, gstin: dec(k.gstinEnc), pan: dec(k.panEnc), 
        analystName: k.analystName ?? c.name, sebiNumber: c.sebi?.number, sebiValidUntil: c.sebi?.validUntil };
}

export async function renderPersonalised(type: ContractorType, d: AgreementDetails, date = istDate()): Promise<{ pdf: Buffer; sha256: string; filename: string }> {
    const doc = type === 'BUSINESS' ? businessDoc(d) : individualDoc(d);
    const { pdf, sha256 } = await buildAgreementPdf(doc, date);
    return { pdf, sha256, filename: `${type === 'BUSINESS' ? 'Research-Analyst-Agreement-Business-GSTIN' : 'Forecasting-Agreement-Individual-PAN'}-v${BUILT_IN_VERSION}.pdf` };
}

export const agreementDir = (contractorId: string) => path.join(storageRoot(false), '_agreements', contractorId.replace(/[^a-z0-9]/gi, '_'));

/** Builds and stores the contractor's personalised copy; returns where and its hash. Null for a version that has no built-in text. */
export async function storePersonalised(c: Contractor, d: AgreementDetails, version: string): Promise<{ file: string; sha256: string; filename: string } | null> {
    if (!canPersonalise(version)) return null;
    const r = await renderPersonalised(c.type, d);
    fs.mkdirSync(agreementDir(c.id), { recursive: true });
    const file = path.join(agreementDir(c.id), `v${version}-${r.filename}`);
    fs.writeFileSync(file, r.pdf);
    return { file, sha256: r.sha256, filename: r.filename };
}
export function readStored(file: string | undefined): Buffer | null { try { return file && fs.existsSync(file) ? fs.readFileSync(file) : null; } catch { return null; } }
export const sha256Of = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
