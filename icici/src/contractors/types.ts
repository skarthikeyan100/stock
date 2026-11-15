/** Types and small pure helpers of the contractor portal (spec v2.1). */
export type ContractorType = 'INDIVIDUAL' | 'BUSINESS';
/**
 * INVITED = accepted the invite and the agreement, awaiting the owner's activation (the invite itself lives in `invites`);
 * AGREEMENT_PENDING = a new agreement version must be accepted; ACTIVE; PAUSED (owner); PAUSED_INVOICE (invoice overdue); TERMINATED.
 */
export type ContractorStatus = 'INVITED' | 'AGREEMENT_PENDING' | 'ACTIVE' | 'PAUSED' | 'PAUSED_INVOICE' | 'TERMINATED';

export const CONTRACTOR_ROLE = 'contractor';

export interface IndividualKyc {
    legalName: string; address: string;
    panEnc: string; bankHolder: string; bankAccountEnc: string; bankIfsc: string;
    notGstRegistered: boolean;
}
export interface BusinessKyc {
    entityName: string; address: string;
    panEnc: string; gstinEnc: string;
    signatoryName: string; signatoryDesignation: string;
    designatedForecasterName: string; designatedForecasterEmail: string;
    bankHolder: string; bankAccountEnc: string; bankIfsc: string;
}
export interface SebiRegistration { number: string; validUntil: string /* YYYY-MM-DD */; verifiedAt?: Date; verifiedBy?: string; expiryAlertSentAt?: Date }

export interface Contractor {
    id: string;
    email: string;            // the session identity; for a Business contractor, the Designated Forecaster's email
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
    pseudoUserId: string;     // the strategy slot (Forecast-S01 / Recommendation-S01) its trades are booked under; '' until assigned at activation
}

export const levelOf = (t: ContractorType): 'beginner' | 'advanced' => (t === 'INDIVIDUAL' ? 'beginner' : 'advanced');
