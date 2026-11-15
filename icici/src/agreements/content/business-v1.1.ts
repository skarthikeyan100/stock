/**
 * Forecasting Services Agreement, Business Contractor (GSTIN), v1.1. Source of the text: Business-Agreement-v1.1-amendment-text.md (the owner's
 * reviewed clauses) applied to the v1.0 PDF. Sections the amendment leaves alone (8, 10, 12, 16, 17 and Schedule 2) are v1.0 verbatim except for
 * the consequential wording changes listed in agreements/v1.1/BUILD-NOTES.md (marked there as "consequential").
 */
import type { AgreementDoc } from '../agreementPdf';

export const BUSINESS_V1_1: AgreementDoc = {
    kind: 'Business Contractor (GSTIN)',
    version: '1.1',
    cover: 'Version 1.1 · November 2026 · Pilot programme · By invitation only',
    blocks: [
        { t: 'h2', text: '1. Parties' },
        { t: 'p', text: 'This Agreement is between:' },
        { t: 'li', text: 'The Company: [Full legal name], an individual resident at [address], Chennai, Tamil Nadu, carrying on business under the name “Nivedha Tech” (PAN: [__________]) (the “Company”); and' },
        { t: 'li', text: 'The Contractor: [Legal name of company / LLP / firm], registered office [address] (PAN [__________]; GSTIN [__________]), acting through its authorised signatory [name, designation] (the “Contractor”). The Contractor is registered with the Securities and Exchange Board of India as a Research Analyst, registration number INH[_________], valid until [date] (the “Registration”).' },
        { t: 'p', text: 'This Agreement takes effect when both parties sign it, or when the Contractor accepts it electronically on the Platform after receiving a personal invitation from the Company (the “Effective Date”). Electronic acceptance is valid under the Information Technology Act, 2000. Access to the Platform is by personal invitation only; no person may participate without an executed or accepted copy of this Agreement.' },

        { t: 'h2', text: '2. Definitions' },
        { t: 'li', text: '“Platform” means the Company’s web application at nivedhatech.com.' },
        { t: 'li', text: '“Recommendation” means a research recommendation submitted by the Contractor on the Platform for a NIFTY index option, stating the contract (strike, CE or PE), an entry price, a target price and a stop-loss price.' },
        { t: 'li', text: '“Approved Recommendation” means a Recommendation the Company has approved on the Platform. A Recommendation the Company rejects, or does not act on by the end of the day, is not an Approved Recommendation.' },
        { t: 'li', text: '“Resulting Trade” means the trade, if any, that the Company places in its own account because of an Approved Recommendation.' },
        { t: 'li', text: '“Trade Profit” means, for each Resulting Trade, the exit value minus the entry value of that trade for the contract concerned, before taxes, but after the Company’s brokerage and statutory charges on that trade, as recorded in the Company’s trade records. A loss is a “Trade Loss”.' },
        { t: 'li', text: '“Profit Share” means the percentage in Schedule 1 of the net Trade Profit for a Settlement Week, as defined in clause 6A.1.' },
        { t: 'li', text: '“Settlement Week” means Wednesday to the following Tuesday (both days included).' },
        { t: 'li', text: '“Trading Day” means a day on which the National Stock Exchange of India holds a normal trading session.' },
        { t: 'li', text: '“Fees” means the Profit Share (or, where clause 6A.6 applies, the fixed fee per Approved Recommendation) and any Retainer stated in Schedule 1.' },

        { t: 'h2', text: '3. Nature of the Engagement' },
        { t: 'num', n: '3.1', text: 'The Contractor is engaged as an independent contractor to provide research recommendations. Nothing in this Agreement creates an employment, partnership, joint venture, agency or investment-management relationship.' },
        { t: 'num', n: '3.2', text: 'The Contractor is not a client of the Company, invests no money, holds no interest in the Company’s account or capital, and does not share in any loss. The Contractor’s only entitlement is the Fees under Section 6A.' },
        { t: 'num', n: '3.3', text: 'The Contractor has no authority to place, direct, modify, approve or cancel any order, no access to any broker or trading account of the Company, and no authority to bind the Company.' },
        { t: 'num', n: '3.4', text: 'The Contractor shall provide the services through one designated individual, [name] (the “Designated Forecaster”), who must hold a separate personal invitation to the Platform. The Contractor may not change that person without the Company’s written consent and is responsible for that person’s compliance with this Agreement.' },

        { t: 'h2', text: '4. The Services' },
        { t: 'num', n: '4.1', text: 'The Contractor will submit Recommendations on the Platform. Each Recommendation must be the Contractor’s own research, prepared in compliance with the SEBI (Research Analysts) Regulations, 2014 and any circulars issued under them, and with the disclosures, records and rationale those rules require.' },
        { t: 'num', n: '4.2', text: 'A Recommendation is valid only if the stop-loss is below the entry price and the entry price is below the target, and it is made for a contract not already traded that day. The Contractor may have one open Recommendation at a time, and may submit Recommendations only during the Recommendation hours and up to the daily number stated in Schedule 1.' },
        { t: 'num', n: '4.3', text: 'The Contractor must not copy, resell or relay calls from third parties.' },
        { t: 'num', n: '4.4', text: 'A Recommendation cannot be edited or withdrawn once recorded, but it lapses at the end of the day if not approved.' },
        { t: 'num', n: '4.5', text: 'The Contractor must not access the Platform through bots or scripts without the Company’s written consent.' },

        { t: 'h2', text: '5. How the Company Uses Recommendations' },
        { t: 'num', n: '5.1', text: 'The Company decides. The Company reviews every Recommendation and may approve or reject it, with or without giving reasons, in its sole discretion. The Company has no obligation to approve, to trade on, or to continue trading on any Recommendation.' },
        { t: 'num', n: '5.2', text: 'The Company controls execution. Only the Company places orders, in its own account with its own capital and its own broker. The Contractor never places, modifies or cancels an order, and has no access to the Company’s broker or account.' },
        { t: 'num', n: '5.3', text: 'Recommendations are one input. The Company may combine a Recommendation with its own analysis and risk limits, and may exit a Resulting Trade at any time.' },

        { t: 'h2', text: '5A. What the Contractor Can See' },
        { t: 'num', n: '5A.1', text: 'The Platform shows the Contractor, read-only: its own Recommendations and their status; and, for each of its own Resulting Trades, the entry price and the live profit or loss.' },
        { t: 'num', n: '5A.2', text: 'The Contractor cannot see the Company’s broker, account balances, capital, order details, or any trade that did not result from the Contractor’s own Approved Recommendations, and has no control over any trade.' },
        { t: 'num', n: '5A.3', text: 'Information visible to the Contractor is confidential under Section 10. Its visibility does not give the Contractor any interest in, or right over, any trade or position.' },

        { t: 'h2', text: '6. Fees' },
        { t: 'p', text: 'The Contractor is paid solely as described in Section 6A. There is no retainer under this version unless Schedule 1 states one.' },

        { t: 'h2', text: '6A. Fee on Approved Recommendations' },
        { t: 'num', n: '6A.1', text: 'Profit Share. For each Settlement Week the Company will pay the Contractor the Profit Share percentage in Schedule 1 of the net Trade Profit of all Resulting Trades of that Contractor that were closed in that week, where net Trade Profit is the total of the Trade Profit of those trades after setting off Trade Losses of the same week.' },
        { t: 'num', n: '6A.2', text: 'No carry-forward, no clawback. If the net result of a Settlement Week is zero or a loss, no Profit Share is payable for that week. A loss in one week is never carried forward and never reduces any Profit Share for another week or any amount already paid. No amount is ever payable by the Contractor to the Company, and nothing is deducted from the Contractor for any loss.' },
        { t: 'num', n: '6A.3', text: 'Payment. The Company will pay the Profit Share by bank transfer on the Wednesday after the Settlement Week, or the next working day, against the invoice required in Section 8, subject to tax under Section 8.' },
        { t: 'num', n: '6A.4', text: 'Records. The Profit Share is computed from the Company’s own trade records. The Platform will show the Contractor a statement for each Settlement Week. The Contractor must raise any disagreement within 15 days of the payment, and the parties will review the records together in good faith.' },
        { t: 'num', n: '6A.5', text: 'Contractor’s representation about its Registration. The Contractor represents and confirms that: (a) the Registration is valid, and it will tell the Company within 3 days if it lapses, is suspended or is cancelled; (b) it has checked its Registration conditions, the SEBI (Research Analysts) Regulations and any SEBI circular on research analyst fees, and its own compliance function (or compliance officer, where it has one) has confirmed that receiving the Profit Share under this Agreement is permitted for the Contractor; and (c) it will tell the Company at once if that position changes.' },
        { t: 'num', n: '6A.6', text: 'Change of fee model. If the Contractor or the Company concludes that the Profit Share is not permitted for the Contractor, or the Company gives 15 days’ notice under Section 15, the Fees will instead be the fixed fee per Approved Recommendation stated in Schedule 1, which is not linked to any Trade Profit or Trade Loss. The change applies only to Recommendations approved after it takes effect and does not alter any statement already issued.' },
        { t: 'num', n: '6A.7', text: 'Company’s rights. The Company may suspend Recommendations at any time. If the Registration is not valid, no Recommendation is accepted, and no Fee accrues for Recommendations made while it was invalid.' },

        { t: 'h2', text: '7. No Payment, Deposit or Stake by the Contractor' },
        { t: 'p', text: 'The Contractor will never be asked to pay any fee, subscription, deposit, security, entry or evaluation charge, and will never bear any loss, to participate in or under this Agreement. Nothing in this Agreement is a game, wager or bet: the Contractor stakes nothing and is paid only for a service. This Section applies equally to Trade Losses: the Contractor bears no loss under this Agreement.' },

        { t: 'h2', text: '8. Taxes and Invoicing' },
        { t: 'li', text: 'The Company will deduct tax at source from the Fees at the rate applicable under the Income-tax Act, 2025, on the value excluding GST, and will issue the TDS certificates required by law.' },
        { t: 'li', text: 'The Contractor is responsible for its own income tax and GST, including charging GST correctly.' },
        { t: 'li', text: 'Invoice for every payment. The Contractor must issue a valid GST tax invoice to the Company for every payment within 2 days of receiving it (by end of day, India time), containing at least the items in Schedule 2.' },
        { t: 'li', text: 'If an invoice is not received by then, the Company may pause the Contractor’s access to the Platform until the invoice is received. Fees already earned are not affected.' },

        { t: 'h2', text: '9. Contractor Undertakings' },
        { t: 'p', text: 'During the term of this Agreement the Contractor shall:' },
        { t: 'num', n: '9.1', text: 'provide accurate identity, PAN, GSTIN, address, bank and Registration details, and keep them up to date;' },
        { t: 'num', n: '9.2', text: 'keep its Registration valid and comply with the SEBI (Research Analysts) Regulations in preparing Recommendations;' },
        { t: 'num', n: '9.3', text: 'not give the same Recommendation to another person for the purpose of the Company’s trade, and not execute, or ask anyone to execute, any trade in the Company’s account;' },
        { t: 'num', n: '9.4', text: 'not share its Platform login, and report any unauthorised use immediately;' },
        { t: 'num', n: '9.5', text: 'not use any non-public information about the Company or the Platform for its own trading or for anyone else’s;' },
        { t: 'num', n: '9.6', text: 'not describe itself as associated with, or endorsed by, the Company’s broker.' },
        { t: 'p', text: 'Each party is responsible for its own compliance with applicable law, including any registration the law may require.' },

        { t: 'h2', text: '10. Confidentiality' },
        { t: 'p', text: 'The Contractor shall keep confidential all non-public information about the Company, the Platform, its software, scoring methods and business, and shall use it only to perform the Services. This obligation continues for two years after this Agreement ends. It does not apply to information that is public through no fault of the Contractor or that must be disclosed by law.' },

        { t: 'h2', text: '11. Intellectual Property' },
        { t: 'p', text: 'The Platform and all its software and content belong to the Company. The Contractor grants the Company a perpetual, royalty-free right to use, store and analyse all Recommendations submitted under this Agreement for the Company’s own business.' },

        { t: 'h2', text: '12. Personal Data' },
        { t: 'p', text: 'The Company collects the Contractor’s name, contact details, PAN, GSTIN, Registration details, address, bank details and Platform activity only to perform this Agreement, pay Fees and meet tax and legal obligations. The Contractor consents to this processing under the Digital Personal Data Protection Act, 2023. The Company will store this data securely, keep it no longer than the law requires, and not sell or share it except with its bank, tax authorities or as required by law. Requests to access or correct data can be sent to admin@nivedhatech.com.' },

        { t: 'h2', text: '13. Term and Termination' },
        { t: 'li', text: 'This Agreement runs for the Pilot Term in Schedule 1 and then continues month to month.' },
        { t: 'li', text: 'Either party may end it at any time by giving 7 days’ notice by email.' },
        { t: 'li', text: 'The Company may end it immediately by email if the Contractor breaches Section 4, 9 or 10, or provided false information during onboarding.' },
        { t: 'li', text: 'The Company may end this Agreement immediately by email if the Registration lapses, is suspended or cancelled, or if the representation in clause 6A.5 is untrue.' },
        { t: 'li', text: 'When this Agreement ends, the Company will pay the Fees earned up to the end date (and any Retainer, pro-rated), and Platform access will end. Sections 6 and 6A (for Fees earned), 8, 10, 11, 12, 14 and 16 continue to apply.' },

        { t: 'h2', text: '14. Liability' },
        { t: 'li', text: 'The Contractor is never liable for any trading loss of the Company.' },
        { t: 'li', text: 'The Company’s total liability under this Agreement is limited to Profit Share earned and not yet paid.' },
        { t: 'li', text: 'Neither party is liable for indirect or consequential loss.' },
        { t: 'li', text: 'The Contractor is liable for loss caused by its breach of Section 9 or 10.' },

        { t: 'h2', text: '15. Changes' },
        { t: 'p', text: 'The Company may change this Agreement or Schedule 1 by giving at least 15 days’ notice by email. The Contractor may end this Agreement before the change takes effect without penalty. A change to Fees never applies to Recommendations approved before the change takes effect.' },

        { t: 'h2', text: '16. Disputes and Governing Law' },
        { t: 'p', text: 'This Agreement is governed by the laws of India. The parties will first try to resolve any dispute through good-faith discussion for 15 days. Unresolved disputes will be decided by a sole arbitrator appointed by mutual agreement under the Arbitration and Conciliation Act, 1996, with the seat of arbitration at Chennai and proceedings in English. Subject to this, the courts at Chennai have exclusive jurisdiction.' },

        { t: 'h2', text: '17. General' },
        { t: 'li', text: 'This Agreement, with its Schedules, is the entire agreement between the parties on its subject.' },
        { t: 'li', text: 'If any provision is invalid, the rest remains in force.' },
        { t: 'li', text: 'Notices are given by email to the addresses recorded on the Platform (for the Company: admin@nivedhatech.com).' },
        { t: 'li', text: 'The Contractor may not assign this Agreement.' },

        { t: 'h2', text: 'Schedule 1 – Fee and Recommendation Schedule' },
        { t: 'table', rows: [
            ['Item', 'Value'],
            ['Fee model (clause 6A)', 'Profit Share [switch to “Fixed fee per Approved Recommendation” under clause 6A.6]'],
            ['Profit Share', '[25]% of net Trade Profit per Settlement Week'],
            ['Fixed fee per Approved Recommendation (only under clause 6A.6)', '₹[_____]'],
            ['Retainer', 'None [or ₹[_____] per month]'],
            ['Settlement Week', 'Wednesday to Tuesday; paid the following Wednesday'],
            ['Recommendation hours', '[09:20] to [15:00] IST on Trading Days'],
            ['Recommendations per day', '[1] per Trading Day; one open at a time'],
            ['Registration valid until', '[date]'],
            ['Pilot Term', '[3] months, then month to month'],
        ] },

        { t: 'h2', text: 'Schedule 2 – Invoice Requirements' },
        { t: 'p', text: 'Each tax invoice must contain at least:' },
        { t: 'li', text: 'Contractor’s legal name, address, PAN and GSTIN;' },
        { t: 'li', text: 'invoice number (unique, serial) and date, and place of supply;' },
        { t: 'li', text: 'bill-to: [Company’s full legal name], trading as Nivedha Tech, address and PAN;' },
        { t: 'li', text: 'description: “Research recommendation services under Forecasting Services Agreement dated [__], period [__] to [__]”;' },
        { t: 'li', text: 'SAC code (to be chosen by the Contractor’s accountant);' },
        { t: 'li', text: 'breakdown: the Profit Share for the Settlement Week(s) concerned (or the number of Approved Recommendations × the fixed fee, where clause 6A.6 applies), as shown in the Platform statement;' },
        { t: 'li', text: 'taxable value, GST shown separately (CGST + SGST, or IGST), and invoice total;' },
        { t: 'li', text: 'the line “TDS under the Income-tax Act, 2025 applicable on taxable value”;' },
        { t: 'li', text: 'bank details and authorised signature.' },

        { t: 'h2', text: 'Signatures' },
        { t: 'sig', left: ['For the Company', 'Name: [__________________]', 'Signature: __________________', 'Date: __________'], right: ['For the Contractor', 'Name of signatory: [__________]', 'Designation: [__________]', 'Signature: __________________', 'Date: __________'] },
        { t: 'p', text: 'Signed for the Contractor by [name, designation]. Date: [____]. Or accepted electronically on the Platform, with the clause 6A.5 confirmation ticked: the Contractor’s email, timestamp, IP address and agreement version are recorded by the Platform.' },
    ],
};
