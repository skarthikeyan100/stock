/**
 * Research Analyst Services Agreement, Business Research Analyst (GSTIN), v1.1. Source of the text: Business-Agreement-v1.1-amendment-text.md (the owner's
 * reviewed clauses) applied to the v1.0 PDF. Sections the amendment leaves alone (8, 10, 12, 16, 17) are v1.0 verbatim except for the consequential
 * wording changes listed in agreements/v1.1/BUILD-NOTES.md (marked there as "consequential"). The fee model (clause 6A.6, a fixed fee per Fee Period,
 * pro rata to Net Realized Profit against the Reference Investment) and Schedules 1 to 3 are the owner's change of the fallback fee.
 */
import type { AgreementDoc, AgreementDetails } from '../agreementPdf';

const ph = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export type ScheduleRow = [string, string];

/** Schedule 2 (fee) rows. Shared by the PDF and the invitation page, so the two cannot differ. */
export function feeScheduleRows(d: AgreementDetails = {}): ScheduleRow[] {
  const pct = d.profitSharePercent ?? 25;
  const months = d.fixedFeeMonths ?? 1;
  const ref = d.referenceInvestment ?? 200000;
  return [
    ['Item', 'Value'],
    ['Fee model (clause 6A)', d.fixedFeeFromStart ? 'Fixed fee per Fee Period under clause 6A.6, from the Effective Date' : 'Profit Share (or, under clause 6A.6, the fixed fee per Fee Period)'],
    ['Part payment (trial period)', d.fixedFeeFromStart ? 'Not applicable (the fixed fee applies)' : `${pct}% of net Trade Profit per Settlement Week, paid as a part payment during the trial period; the fixed fee under clause 6A.6 is the Fees`],
    ['Fee Period', `${months} month${months === 1 ? '' : 's'}, starting on the Effective Date; each following Fee Period is of the same length`],
    ['Fixed fee per Fee Period (clause 6A.6)', d.fixedFee ? `₹${d.fixedFee} for each Fee Period, paid in full when the Net Realized Profit of that Fee Period reaches the Reference Investment; pro rata below it; nil on a net loss` : 'The amount notified by Karthikeyan S in writing under Section 15 before clause 6A.6 applies'],
    ['Reference Investment', `₹${ref.toLocaleString("en-IN")}`],
    ['Payment of Fee Period amounts', 'Calculated automatically by the Platform; approved and paid manually by Karthikeyan S, in the weekly statement of the Settlement Week in which the Fee Period ends, against the invoice under Section 8'],
    ['Settlement Week', 'Wednesday to Tuesday; calculated automatically; paid manually by Karthikeyan S the following Wednesday'],
    ['Term', '6 months from the Effective Date'],
  ];
}

/** Schedule 1 (recommendation and risk rules) rows: only the limits the Platform actually applies to the Research Analyst's orders. */
export function rulesScheduleRows(d: AgreementDetails = {}): ScheduleRow[] {
  const hours = d.recHours ?? { start: '09:20', end: '15:00' };
  const r = d.rules ?? {};
  const rows: ScheduleRow[] = [
    ['Item', 'Value'],
    ['Recommendation hours', `${hours.start} to ${hours.end} IST on Trading Days`],
    ['Recommendations per day', `${d.perDay ?? 3} per Trading Day; one open at a time`],
  ];
  if (d.sebiValidUntil) rows.push(['Registration valid until', d.sebiValidUntil]);
  const capital = r.maxInvestment ?? d.referenceInvestment ?? 200000;
  const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
  rows.push(['Order size', `${inr(capital)} per Resulting Trade; as many whole lots as this buys, at least one`]);
  // the level-rule defaults (15% a day, 30% a week) when no details are given, so the standard PDF shows them too
  const dailyPct = r.dailyDrawdownPercent ?? 15, weeklyPct = r.weeklyDrawdownPercent ?? 30, allocated = r.allocatedCapital ?? 200000;
  rows.push(['Daily drawdown limit', `${dailyPct}% of the allocated capital of ${inr(allocated)} (${inr(allocated * dailyPct / 100)}): when the realized loss of the Research Analyst’s Resulting Trades in a Trading Day reaches this, no new Resulting Trade is placed until the next Trading Day`]);
  rows.push(['Weekly drawdown limit', `${weeklyPct}% of the allocated capital of ${inr(allocated)} (${inr(allocated * weeklyPct / 100)}): when the realized loss of the Research Analyst’s Resulting Trades in a Settlement Week reaches this, the Research Analyst’s account will be disabled`]);
  if (r.maxOpenPositions && r.maxOpenPositions > 0) rows.push(['Maximum open positions', `${r.maxOpenPositions} Resulting Trades open at any time, across all research analysts`]);
  if (r.noNewAfter) rows.push(['No new Resulting Trade after', `${r.noNewAfter} IST`]);
  if (r.dailyLossLimit && r.dailyLossLimit > 0) rows.push(['Daily loss limit (all research analysts)', `When the research analysts’ trades lose ₹${r.dailyLossLimit} in a day, no new Resulting Trade is placed for the rest of that day`]);
  rows.push(['Effect of the limits', 'The Platform applies the limits above to every Resulting Trade. A daily limit that is reached stops new Resulting Trades for the rest of that Trading Day; a weekly limit that is reached disables the Research Analyst’s account. The Fee Period amount then follows the realized result under clause 6A.6.']);
  return rows;
}

