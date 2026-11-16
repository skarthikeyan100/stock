/** Types and small pure helpers of the contractor portal (spec v2.1). */
export type ContractorType = 'INDIVIDUAL' | 'BUSINESS';
/**
 * INVITED = accepted the invite and the agreement, awaiting the owner's activation (the invite itself lives in `invites`);
 * AGREEMENT_PENDING = a new agreement version must be accepted; ACTIVE; PAUSED (owner); PAUSED_INVOICE (invoice overdue); TERMINATED.
 */
export type ContractorStatus = 'INVITED' | 'AGREEMENT_PENDING' | 'ACTIVE' | 'PAUSED' | 'PAUSED_INVOICE' | 'TERMINATED';

export const CONTRACTOR_ROLE = 'contractor';

// Only the tax identity is required to accept the agreement (PAN for an Individual, GSTIN for a Business); everything else can be completed later on the profile page.
export interface IndividualKyc {
    legalName?: string; address?: string;
    panEnc: string; bankHolder?: string; bankAccountEnc?: string; bankIfsc?: string;
    notGstRegistered: boolean;
}
export interface BusinessKyc {
    entityName?: string; address?: string;
    panEnc: string; gstinEnc: string;
    analystName?: string; analystEmail: string;
    bankHolder?: string; bankAccountEnc?: string; bankIfsc?: string;
}
/** The details still missing from a contractor's profile (shown to the owner and to the contractor). */
export function missingDetails(type: ContractorType, kyc: any, sebi?: unknown): string[] {
    const k = kyc ?? {};
    const out: string[] = [];
    const need = (v: unknown, label: string) => { if (!(typeof v === 'string' && v.trim())) out.push(label); };
    if (type === 'INDIVIDUAL') need(k.legalName, 'legal name'); else { need(k.entityName, 'entity name'); need(k.analystName, 'Research Analyst name'); }
    need(k.address, 'address'); need(k.bankAccountEnc, 'bank account'); need(k.bankIfsc, 'IFSC'); need(k.bankHolder, 'account holder');
    if (type === 'BUSINESS' && !sebi) out.push('SEBI registration');
    return out;
}
export interface SebiRegistration { number: string; validUntil: string /* YYYY-MM-DD */; verifiedAt?: Date; verifiedBy?: string; expiryAlertSentAt?: Date }

export interface Contractor {
    id: string;
    email: string;            // the session identity; for a Business contractor, the Research Analyst's email
    name: string;
    type: ContractorType;
    status: ContractorStatus;
    statusReason?: string;
    terminatedAt?: string;    // YYYY-MM-DD
    isTest?: boolean;         // the migrated test user: not counted in the cap, payouts, statements or emails
    createdAt: Date;
    activatedAt?: Date;       // first activation (pro-rates the retainer)
    feeModels?: { from: string; model: 'PROFIT_SHARE' | 'FIXED_PER_APPROVED'; sharePercent?: number; fixedAmount?: number }[]; // Advanced: effective-dated, never retroactive
    invitedBy: string;
    agreementVersion?: string;
    agreementAcceptedAt?: Date;
    agreementFile?: string;   // the personalised, signed copy accepted (storage/_agreements/...)
    agreementSha256?: string; // its SHA-256
    dpdpConsentAt?: Date;
    representation6A5At?: Date; // Business: the clause 6A.5 confirmation
    kyc?: IndividualKyc | BusinessKyc;
    sebi?: SebiRegistration;  // Business only
    pseudoUserId?: string;    // LEGACY (before 2026-11-16): the strategy slot its trades were booked under. Orders are now placed as the contractor's own user id (their email).
}

export const levelOf = (t: ContractorType): 'beginner' | 'advanced' => (t === 'INDIVIDUAL' ? 'beginner' : 'advanced');

/** The user ids a contractor's trades are booked under: their own (email), plus the legacy strategy slot of trades made before 2026-11-16. */
export const tradeUsers = (c: { email: string; pseudoUserId?: string }): string[] => [c.email, ...(c.pseudoUserId ? [c.pseudoUserId] : [])];
