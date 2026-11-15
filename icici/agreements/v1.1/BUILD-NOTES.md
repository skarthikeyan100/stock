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
