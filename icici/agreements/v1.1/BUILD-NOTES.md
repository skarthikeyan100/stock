# Agreements v1.1: what was built and what changed beyond the amendment text

Source: `Business-Agreement-v1.1-amendment-text.md` applied to the v1.0 PDFs. Content lives in `src/agreements/content/*.ts`; rebuild with `npx tsc && node dist/tools/buildAgreements.js` (a rebuild gives a new SHA-256, so build once, commit, and record the hash from the served file).

## Business (GSTIN) v1.1
Applied exactly as written: Parties (Contractor paragraph), Definitions, 3, 4, 5, 5A, 6, 6A.1 to 6A.7, 7 (added sentence), 9, 13 (added bullet), 14 (second bullet), Schedule 1, signature line.
Unchanged from v1.0: 8 (Taxes and Invoicing), 10, 16, 17 and the rest of 12 and Schedule 2 apart from the items below.

**Consequential edits I made (not in the amendment text; please confirm):**
1. Definitions: added `"Fees"` = Profit Share (or the fixed fee under 6A.6) and any Retainer in Schedule 1, because 3.2, 8, 13 and 15 use "Fees" and v1.0 defined it as Retainer + Accuracy Fee.
2. 4.2: added "may submit Recommendations only during the Recommendation hours and up to the daily number stated in Schedule 1", so Schedule 1's two new rows have a clause behind them.
3. 11 (IP): "Forecasts" changed to "Recommendations".
4. 12 (Personal Data): "Registration details" added to the data collected.
5. 13 (last bullet): "pro-rated Retainer and all Accuracy Fees earned" changed to "the Fees earned (and any Retainer, pro-rated)"; "Sections 6 (for Fees earned)" changed to "6 and 6A".
6. 15: "Forecasts submitted" changed to "Recommendations approved".
7. Schedule 2: description line and the breakdown line now refer to the Profit Share (or fixed fee) instead of Retainer / Correct Forecasts. Tax lines are untouched (tax is the next phase).
8. Signature note: "Contractor's Google account email" changed to "the Contractor's email" because contractors no longer sign in with Google; the note also mentions the clause 6A.5 confirmation (from the amendment text).
9. Numbering: clauses in 3, 4, 5, 5A, 6A and 9 are numbered (3.1 ...) as the amendment text numbers them; other sections keep v1.0 bullets.

**Owner's later edit (2026-11-16):** clause 4.3 ("must not copy, resell or relay calls from third parties") was removed from the Business agreement; the old 4.4 and 4.5 are now 4.3 and 4.4. Section 9.3 (no giving the same Recommendation to another person for the Company's trade) is unchanged. Nobody had accepted Business v1.1 yet, so the file was rebuilt in place (new SHA-256 in `manifest.json`).

**Owner's edits of 2026-11-16 (Business):**
- 6A.2 now **carries losses forward**: a loss is set off against later weeks' Trade Profit before any Profit Share is paid; it never reduces an amount already paid and is never owed by the Contractor. 6A.1 refers to it. (The statements code does the same: `lossBroughtForward` / `lossCarriedForward` on each weekly statement.)
- 6A.6 fixed fee: payable **only to the extent the suggested profit (target minus entry price) is achieved**; in full once achieved, pro rata when only part is, in the weekly statement of the week the trade closes; nothing for a trade without a profit. Weekly approximation in code: points achieved by the week's closed trades / points suggested by the week's approved recommendations. Please confirm that reading.
- Schedule 1: Recommendations per day **[3]** (config `forecast.recommendationsPerDay: 3`).
- Section 13: the bullet "Either party may end it at any time by giving 7 days' notice by email" is removed. Clause 9.3 (same Recommendation to another person) removed; 9.4 to 9.6 renumbered 9.3 to 9.5.
- Signatures section removed. Consequential: the Effective Date paragraph no longer says "when both parties sign it" (acceptance on the Platform only).
- **The party is named "Karthikeyan S" instead of "the Company"** everywhere (there is no registered company). Applied to the Individual agreement too. His address and PAN come from `forecast.company` in config.yml (empty = `[address]` / `[__________]` placeholders show).
- **The Parties clause (and 3.4, Schedule 1 "Registration valid until") is filled from the contractor's own details.** The contractor gives the details first, the portal prepares the agreement with them, they read it and accept that file; it is signed, stored under `storage/_agreements/<contractor>/`, and the acceptance record holds its SHA-256 (and the template's). The files in this folder are the generic templates with placeholders. A PAN is no longer asked of a Business contractor: it is read from the GSTIN (characters 3 to 12).

## Individual (PAN) v1.1
v1.0 verbatim except:
1. Section 3, second bullet: replaced as in the amendment text.
2. Section 5, third bullet: replaced as in the amendment text; fourth bullet kept.
3. Signature note: "Google account email" changed to "email" (same reason as Business).
4. Version line 1.0 -> 1.1.
Section 8 is unchanged.

## Not done / for the reviewer
- All square-bracket placeholders (names, PAN, GSTIN, INH number, validity date, fee values) are left as placeholders, as in v1.0.
- The PDFs carry the same self-signed PKCS#7 signature as the other platform PDFs (`src/pdfSigning.ts`).
- Not legal advice.
