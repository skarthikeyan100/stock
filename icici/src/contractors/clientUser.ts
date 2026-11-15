/** What a contractor's browser may know about itself: no capital, limits, broker or any trading field (unlike toClientUser in src/user.ts). */
import { Contractor } from './types';
import { levelOf } from './types';
import { maskedField } from './kycCrypto';

export function toContractorClient(c: Contractor, extra: { agreementVersionRequired: string; upcomingAgreement?: unknown; blockedReason?: string | null }) {
    const k: any = c.kyc ?? {};
    return {
        role: 'contractor',
        id: c.id, email: c.email, name: c.name, type: c.type, level: levelOf(c.type), status: c.status, statusReason: c.statusReason,
        isTest: c.isTest === true,
        agreementVersion: c.agreementVersion, agreementVersionRequired: extra.agreementVersionRequired, upcomingAgreement: extra.upcomingAgreement ?? null,
        blockedReason: extra.blockedReason ?? null,
        kyc: c.kyc ? {
            legalName: k.legalName ?? k.entityName, address: k.address, panMasked: maskedField(k.panEnc), gstinMasked: maskedField(k.gstinEnc),
            bankAccountMasked: maskedField(k.bankAccountEnc), bankIfsc: k.bankIfsc, bankHolder: k.bankHolder,
            signatoryName: k.signatoryName, signatoryDesignation: k.signatoryDesignation,
            designatedForecasterName: k.designatedForecasterName, designatedForecasterEmail: k.designatedForecasterEmail,
            notGstRegistered: k.notGstRegistered,
        } : null,
        sebi: c.sebi ? { number: c.sebi.number, validUntil: c.sebi.validUntil, verified: !!c.sebi.verifiedAt } : null,
    };
}
