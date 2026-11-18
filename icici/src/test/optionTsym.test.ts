/**
 * AntContractMaster.findByAnyBrokerTradingSymbol: every NIFTY / SENSEX option of the Kite and Prism masters (and Breeze's and ANT's own spelling
 * of every ANT row) must resolve to the ANT contract with the SAME expiry, strike and side, so a position held on any broker is priced at the
 * right ANT token (the daily drawdown's open P&L). Reads the master files in data/.
 * Run: node ./dist/test/optionTsym.test.js
 */
import fs from 'fs';
import path from 'path';
import AntContractMaster from '../ant/AntContractMaster';
import { breezeTsym } from '../breeze/BreezeContractMaster';

const ant = AntContractMaster.getInstance();
const root = path.join(__dirname, '../../data');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
let failed = 0;
const reportFail = (m: string) => { failed++; if (failed <= 25) console.log(`FAIL ${m}`); };

const antRows = (sym: string, exch: 'NFO' | 'BFO'): any[] =>
    JSON.parse(fs.readFileSync(path.join(root, 'ant', `${exch}_contract.json`), 'utf-8'))[exch].filter((r: any) => r.Symbol === sym && (r['Option Type'] === 'CE' || r['Option Type'] === 'PE'));
const index = new Map<string, any>();
for (const [sym, exch] of [['NIFTY', 'NFO'], ['SENSEX', 'BFO']] as const) {
    for (const r of antRows(sym, exch)) index.set(`${sym}|${r['Expiry Date']}|${r['Strike Price']}|${r['Option Type']}`, r);
}

function expectContract(label: string, tsym: string, sym: string, exch: 'NFO' | 'BFO', expiryMs: number, strike: number, side: string, counts: { ok: number; skipped: number }) {
    const want = index.get(`${sym}|${expiryMs}|${strike}|${side}`);
    if (!want) { counts.skipped++; return; } // the ANT master does not list that contract: nothing to compare
    const got = ant.findByAnyBrokerTradingSymbol(tsym, exch);
    if (got?.token === want.Token) counts.ok++;
    else reportFail(`${label} ${tsym}: expected token ${want.Token} (${want['Trading Symbol']}), got ${got?.token ?? 'undefined'}`);
}

// Kite master
for (const [file, exch, name] of [['NFO_instruments.csv', 'NFO', 'NIFTY'], ['BFO_instruments.csv', 'BFO', 'SENSEX']] as const) {
    const counts = { ok: 0, skipped: 0 };
    const lines = fs.readFileSync(path.join(root, 'kite', file), 'utf-8').split('\n');
    const h = lines[0].split(',');
    const [iTs, iName, iExp, iStrike, iType] = ['tradingsymbol', 'name', 'expiry', 'strike', 'instrument_type'].map((c) => h.indexOf(c));
    for (const line of lines.slice(1)) {
        const c = line.split(',');
        if (c[iName]?.replace(/"/g, '') !== name || (c[iType] !== 'CE' && c[iType] !== 'PE')) continue;
        const [y, m, d] = c[iExp].split('-').map(Number);
        expectContract('kite', c[iTs], name, exch, Date.UTC(y, m - 1, d), Number(c[iStrike]), c[iType], counts);
    }
    console.log(`kite ${name}: ${counts.ok} resolved, ${counts.skipped} not in the ANT master`);
    if (counts.ok < 100) reportFail(`kite ${name}: only ${counts.ok} contracts compared`);
}

// Prism master
for (const [file, exch, name] of [['NFO_symbols.txt', 'NFO', 'NIFTY'], ['BFO_symbols.txt', 'BFO', 'SENSEX']] as const) {
    const counts = { ok: 0, skipped: 0 };
    for (const line of fs.readFileSync(path.join(root, 'prism', file), 'utf-8').split('\n').slice(1)) {
        const c = line.split(',');
        if (!new RegExp('^' + name + '\\d').test(c[4] ?? '') || (c[7] !== 'CE' && c[7] !== 'PE') || c[6] !== 'OPTIDX' || c[3] === 'SX50OPT') continue;
        const m = /^(\d{2})-([A-Z]{3})-(\d{4})$/.exec(c[5]);
        if (!m) continue;
        expectContract('prism', c[4], name, exch, Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]), Number(m[1])), Number(c[8]), c[7], counts);
    }
    console.log(`prism ${name}: ${counts.ok} resolved, ${counts.skipped} not in the ANT master`);
    if (counts.ok < 100) reportFail(`prism ${name}: only ${counts.ok} contracts compared`);
}

// Breeze spelling and ANT's own, built from every ANT row
for (const [name, exch] of [['NIFTY', 'NFO'], ['SENSEX', 'BFO']] as const) {
    const counts = { ok: 0, skipped: 0 };
    for (const r of antRows(name, exch)) {
        const d = new Date(parseInt(r['Expiry Date']));
        const mon = MONTHS[d.getUTCMonth()];
        const expiryDate = `${String(d.getUTCDate()).padStart(2, '0')}-${mon[0]}${mon.slice(1).toLowerCase()}-${d.getUTCFullYear()}`;
        expectContract('breeze', breezeTsym(name === 'SENSEX' ? 'BSESEN' : 'NIFTY', expiryDate, r['Strike Price'], r['Option Type']), name, exch, parseInt(r['Expiry Date']), Number(r['Strike Price']), r['Option Type'], counts);
        expectContract('ant', r['Trading Symbol'], name, exch, parseInt(r['Expiry Date']), Number(r['Strike Price']), r['Option Type'], counts);
    }
    console.log(`breeze+ant ${name}: ${counts.ok} resolved`);
    if (counts.ok < 100) reportFail(`breeze+ant ${name}: only ${counts.ok} compared`);
}

// Legacy expiry-less Breeze spelling: the nearest expiry.
{
    const near = ant.findNearestExpiryOption({ symbol: 'NIFTY', exch: 'NFO', strike: 25000, optionType: 'CE', expiryOffset: 0 });
    const got = ant.findByAnyBrokerTradingSymbol('NIFTY25000CE', 'NFO');
    if (got?.token !== near.token) reportFail(`legacy NIFTY25000CE: expected ${near.token}, got ${got?.token}`);
}
// Garbage resolves to nothing rather than a wrong contract.
for (const bad of ['', 'RELIANCE', 'NIFTY', 'NIFTY99ZZZ2625400CE', 'NIFTY26NOV99999999CE']) {
    if (ant.findByAnyBrokerTradingSymbol(bad, 'NFO')) reportFail(`'${bad}' must not resolve`);
}

if (failed) { console.log(`${failed} FAILED`); process.exitCode = 1; } else console.log('ALL PASS');
