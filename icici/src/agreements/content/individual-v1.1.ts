/**
 * Forecasting Services Agreement, Individual Contractor (PAN), v1.1: v1.0 verbatim except the three edits listed in agreements/v1.1/BUILD-NOTES.md
 * (Section 3 second bullet and Section 5 third bullet, from Business-Agreement-v1.1-amendment-text.md "Individual agreement edits"; and the
 * electronic-acceptance line, because there is no Google sign-in for contractors any more).
 */
import type { AgreementDoc, AgreementDetails } from '../agreementPdf';

const ph = (v: string | undefined, placeholder: string) => (v && v.trim() ? v.trim() : placeholder);

/** The Individual agreement; `d` fills the Parties clause once the contractor has given the details. */
export function individualDoc(d: AgreementDetails = {}): AgreementDoc {
  const co = d.company ?? {};
  return {
    kind: 'Individual Contractor (PAN)',
    version: '1.1',
    cover: 'Version 1.1 · November 2026 · Pilot programme · By invitation only',
    blocks: [
        { t: 'h2', text: '1. Parties' },
        { t: 'p', text: 'This Agreement is between:' },
        { t: 'li', text: `${ph(co.name, 'Karthikeyan S')}, an individual resident at ${ph(co.address, '[address]')}, Chennai, Tamil Nadu, carrying on business under the name “Nivedha Tech” (PAN: ${ph(co.pan, '[__________]')}); and` },
        { t: 'li', text: `The Contractor: ${ph(d.name, '[Full legal name]')}, resident at ${ph(d.address, '[address]')} (PAN: ${ph(d.pan, '[__________]')}) (the “Contractor”).` },
        { t: 'p', text: 'This Agreement takes effect when both parties sign it, or when the Contractor accepts it electronically on the Platform after receiving a personal invitation from Karthikeyan S (the “Effective Date”). Electronic acceptance is valid under the Information Technology Act, 2000. Access to the Platform is by personal invitation only; no person may participate without an executed or accepted copy of this Agreement.' },

        { t: 'h2', text: '2. Definitions' },
        { t: 'li', text: '“Platform” means Karthikeyan S’s web application at nivedhatech.com through which the Contractor submits Forecasts.' },
        { t: 'li', text: '“Forecast” means a prediction submitted through the Flash Forecast feature that the NIFTY 50 index will move Up or Down over the Forecast Window, with an optional confidence level (Low / Medium / High).' },
        { t: 'li', text: '“Forecast Window” means the period stated in Schedule 1, starting at the time the Platform records the Forecast.' },
        { t: 'li', text: '“Reference Value” means the NIFTY 50 index value as received by the Platform from its market-data source at the relevant time, as recorded in the Platform’s logs.' },
        { t: 'li', text: '“Correct Forecast” means a Forecast where the index moved in the forecast direction by at least the Neutral Threshold in Schedule 1 between the start and end of the Forecast Window. A move smaller than the Neutral Threshold makes the Forecast “Neutral”. Any other Forecast is “Incorrect”.' },
        { t: 'li', text: '“Trading Day” means a day on which the National Stock Exchange of India holds a normal trading session.' },
        { t: 'li', text: '“Fees” means the Retainer and the Accuracy Fee described in Section 6 and Schedule 1.' },

        { t: 'h2', text: '3. Nature of the Engagement' },
        { t: 'li', text: 'The Contractor is engaged as an independent contractor to provide a forecasting service. Nothing in this Agreement creates an employment, partnership, joint venture, agency or profit-sharing relationship.' },
        { t: 'li', text: 'The Contractor is not a client or customer of Karthikeyan S, does not invest any money, and has no interest in any account, capital, trade, position, profit or loss of Karthikeyan S. The Platform may show the Contractor read-only information about trades that resulted from the Contractor’s own Forecasts, as described in Section 5; that information gives the Contractor no interest or right of any kind.' },
        { t: 'li', text: 'The Contractor has no authority to place, direct, approve or cancel any order or to bind Karthikeyan S in any way.' },
        { t: 'li', text: 'The Services are personal to the Contractor. The Contractor may not subcontract them or let any other person use the Contractor’s Platform login.' },

        { t: 'h2', text: '4. The Services' },
        { t: 'li', text: 'The Contractor will submit Forecasts on the Platform during the Forecasting Hours in Schedule 1.' },
        { t: 'li', text: 'The Contractor may submit no more than the Daily Forecast Limit in Schedule 1, and may have only one Forecast whose Forecast Window is still open at any time.' },
        { t: 'li', text: 'Each Forecast must reflect the Contractor’s own judgement. The Contractor may use its own analysis tools, but must not copy, resell or relay calls, tips or signals obtained from any third party or paid tip service.' },
        { t: 'li', text: 'The Contractor must not access the Platform through bots, scripts or scrapers without Karthikeyan S’s written consent.' },
        { t: 'li', text: 'A Forecast cannot be edited or withdrawn once the Platform has recorded it.' },

        { t: 'h2', text: '5. How Karthikeyan S Uses Forecasts' },
        { t: 'li', text: 'Karthikeyan S may use Forecasts, together with its own analysis, models, filters and other inputs, for its own proprietary trading, in its own account and with its own capital, entirely at its own discretion.' },
        { t: 'li', text: 'A Forecast is one input among several. Karthikeyan S may combine it with other inputs, give it any weight, or ignore it. Karthikeyan S has no obligation to trade on any Forecast.' },
        { t: 'li', text: 'The Contractor will not have access to Karthikeyan S’s broker, account details, orders, capital or overall results. The Platform may show the Contractor, read-only, the entry price and live profit or loss of trades that resulted from the Contractor’s own Forecasts. This information is confidential under Section 10.' },
        { t: 'li', text: 'The Contractor’s Fees do not depend on whether or how Karthikeyan S used a Forecast, or on Karthikeyan S’s trading results.' },

        { t: 'h2', text: '6. Fees' },
        { t: 'li', text: 'Retainer. Karthikeyan S will pay the monthly Retainer in Schedule 1 for each calendar month in which the Contractor meets the Minimum Participation in Schedule 1. The Retainer is pro-rated for a partial first or last month. It is paid by bank transfer by the payment date in Schedule 1.' },
        { t: 'li', text: 'Accuracy Fee. Karthikeyan S will pay the Accuracy Fee in Schedule 1 for each Correct Forecast, subject to the Monthly Accuracy Fee Cap. Accuracy Fees for each week (Wednesday to Tuesday) are paid by bank transfer on the following Wednesday, or the next working day.' },
        { t: 'li', text: 'No deduction for Incorrect or Neutral Forecasts. An Incorrect or Neutral Forecast earns no Accuracy Fee. It never reduces the Retainer, never reduces Accuracy Fees already earned, and never creates any amount payable by the Contractor.' },
        { t: 'li', text: 'Not linked to trading results. The Fees are not a share of Karthikeyan S’s profits. Karthikeyan S’s trading profits or losses never increase or reduce the Fees.' },
        { t: 'li', text: 'Records. The outcome of each Forecast is determined from the Platform’s logs of the Forecast time and the Reference Values. The Platform shows the Contractor each Forecast, its outcome and Fees earned. The Contractor must raise any disagreement within 15 days of the relevant payment, and the parties will review the logs together in good faith.' },
        { t: 'li', text: 'The only deductions from Fees are tax deducted at source under Section 8 and correction of any amount Karthikeyan S paid by mistake, which Karthikeyan S will explain in writing.' },

        { t: 'h2', text: '7. No Payment, Deposit or Stake by the Contractor' },
        { t: 'p', text: 'The Contractor will never be asked to pay any fee, subscription, deposit, security, entry or evaluation charge, and will never bear any loss, to participate in or under this Agreement. Nothing in this Agreement is a game, wager or bet: the Contractor stakes nothing and is paid only for a service.' },

        { t: 'h2', text: '8. Taxes and Invoicing' },
        { t: 'li', text: 'Karthikeyan S will deduct tax at source from the Fees where required under the Income-tax Act, 2025, and will issue the TDS certificates required by law.' },
        { t: 'li', text: 'The Contractor is responsible for declaring the Fees and paying its own income tax.' },
        { t: 'li', text: 'The Contractor confirms that it is not registered under GST. If the Contractor becomes registered, it must tell Karthikeyan S within 7 days and provide its GSTIN, and from then on the Business Contractor (GSTIN) version of this Agreement, including its invoicing requirement, will apply.' },
        { t: 'li', text: 'Karthikeyan S will provide a monthly statement of Fees paid and tax deducted.' },

        { t: 'h2', text: '9. Contractor Undertakings' },
        { t: 'p', text: 'During the term of this Agreement the Contractor shall:' },
        { t: 'li', text: 'provide accurate identity, PAN, address and bank details, and keep them up to date;' },
        { t: 'li', text: 'not provide tips, calls, recommendations, research or forecasts about securities or the securities market to any other person or to the public, whether paid or free, including on social media, messaging groups or video channels;' },
        { t: 'li', text: 'not describe itself as a SEBI-registered research analyst, investment adviser or stock broker unless it actually holds that registration, and not claim to be associated with any broker or with Karthikeyan S’s trading;' },
        { t: 'li', text: 'not share its Platform login, and report any unauthorised use immediately;' },
        { t: 'li', text: 'not use any non-public information about Karthikeyan S or the Platform for its own trading or for anyone else.' },
        { t: 'p', text: 'Each party is responsible for its own compliance with applicable law, including any registration that the law may require for its own activities.' },

        { t: 'h2', text: '10. Confidentiality' },
        { t: 'p', text: 'The Contractor shall keep confidential all non-public information about Karthikeyan S, the Platform, its software, scoring methods and business, and shall use it only to perform the Services. This obligation continues for two years after this Agreement ends. It does not apply to information that is public through no fault of the Contractor or that must be disclosed by law.' },

        { t: 'h2', text: '11. Intellectual Property' },
        { t: 'p', text: 'The Platform and all its software and content belong to Karthikeyan S. The Contractor grants Karthikeyan S a perpetual, royalty-free right to use, store and analyse all Forecasts submitted under this Agreement for Karthikeyan S’s own business.' },

        { t: 'h2', text: '12. Personal Data' },
        { t: 'p', text: 'Karthikeyan S collects the Contractor’s name, contact details, PAN, address, bank details and Platform activity only to perform this Agreement, pay Fees and meet tax and legal obligations. The Contractor consents to this processing under the Digital Personal Data Protection Act, 2023. Karthikeyan S will store this data securely, keep it no longer than the law requires, and not sell or share it except with its bank, tax authorities or as required by law. Requests to access or correct data can be sent to admin@nivedhatech.com.' },

        { t: 'h2', text: '13. Term and Termination' },
        { t: 'li', text: 'This Agreement runs for the Pilot Term in Schedule 1 and then continues month to month.' },
        { t: 'li', text: 'Either party may end it at any time by giving 7 days’ notice by email.' },
        { t: 'li', text: 'Karthikeyan S may end it immediately by email if the Contractor breaches Section 4, 9 or 10, or provided false information during onboarding.' },
        { t: 'li', text: 'When this Agreement ends, Karthikeyan S will pay the pro-rated Retainer and all Accuracy Fees earned up to the end date, and Platform access will end. Sections 6 (for Fees earned), 8, 10, 11, 12, 14 and 16 continue to apply.' },

        { t: 'h2', text: '14. Liability' },
        { t: 'li', text: 'The Contractor is never liable for any trading loss of Karthikeyan S.' },
        { t: 'li', text: 'Karthikeyan S’s total liability under this Agreement is limited to Fees earned and not yet paid.' },
        { t: 'li', text: 'Neither party is liable for indirect or consequential loss.' },
        { t: 'li', text: 'The Contractor is liable for loss caused by its breach of Section 9 or 10.' },

        { t: 'h2', text: '15. Changes' },
        { t: 'p', text: 'Karthikeyan S may change this Agreement or Schedule 1 by giving at least 15 days’ notice by email. The Contractor may end this Agreement before the change takes effect without penalty. A change to Fees never applies to Forecasts submitted before the change takes effect.' },

        { t: 'h2', text: '16. Disputes and Governing Law' },
        { t: 'p', text: 'This Agreement is governed by the laws of India. The parties will first try to resolve any dispute through good-faith discussion for 15 days. Unresolved disputes will be decided by a sole arbitrator appointed by mutual agreement under the Arbitration and Conciliation Act, 1996, with the seat of arbitration at Chennai and proceedings in English. Subject to this, the courts at Chennai have exclusive jurisdiction.' },

        { t: 'h2', text: '17. General' },
        { t: 'li', text: 'This Agreement, with its Schedules, is the entire agreement between the parties on its subject.' },
        { t: 'li', text: 'If any provision is invalid, the rest remains in force.' },
        { t: 'li', text: 'Notices are given by email to the addresses recorded on the Platform (for Karthikeyan S: admin@nivedhatech.com).' },
        { t: 'li', text: 'The Contractor may not assign this Agreement.' },

        { t: 'h2', text: 'Schedule 1 – Fee and Forecast Schedule' },
        { t: 'table', rows: [
            ['Item', 'Value'],
            ['Monthly Retainer', '₹[__________] per month'],
            ['Minimum Participation', 'At least [1] Forecast on at least [15] Trading Days in the month'],
            ['Accuracy Fee', '₹[_____] per Correct Forecast'],
            ['Monthly Accuracy Fee Cap', '₹[__________] per calendar month'],
            ['Forecast Window', '[15] minutes from the recorded Forecast time'],
            ['Neutral Threshold', '[5] index points'],
            ['Daily Forecast Limit', '[3] Forecasts per Trading Day; one open Forecast at a time'],
            ['Forecasting Hours', '[09:20] to [15:00] IST on Trading Days (to [14:30] on NIFTY expiry days)'],
            ['Retainer payment date', 'By the [7th] day of the following month'],
            ['Accuracy Fee payment', 'Weekly, every Wednesday, for the previous Wednesday–Tuesday week'],
            ['Pilot Term', '[3] months from the Effective Date'],
        ] },

        { t: 'h2', text: 'Signatures' },
        { t: 'sig', left: ['For Karthikeyan S', 'Name: [__________________]', 'Signature: __________________', 'Date: __________'], right: ['For the Contractor', 'Name: [__________________]', 'Signature: __________________', 'Date: __________'] },
        { t: 'p', text: 'Or accepted electronically on the Platform: the Contractor’s email, timestamp, IP address and agreement version are recorded by the Platform.' },
    ],
  };
}

export const INDIVIDUAL_V1_1: AgreementDoc = individualDoc();
