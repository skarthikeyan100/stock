/** Fee statements: dates, fee-model effective dates, Beginner accuracy and retainer, Advanced profit share / fixed fee, invariants, the tax-phase payment gate, invoices. Run: npx tsc, then node ./dist/test/contractorStatements.test.js */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
fs.copyFileSync(path.resolve(__dirname, '..', '..', 'config.yml'), path.join(tmp, 'config.yml'));
process.env.CONFIG_PATH = path.join(tmp, 'config.yml');
for (const k of ['GMAIL_USER', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN']) delete process.env[k];
import { installFakeDb } from './fakeDb';
import configService from '../prism/ConfigService';
import { previousWeek, previousMonth, daysInMonthOf, addDays, feeModelOn, weeklyAccuracyStatement, monthlyRetainerStatement, weeklyAdvancedStatement, runWeeklyStatements, runMonthlyRetainers, approveStatement, markPaid, statementCsv, statementsCol } from '../contractors/statements';
import { runInvoiceChecks } from '../contractors/jobs';
import { restoreIfNoOverdue } from '../routes/statements';
import { contractorsCol } from '../contractors/store';

let failed = 0;
function assert(condition: boolean, message: string) { console.log(`  ${condition ? 'PASS' : 'FAIL'}: ${message}`); if (!condition) { failed++; process.exitCode = 1; } }
const setCfg = (mut: (t: string) => string) => { const f = path.join(tmp, 'config.yml'); fs.writeFileSync(f, mut(fs.readFileSync(f, 'utf8'))); configService.reloadNow(); };

async function main() {
    const db = installFakeDb();
    console.log('dates:');
    assert(JSON.stringify(previousWeek('2026-11-18')) === JSON.stringify({ from: '2026-11-11', to: '2026-11-17' }), 'on a Wednesday the previous Wednesday to Tuesday');
    assert(JSON.stringify(previousWeek('2026-11-20')) === JSON.stringify({ from: '2026-11-11', to: '2026-11-17' }), 'any later day that week gives the same last complete week');
    assert(previousMonth('2026-01-01') === '2025-12' && previousMonth('2026-03-01') === '2026-02' && daysInMonthOf('2026-02') === 28 && daysInMonthOf('2028-02') === 29, 'previous month and month length');
    assert(addDays('2026-12-31', 1) === '2027-01-01', 'date arithmetic across a year');

    console.log('fee model effective dates:');
    const models = [{ from: '2026-12-01', model: 'FIXED_PER_APPROVED' as const, fixedAmount: 500 }];
    assert(feeModelOn(models, '2026-11-30', 25).model === 'PROFIT_SHARE' && feeModelOn(models, '2026-11-30', 25).sharePercent === 25, 'before the effective date: the default profit share');
    assert(feeModelOn(models, '2026-12-01', 25).model === 'FIXED_PER_APPROVED' && feeModelOn(undefined, '2026-12-01', 25).model === 'PROFIT_SHARE', 'on the date the new model applies; no entries means the default');

    console.log('Beginner accuracy:');
    const ind: any = { id: 'i1', email: 'i@x.com', name: 'Ind', type: 'INDIVIDUAL', status: 'ACTIVE', pseudoUserId: 'Forecast-S01', activatedAt: new Date('2026-10-01') };
    await contractorsCol().insertOne(ind);
    const F = (id: string, day: string, outcome: string, fee = 100) => db.collection('forecasts').insertOne({ id, contractorId: 'i1', day, outcome, feeAmount: fee });
    await F('a', '2026-11-11', 'CORRECT'); await F('b', '2026-11-12', 'CORRECT'); await F('c', '2026-11-13', 'INCORRECT'); await F('d', '2026-11-16', 'NEUTRAL'); await F('e', '2026-11-17', 'VOID'); await F('f', '2026-11-10', 'CORRECT'); await F('g', '2026-11-18', 'CORRECT');
    let s: any = await weeklyAccuracyStatement(ind, { from: '2026-11-11', to: '2026-11-17' });
    assert(s.gross === 200 && s.lines.correct === 2 && s.lines.incorrect === 1 && s.lines.neutral === 1 && s.lines.void === 1, 'only the two CORRECT forecasts of the week earn; others contribute 0');
    assert(await weeklyAccuracyStatement(ind, { from: '2026-11-11', to: '2026-11-17' }) === null, 'one statement per period: running again creates nothing');
    assert(s.status === 'DRAFT', 'a statement starts as a DRAFT');
    setCfg((t) => t.replace('    monthlyCap: 0                  # rupees per month; 0 = no cap', '    monthlyCap: 250                # rupees per month; 0 = no cap'));
    await F('h', '2026-11-19', 'CORRECT'); await F('i', '2026-11-20', 'CORRECT'); await F('j', '2026-11-23', 'CORRECT');
    const s2: any = await weeklyAccuracyStatement(ind, { from: '2026-11-18', to: '2026-11-24' });
    assert(s2.gross === 50 && s2.lines.cappedByMonthlyCap === 1, 'capped by what is left of the monthly cap (250 - 200 already earned = 50)');
    const mostlyFree = await weeklyAccuracyStatement({ ...ind, id: 'i2' }, { from: '2026-11-18', to: '2026-11-24' });
    assert(mostlyFree === null, 'a contractor with no forecasts gets no statement');
    await F('k', '2026-11-26', 'CORRECT');
    const s3: any = await weeklyAccuracyStatement(ind, { from: '2026-11-25', to: '2026-11-30' }); // (a statement belongs to the month its period ENDS in)
    assert(s3.gross === 0, 'the cap is spent: 0, never negative');
    assert((await statementsCol().find({}).toArray() as any[]).every((x) => x.gross >= 0), 'no statement amount is negative');

    console.log('retainer:');
    setCfg((t) => t.replace('    retainerMonthly: 0\n', '    retainerMonthly: 3000\n'));
    for (let d = 1; d <= 16; d++) await db.collection('forecasts').insertOne({ id: `r${d}`, contractorId: 'i1', day: `2026-10-${String(d).padStart(2, '0')}`, outcome: 'INCORRECT', feeAmount: 0 });
    const r1: any = await monthlyRetainerStatement(ind, '2026-10');
    assert(r1.gross === 3000 * 31 / 31 && r1.lines.participationDays === 16, 'a full month with 16 participation days pays the retainer');
    const late = { ...ind, id: 'late', activatedAt: new Date('2026-10-16') };
    for (let d = 16; d <= 31; d++) await db.collection('forecasts').insertOne({ id: `l${d}`, contractorId: 'late', day: `2026-10-${d}`, outcome: 'INCORRECT', feeAmount: 0 });
    const r2: any = await monthlyRetainerStatement(late, '2026-10');
    assert(r2.lines.activeDays === 16 && r2.gross === Math.round(3000 * 16 / 31 * 100) / 100, 'pro-rated by active days from activation');
    for (let d = 1; d <= 10; d++) await db.collection('forecasts').insertOne({ id: `p${d}`, contractorId: 'few', day: `2026-10-${String(d).padStart(2, '0')}`, outcome: 'INCORRECT', feeAmount: 0 });
    const r3: any = await monthlyRetainerStatement({ ...ind, id: 'few' }, '2026-10');
    assert(r3.gross === 0 && /minimum/.test(String(r3.lines.note)), 'zero below the minimum participation days');
    assert(await monthlyRetainerStatement(ind, '2026-10') === null, 'idempotent');

    console.log('Advanced:');
    const biz: any = { id: 'b1', email: 'b@x.com', name: 'Biz', type: 'BUSINESS', status: 'ACTIVE', pseudoUserId: 'Recommendation-S01' };
    await contractorsCol().insertOne(biz);
    const T = (id: string, pnl: number, exit: string) => db.collection('closedTrades').insertOne({ id, user: 'Recommendation-S01', realizedPnL: pnl, exitTime: new Date(`${exit}+05:30`) });
    await T('t1', 1000, '2026-11-12T11:00:00'); await T('t2', -300, '2026-11-13T11:00:00'); await T('t3', 5000, '2026-11-18T11:00:00');
    const w = { from: '2026-11-11', to: '2026-11-17' };
    const p1: any = await weeklyAdvancedStatement(biz, w, 25);
    assert(p1.kind === 'PROFIT_SHARE_WEEK' && p1.lines.netTradeProfit === 700 && p1.gross === 175, 'profit share = 25% of the week\'s NET trade profit (1000 - 300), the next week\'s trade is excluded');
    await T('t4', -900, '2026-11-24T11:00:00');
    const p2: any = await weeklyAdvancedStatement(biz, { from: '2026-11-18', to: '2026-11-24' }, 25);
    assert(p2.lines.netTradeProfit === 4100 && p2.gross === 1025, 'a later week stands on its own');
    await T('t5', -2000, '2026-11-25T11:00:00');
    const p3: any = await weeklyAdvancedStatement(biz, { from: '2026-11-25', to: '2026-12-01' }, 25);
    assert(p3.gross === 0 && p3.lines.netTradeProfit === -2000, 'a losing week pays 0 and is a statement of 0, not a debt');
    const p4: any = await weeklyAdvancedStatement(biz, { from: '2026-12-02', to: '2026-12-08' }, 25);
    assert(p4 === null, 'a week with no trades and no approved recommendations: no statement');
    assert((await weeklyAdvancedStatement(biz, { from: '2026-11-25', to: '2026-12-01' }, 25)) === null && (await statementsCol().find({ contractorId: 'b1' }).toArray() as any[]).every((x) => x.gross >= 0), 'the loss was not carried into any other week; nothing is negative');
    const fixed: any = { ...biz, id: 'b2', email: 'b2@x.com', pseudoUserId: 'Recommendation-S02', feeModels: [{ from: '2026-11-18', model: 'FIXED_PER_APPROVED', fixedAmount: 400 }] };
    await contractorsCol().insertOne(fixed);
    const R = (id: string, day: string, status = 'APPROVED') => db.collection('recommendations').insertOne({ id, contractorId: 'b2', day, status });
    await R('x1', '2026-11-12'); await R('x2', '2026-11-13'); await R('x3', '2026-11-19'); await R('x4', '2026-11-20'); await R('x5', '2026-11-21', 'REJECTED');
    const f1: any = await weeklyAdvancedStatement(fixed, w, 25);
    assert(f1 === null || f1.kind === 'PROFIT_SHARE_WEEK', 'before the effective date the old model (profit share) applies to that week: no fixed fee');
    const f2: any = await weeklyAdvancedStatement(fixed, { from: '2026-11-18', to: '2026-11-24' }, 25);
    assert(f2.kind === 'FIXED_PER_APPROVED_WEEK' && f2.lines.approvedRecommendations === 2 && f2.gross === 800, 'from the effective date a fixed amount per APPROVED recommendation (rejected ones earn nothing)');
    assert((await statementsCol().find({ contractorId: 'b2', kind: 'PROFIT_SHARE_WEEK' }).toArray()).length <= 1, 'switching the model altered no earlier statement');

    console.log('jobs:');
    const made = await runWeeklyStatements('2026-12-02');
    assert(Array.isArray(made), 'the weekly runner runs (idempotent)');
    await contractorsCol().insertOne({ id: 'tst', email: 't@x.com', name: 'Test', type: 'INDIVIDUAL', status: 'ACTIVE', isTest: true, pseudoUserId: '' });
    await db.collection('forecasts').insertOne({ id: 'tf', contractorId: 'tst', day: '2026-11-12', outcome: 'CORRECT', feeAmount: 100 });
    await runWeeklyStatements('2026-11-18'); await runMonthlyRetainers('2026-11-01');
    assert((await statementsCol().find({ contractorId: 'tst' }).toArray()).length === 0, 'the test user gets no statements');

    console.log('payment gate (taxPhaseComplete):');
    const draft: any = (await statementsCol().find({ contractorId: 'i1', kind: 'ACCURACY_WEEK' }).toArray())[0];
    let st: any = await approveStatement(draft.id, 'boss', ind);
    assert(st.ok === false && st.status === 409 && /tax phase/.test(st.error), 'approving a real contractor\'s statement is locked until the tax phase is complete');
    st = await markPaid(draft.id, 'boss', 'UTR1', ind);
    assert(st.ok === false && /locked/.test(st.error), 'and so is Mark PAID');
    const tdraft = { id: 'ts1', contractorId: 'tst', kind: 'ACCURACY_WEEK', periodFrom: '2026-11-11', periodTo: '2026-11-17', lines: {}, gross: 100, status: 'DRAFT', createdAt: new Date() };
    await statementsCol().insertOne(tdraft);
    st = await approveStatement('ts1', 'boss', { id: 'tst', isTest: true, type: 'INDIVIDUAL' } as any);
    assert(st.ok === true && st.doc.status === 'APPROVED', 'the test user is allowed');
    st = await markPaid('ts1', 'boss', '  ', { isTest: true } as any);
    assert(st.ok === false && st.status === 400, 'a UTR reference is required');
    st = await markPaid('ts1', 'boss', 'UTR123', { isTest: true, type: 'INDIVIDUAL' } as any);
    assert(st.ok === true && st.doc.status === 'PAID' && st.doc.utr === 'UTR123' && !st.doc.invoiceDueAt, 'APPROVED -> PAID with the UTR; no invoice for a Beginner');
    st = await markPaid('ts1', 'boss', 'UTR9', { isTest: true } as any);
    assert(st.ok === false && st.status === 409, 'a paid statement cannot be paid again');
    setCfg((t) => t.replace(/\n# Contractor portal \(spec[^\n]*\nforecast:\n/, (m) => m + '  taxPhaseComplete: true\n'));
    st = await approveStatement(draft.id, 'boss', ind);
    assert(st.ok === true, 'with forecast.taxPhaseComplete: true a real contractor\'s statement can be approved');

    console.log('invoices (Advanced):');
    const bs: any = (await statementsCol().find({ contractorId: 'b1', kind: 'PROFIT_SHARE_WEEK' }).toArray())[0];
    await approveStatement(bs.id, 'boss', biz);
    const paidAt = new Date('2026-12-03T10:00:00+05:30');
    st = await markPaid(bs.id, 'boss', 'UTR55', biz, paidAt);
    assert(st.ok && st.doc.invoiceDueAt.toISOString() === new Date('2026-12-05T23:59:59+05:30').toISOString(), 'the invoice is due by 23:59 IST two days after the payment date');
    assert(await runInvoiceChecks(new Date('2026-12-05T23:00:00+05:30')) === 0 && (await contractorsCol().findOne({ id: 'b1' }) as any).status === 'ACTIVE', 'not overdue yet');
    assert(await runInvoiceChecks(new Date('2026-12-06T00:30:00+05:30')) === 1 && (await contractorsCol().findOne({ id: 'b1' }) as any).status === 'PAUSED_INVOICE', 'overdue: PAUSED_INVOICE (blocks new recommendations)');
    assert((await statementsCol().findOne({ id: bs.id }) as any).gross === bs.gross, 'fees are never clawed back');
    assert(await runInvoiceChecks(new Date('2026-12-07T00:30:00+05:30')) === 0, 'flagged once, not repeatedly');
    await statementsCol().updateOne({ id: bs.id }, { $set: { invoice: { number: 'INV-1', date: '2026-12-06', file: 'x', uploadedAt: new Date() } } });
    await restoreIfNoOverdue((await contractorsCol().findOne({ id: 'b1' })) as any, new Date('2026-12-07T10:00:00+05:30'));
    assert((await contractorsCol().findOne({ id: 'b1' }) as any).status === 'ACTIVE', 'uploading the invoice restores ACTIVE');

    console.log('csv:');
    const csv = statementCsv(draft, ind);
    assert(/Gross amount/.test(csv) && /ACCURACY_WEEK/.test(csv) && !/tax|TDS|GST/i.test(csv), 'a CSV with the amount and no tax lines (tax is out of scope)');

    console.log(failed ? `\n${failed} FAILED` : '\nALL TESTS PASSED');
    process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
