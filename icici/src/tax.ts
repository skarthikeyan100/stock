import { TDS_RATE_PERCENT } from './constants';

export interface TaxComputation {
    tdsAmount: number;
    gstAmount: number;
    netAmount: number;
}

// Arithmetic-only per the plan's scope: individual accounts get 10% TDS
// deducted from their profit split; company accounts with a verified GST
// document go gross (no TDS). An unverified-GST company is treated as
// individual until admin verifies the document - same "verified boolean
// gates behavior" pattern already used for PAN/address/DOB. gstAmount is
// reserved for a later GST-on-payout phase and stays 0 for now.
export function computeTax(splitAmount: number, entityType: 'individual' | 'company', gstVerified: boolean): TaxComputation {
    const isGrossCompany = entityType === 'company' && gstVerified;
    const tdsAmount = isGrossCompany ? 0 : Math.round(splitAmount * (TDS_RATE_PERCENT / 100) * 100) / 100;
    return {
        tdsAmount,
        gstAmount: 0,
        netAmount: Math.round((splitAmount - tdsAmount) * 100) / 100,
    };
}