/** The Business agreement; `d` fills the Parties clause, 3.4 and Schedules 1 and 2 once the research analyst has given the details (anything missing stays a placeholder). */
export function businessDoc(d: AgreementDetails = {}): AgreementDoc {
  const co = d.company ?? {};
  // Nothing is left blank: a detail the research analyst has not given yet is simply not mentioned.
  const analyst = ph(d.analystName, 'the representative named on the Platform');
  const ids = [d.pan ? `PAN ${d.pan}` : '', d.gstin ? `GSTIN ${d.gstin}` : ''].filter(Boolean).join('; ');
  const contractorParty = d.entityName
    ? `${d.entityName}${ids ? ` (${ids})` : ''}, acting through ${analyst}, its Research Analyst`
    : `${analyst}${ids ? ` (${ids})` : ''}, a Research Analyst`;
  const months = d.fixedFeeMonths ?? 1;
  return {
    title: 'Research Analyst Services Agreement',
    kind: 'Business Research Analyst (GSTIN)',
    version: '1.1',
    cover: 'Version 1.1 · November 2026 · Research Portal · By invitation only',
    blocks: [
        { t: 'h2', text: '1. Parties' },
        { t: 'p', text: 'This Agreement is between:' },
        { t: 'li', text: `${ph(co.name, 'Karthikeyan S')}, an individual resident in Chennai, Tamil Nadu, carrying on business under the name “Nivedha Tech”; and` },
        { t: 'li', text: `The Research Analyst: ${contractorParty} (the “Research Analyst”). The Research Analyst is registered with the Securities and Exchange Board of India as a research analyst${d.sebiNumber ? `, registration number ${d.sebiNumber}${d.sebiValidUntil ? `, valid until ${d.sebiValidUntil}` : ''}` : ''} (the “Registration”).` },
        { t: 'p', text: 'This Agreement takes effect when the Research Analyst accepts it electronically on the Platform after receiving a personal invitation from Karthikeyan S (the “Effective Date”). Electronic acceptance is valid under the Information Technology Act, 2000. Access to the Platform is by personal invitation only; no person may participate without an accepted copy of this Agreement.' },

        { t: 'h2', text: '2. Definitions' },
        { t: 'li', text: '“Platform” means Karthikeyan S’s web application at nivedhatech.com.' },
        { t: 'li', text: '“Recommendation” means a research recommendation submitted by the Research Analyst on the Platform for a NIFTY index option, stating the contract (strike, CE or PE), an entry price, a target price and a stop-loss price.' },
        { t: 'li', text: '“Approved Recommendation” means a Recommendation Karthikeyan S has approved on the Platform. A Recommendation Karthikeyan S rejects, or does not act on by the end of the day, is not an Approved Recommendation.' },
        { t: 'li', text: '“Resulting Trade” means the trade, if any, that Karthikeyan S places in its own account because of an Approved Recommendation.' },
        { t: 'li', text: '“Trade Profit” means, for each Resulting Trade, the exit value minus the entry value of that trade for the contract concerned, before taxes, but after Karthikeyan S’s brokerage and statutory charges on that trade, as recorded in Karthikeyan S’s trade records. A loss is a “Trade Loss”.' },
        { t: 'li', text: '“Profit Share” means the percentage in Schedule 2 of the net Trade Profit for a Settlement Week, as defined in clause 6A.1.' },
        { t: 'li', text: '“Settlement Week” means Wednesday to the following Tuesday (both days included).' },
        { t: 'li', text: '“Fee Period” means the period stated in Schedule 2 (one month unless Schedule 2 states otherwise), starting on the Effective Date, and each following period of the same length.' },
        { t: 'li', text: '“Net Realized Profit” means, for a Fee Period, the total of the Trade Profit less the Trade Losses of all Resulting Trades closed in that Fee Period, as recorded in Karthikeyan S’s trade records.' },
        { t: 'li', text: '“Reference Investment” means the amount stated in Schedule 2.' },
        { t: 'li', text: '“Trading Day” means a day on which the National Stock Exchange of India holds a normal trading session.' },
        { t: 'li', text: '“Fees” means the Profit Share, or the fixed fee per Fee Period under clause 6A.6, as applicable.' },

        { t: 'h2', text: '3. Nature of the Engagement' },
        { t: 'num', n: '3.1', text: 'The Research Analyst is engaged as an independent service provider to provide research recommendations. Nothing in this Agreement creates an employment, partnership, joint venture, agency or investment-management relationship.' },
        { t: 'num', n: '3.2', text: 'The Research Analyst is not a client of Karthikeyan S, invests no money, holds no interest in Karthikeyan S’s account or capital, and does not share in any loss. The Research Analyst’s only entitlement is the Fees under Section 6A.' },
        { t: 'num', n: '3.3', text: 'The Research Analyst has no authority to place, direct, modify, approve or cancel any order, no access to any broker or trading account of Karthikeyan S, and no authority to bind Karthikeyan S.' },
        { t: 'num', n: '3.4', text: `The Research Analyst shall provide the services through its representative${d.analystName ? `, ${d.analystName},` : ''} who must hold a separate personal invitation to the Platform. The Research Analyst may not change that representative without Karthikeyan S’s written consent and is responsible for that person’s compliance with this Agreement.` },

        { t: 'h2', text: '4. The Services' },
        { t: 'num', n: '4.1', text: 'The Research Analyst will submit Recommendations on the Platform. Each Recommendation must be the Research Analyst’s own research, prepared in compliance with the SEBI (Research Analysts) Regulations, 2014 and any circulars issued under them, and with the disclosures, records and rationale those rules require.' },
        { t: 'num', n: '4.2', text: 'A Recommendation is valid only if the stop-loss is below the entry price and the entry price is below the target, and it is made for a contract not already traded that day. The Research Analyst may have one open Recommendation at a time, and may submit Recommendations only during the Recommendation hours and up to the daily number stated in Schedule 1.' },
        { t: 'num', n: '4.3', text: 'A Recommendation cannot be edited or withdrawn once recorded, but it lapses at the end of the day if not approved.' },
        { t: 'num', n: '4.4', text: 'The Research Analyst must not access the Platform through bots or scripts without Karthikeyan S’s written consent.' },

        { t: 'h2', text: '5. How Karthikeyan S Uses Recommendations' },
        { t: 'num', n: '5.1', text: 'Karthikeyan S decides. Karthikeyan S reviews every Recommendation and may approve or reject it, with or without giving reasons, in its sole discretion. Karthikeyan S has no obligation to approve, to trade on, or to continue trading on any Recommendation.' },
        { t: 'num', n: '5.2', text: 'Karthikeyan S controls execution. Only Karthikeyan S places orders, in its own account with its own capital and its own broker. The Research Analyst never places, modifies or cancels an order, and has no access to Karthikeyan S’s broker or account.' },
        { t: 'num', n: '5.3', text: 'Recommendations are one input. Karthikeyan S may combine a Recommendation with its own analysis and risk limits, may exit a Resulting Trade at any time, and applies the limits in Schedule 1 to every Resulting Trade.' },

        { t: 'h2', text: '5A. What the Research Analyst Can See' },
        { t: 'num', n: '5A.1', text: 'The Platform shows the Research Analyst, read-only: its own Recommendations and their status; and, for each of its own Resulting Trades, the entry price and the live profit or loss.' },
        { t: 'num', n: '5A.2', text: 'The Research Analyst cannot see Karthikeyan S’s broker, account balances, capital, order details, or any trade that did not result from the Research Analyst’s own Approved Recommendations, and has no control over any trade.' },
        { t: 'num', n: '5A.3', text: 'Information visible to the Research Analyst is confidential under Section 10. Its visibility does not give the Research Analyst any interest in, or right over, any trade or position.' },

        { t: 'h2', text: '6. Fees' },
        { t: 'p', text: 'The Research Analyst is paid solely as described in Section 6A.' },

        { t: 'h2', text: '6A. Fees' },
        { t: 'num', n: '6A.1', text: 'Profit Share. For each Settlement Week Karthikeyan S will pay the Research Analyst the Profit Share percentage in Schedule 2 of the net Trade Profit of all Resulting Trades of that Research Analyst that were closed in that week, where net Trade Profit is the total of the Trade Profit of those trades after setting off Trade Losses of the same week and any loss carried forward under clause 6A.2.' },
        { t: 'num', n: '6A.2', text: 'Carry-forward of losses. If the net result of a Settlement Week is zero or a loss, no Profit Share is payable for that week. A loss is carried forward and set off against the Trade Profit of the following Settlement Weeks, so that Profit Share is payable only on the net Trade Profit remaining after the carried-forward loss has been recovered. A carried-forward loss never reduces any amount already paid, and no amount is ever payable by the Research Analyst to Karthikeyan S, and nothing is deducted from the Research Analyst for any loss.' },
        { t: 'num', n: '6A.3', text: 'Calculation and payment. The Platform calculates the Profit Share for each Settlement Week automatically and shows it in the Research Analyst’s statement. Karthikeyan S then reviews and approves that statement, and pays the approved amount by bank transfer manually, on the Wednesday after the Settlement Week or the next working day, against the invoice required in Section 8, subject to tax under Section 8. No payment is made automatically.' },
        { t: 'num', n: '6A.4', text: 'Records. The Profit Share is computed from Karthikeyan S’s own trade records. The Platform will show the Research Analyst a statement for each Settlement Week. The Research Analyst must raise any disagreement within 15 days of the payment, and the parties will review the records together in good faith.' },
        { t: 'num', n: '6A.5', text: 'Research Analyst’s representation about its Registration. The Research Analyst represents and confirms that: (a) the Registration is valid, and it will tell Karthikeyan S within 3 days if it lapses, is suspended or is cancelled; (b) it has checked its Registration conditions, the SEBI (Research Analysts) Regulations and any SEBI circular on research analyst fees, and its own compliance function (or compliance officer, where it has one) has confirmed that receiving the Profit Share under this Agreement is permitted for the Research Analyst; and (c) it will tell Karthikeyan S at once if that position changes. If the Research Analyst does not give this confirmation when accepting this Agreement, clause 6A.6 applies from the Effective Date and no Profit Share is payable.' },
        { t: 'num', n: '6A.6', text: `Fixed fee per Fee Period. If the Research Analyst or Karthikeyan S concludes that the Profit Share is not permitted for the Research Analyst, or Karthikeyan S gives 15 days’ notice under Section 15, the Fees will instead be a fixed fee for each Fee Period. For each Fee Period the fixed fee is the fixed amount stated in Schedule 2 multiplied by the Net Realized Profit of that Fee Period divided by the Reference Investment, and never more than the fixed amount. It is therefore paid in full when the Net Realized Profit reaches the Reference Investment, pro rata when it is below the Reference Investment, and nothing is payable for a Fee Period whose Net Realized Profit is zero or a loss. A loss is not carried forward to any later Fee Period. Where the Agreement starts or ends part-way through a Fee Period, the fixed amount is pro-rated by the number of days of that Fee Period on which the Research Analyst was under this Agreement. The Platform calculates the fixed fee for a Fee Period automatically and shows it in the statement of the Settlement Week in which that Fee Period ends; Karthikeyan S approves and pays it manually, as in clause 6A.3, and no payment is made automatically. Nothing is ever payable by the Research Analyst. The change applies only to Fee Periods starting after it takes effect and does not alter any statement already issued.` },
        { t: 'num', n: '6A.7', text: 'Karthikeyan S’s rights. Karthikeyan S may suspend Recommendations at any time. If the Registration is not valid, no Recommendation is accepted, and no Fee accrues for Recommendations made while it was invalid.' },

        { t: 'h2', text: '7. No Payment, Deposit or Stake by the Research Analyst' },
        { t: 'p', text: 'The Research Analyst will never be asked to pay any fee, subscription, deposit, security, entry or evaluation charge, and will never bear any loss, to participate in or under this Agreement. Nothing in this Agreement is a game, wager or bet: the Research Analyst stakes nothing and is paid only for a service. This Section applies equally to Trade Losses: the Research Analyst bears no loss under this Agreement.' },

        { t: 'h2', text: '8. Taxes and Invoicing' },
        { t: 'li', text: 'Karthikeyan S will deduct tax at source from the Fees at the rate applicable under the Income-tax Act, 2025, on the value excluding GST, and will issue the TDS certificates required by law.' },
        { t: 'li', text: 'The Research Analyst is responsible for its own income tax and GST, including charging GST correctly.' },
        { t: 'li', text: 'Invoice for every payment. The Research Analyst must issue a valid GST tax invoice to Karthikeyan S for every payment within 2 days of receiving it (by end of day, India time), containing at least the items in Schedule 3.' },
        { t: 'li', text: 'If an invoice is not received by then, Karthikeyan S may pause the Research Analyst’s access to the Platform until the invoice is received. Fees already earned are not affected.' },

        { t: 'h2', text: '9. Research Analyst Undertakings' },
        { t: 'p', text: 'During the term of this Agreement the Research Analyst shall:' },
        { t: 'num', n: '9.1', text: 'provide accurate identity, PAN, GSTIN, address, bank and Registration details, and keep them up to date;' },
        { t: 'num', n: '9.2', text: 'keep its Registration valid and comply with the SEBI (Research Analysts) Regulations in preparing Recommendations;' },
        { t: 'num', n: '9.3', text: 'not share its Platform login, and report any unauthorised use immediately;' },
        { t: 'num', n: '9.4', text: 'not use any non-public information about Karthikeyan S or the Platform for its own trading or for anyone else’s;' },
        { t: 'num', n: '9.5', text: 'not describe itself as associated with, or endorsed by, Karthikeyan S’s broker.' },
        { t: 'p', text: 'Each party is responsible for its own compliance with applicable law, including any registration the law may require.' },

        { t: 'h2', text: '10. Confidentiality' },
        { t: 'p', text: 'The Research Analyst shall keep confidential all non-public information about Karthikeyan S, the Platform, its software, scoring methods and business, and shall use it only to perform the Services. This obligation continues for two years after this Agreement ends. It does not apply to information that is public through no fault of the Research Analyst or that must be disclosed by law.' },

        { t: 'h2', text: '11. Intellectual Property' },
        { t: 'p', text: 'The Platform and all its software and content belong to Karthikeyan S. The Research Analyst grants Karthikeyan S a perpetual, royalty-free right to use, store and analyse all Recommendations submitted under this Agreement for Karthikeyan S’s own business.' },

        { t: 'h2', text: '12. Personal Data' },
        { t: 'p', text: 'Karthikeyan S collects the Research Analyst’s name, contact details, PAN, GSTIN, Registration details, address, bank details and Platform activity only to perform this Agreement, pay Fees and meet tax and legal obligations. The Research Analyst consents to this processing under the Digital Personal Data Protection Act, 2023. Karthikeyan S will store this data securely, keep it no longer than the law requires, and not sell or share it except with its bank, tax authorities or as required by law. Requests to access or correct data can be sent to admin@nivedhatech.com.' },

        { t: 'h2', text: '13. Term and Termination' },
        { t: 'li', text: 'This Agreement runs for the Term in Schedule 2: 6 months from the Effective Date.' },
        { t: 'li', text: 'Karthikeyan S may end it immediately by email if the Research Analyst breaches Section 4, 9 or 10, or provided false information during onboarding.' },
        { t: 'li', text: 'Karthikeyan S may end this Agreement immediately by email if the Registration lapses, is suspended or cancelled, or if the representation in clause 6A.5 is untrue.' },
        { t: 'li', text: 'When this Agreement ends, Karthikeyan S will pay the Fees earned up to the end date (including any Fee Period amount, pro-rated under clause 6A.6), and Platform access will end. Sections 6 and 6A (for Fees earned), 8, 10, 11, 12, 14 and 16 continue to apply.' },

        { t: 'h2', text: '14. Liability' },
        { t: 'li', text: 'The Research Analyst is never liable for any trading loss of Karthikeyan S.' },
        { t: 'li', text: 'Karthikeyan S’s total liability under this Agreement is limited to Fees earned and not yet paid.' },
        { t: 'li', text: 'Neither party is liable for indirect or consequential loss.' },
        { t: 'li', text: 'The Research Analyst is liable for loss caused by its breach of Section 9 or 10.' },

        { t: 'h2', text: '15. Changes' },
        { t: 'p', text: 'Karthikeyan S may change this Agreement or Schedules 1 and 2 by giving at least 15 days’ notice by email. The Research Analyst may end this Agreement before the change takes effect without penalty. A change to Fees never applies to any Fee Period, or to any Recommendation, before the change takes effect.' },

        { t: 'h2', text: '16. Disputes and Governing Law' },
        { t: 'p', text: 'This Agreement is governed by the laws of India. The parties will first try to resolve any dispute through good-faith discussion for 15 days. Unresolved disputes will be decided by a sole arbitrator appointed by mutual agreement under the Arbitration and Conciliation Act, 1996, with the seat of arbitration at Chennai and proceedings in English. Subject to this, the courts at Chennai have exclusive jurisdiction.' },

        { t: 'h2', text: '17. General' },
        { t: 'li', text: 'This Agreement, with its Schedules, is the entire agreement between the parties on its subject.' },
        { t: 'li', text: 'If any provision is invalid, the rest remains in force.' },
        { t: 'li', text: 'Notices are given by email to the addresses recorded on the Platform (for Karthikeyan S: admin@nivedhatech.com).' },
        { t: 'li', text: 'The Research Analyst may not assign this Agreement.' },

        { t: 'h2', text: 'Schedule 1 – Recommendation and Risk Rules' },
        { t: 'table', rows: rulesScheduleRows(d) },

        { t: 'h2', text: 'Schedule 2 – Fee Schedule' },
        { t: 'table', rows: feeScheduleRows(d) },

        { t: 'h2', text: 'Schedule 3 – Invoice Requirements' },
        { t: 'p', text: 'Each tax invoice must contain at least:' },
        { t: 'li', text: 'Research Analyst’s legal name, address, PAN and GSTIN;' },
        { t: 'li', text: 'invoice number (unique, serial) and date, and place of supply;' },
        { t: 'li', text: 'bill-to: Karthikeyan S, trading as Nivedha Tech, address and PAN;' },
        { t: 'li', text: `description: “Research recommendation services under the Research Analyst Services Agreement accepted on ${d.acceptedOn ?? 'the date of acceptance'}, for the period shown in the Platform statement”;` },
        { t: 'li', text: 'SAC code (to be chosen by the Research Analyst’s accountant);' },
        { t: 'li', text: `breakdown: the Profit Share for the Settlement Week(s) concerned, or the fixed fee for the ${months}-month Fee Period(s) concerned under clause 6A.6, as shown in the Platform statement;` },
        { t: 'li', text: 'taxable value, GST shown separately (CGST + SGST, or IGST), and invoice total;' },
        { t: 'li', text: 'the line “TDS under the Income-tax Act, 2025 applicable on taxable value”;' },
        { t: 'li', text: 'bank details and authorised signature.' },

    ],
  };
}

/** The rows the invitation page shows: Schedules 1 and 2 as one table (the section rows are headings). */
export function invitationScheduleRows(d: AgreementDetails = {}): { section?: string; item?: string; value?: string }[] {
  const fee = feeScheduleRows(d).slice(1).map(([item, value]) => ({ item, value }));
  const rules = rulesScheduleRows(d).slice(1).map(([item, value]) => ({ item, value }));
  return [{ section: 'Schedule 1 – Recommendation and Risk Rules' }, ...rules, { section: 'Schedule 2 – Fee Schedule' }, ...fee];
}

export const BUSINESS_V1_1: AgreementDoc = businessDoc();
