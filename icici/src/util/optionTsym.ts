// Reads an option trading symbol of ANY broker's spelling into the contract it names (underlying, strike, CE/PE and which expiry), so a
// position can be mapped onto the ANT contract master and priced live whichever broker holds it. The spellings (checked against every row
// of the Kite, Prism, Breeze-built and ANT masters, see src/test/optionTsym.test.ts):
//   ANT / Prism NFO   NIFTY23NOV26C25400    NAME DDMMMYY C|P strike               exact day
//   Breeze            NIFTY23NOV2625400CE   NAME DDMMMYY strike CE|PE             exact day
//   Kite weekly, ANT BFO weekly, Prism BFO weekly  NIFTY2611825400CE  NAME YY M DD strike CE|PE   (M = 1-9, O, N, D)  exact day
//   Kite monthly, Prism BFO monthly  NIFTY26NOV25400CE    NAME YY MMM strike CE|PE   the month's last expiry
//   Breeze legacy     NIFTY25400CE         NAME strike CE|PE                      nearest expiry
// Spellings can overlap (NIFTY18NOV2625400CE also reads as monthly 2018-NOV strike 2625400), so this returns every reading in the order they
// should be tried and the caller keeps the first one that names a listed contract.
export type TsymExpiry = { kind: 'day'; year: number; month: number; day: number } | { kind: 'month'; year: number; month: number } | { kind: 'nearest' };
export interface OptionTsymReading { symbol: string; strike: number; optionType: 'CE' | 'PE'; expiry: TsymExpiry }

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKLY_MONTH_CODES = '123456789OND';

export function readOptionTsym(tsym: string): OptionTsymReading[] {
    const s = String(tsym ?? '').trim().toUpperCase();
    const out: OptionTsymReading[] = [];
    const side = (c: string): 'CE' | 'PE' => (c === 'C' || c === 'CE' ? 'CE' : 'PE');
    let m: RegExpExecArray | null;
    if ((m = /^([A-Z][A-Z&-]*?)(\d{2})([A-Z]{3})(\d{2})([CP])(\d+(?:\.\d+)?)$/.exec(s)) && MONTHS.includes(m[3])) {
        out.push({ symbol: m[1], strike: Number(m[6]), optionType: side(m[5]), expiry: { kind: 'day', year: 2000 + Number(m[4]), month: MONTHS.indexOf(m[3]), day: Number(m[2]) } });
    }
    if ((m = /^([A-Z][A-Z&-]*?)(\d{2})([A-Z]{3})(\d{2})(\d+)(CE|PE)$/.exec(s)) && MONTHS.includes(m[3])) {
        out.push({ symbol: m[1], strike: Number(m[5]), optionType: side(m[6]), expiry: { kind: 'day', year: 2000 + Number(m[4]), month: MONTHS.indexOf(m[3]), day: Number(m[2]) } });
    }
    if ((m = /^([A-Z][A-Z&-]*?)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$/.exec(s))) {
        out.push({ symbol: m[1], strike: Number(m[5]), optionType: side(m[6]), expiry: { kind: 'day', year: 2000 + Number(m[2]), month: WEEKLY_MONTH_CODES.indexOf(m[3]), day: Number(m[4]) } });
    }
    if ((m = /^([A-Z][A-Z&-]*?)(\d{2})([A-Z]{3})(\d+)(CE|PE)$/.exec(s)) && MONTHS.includes(m[3])) {
        out.push({ symbol: m[1], strike: Number(m[4]), optionType: side(m[5]), expiry: { kind: 'month', year: 2000 + Number(m[2]), month: MONTHS.indexOf(m[3]) } });
    }
    if ((m = /^([A-Z][A-Z&-]*?)(\d+)(CE|PE)$/.exec(s))) {
        out.push({ symbol: m[1], strike: Number(m[2]), optionType: side(m[3]), expiry: { kind: 'nearest' } });
    }
    return out;
}

// The last UTC-midnight day on which the contract a tsym names can still be live, or undefined when the spelling does not say (no tsym reading,
// or only the expiry-less legacy form). Used for a contract that has dropped out of the contract masters after expiring, so it can still be told
// from a contract that is genuinely unknown. Spellings overlap (see above), so the answer is the LATEST day any dated reading allows: a tsym is
// only called expired when every dated reading is. A weekly/day reading is live through its own day (a contract expiring today is live); a
// monthly reading is live through the month's last day (the exact monthly expiry day is not in the spelling).
export function lastLiveDayMs(tsym: string): number | undefined {
    let latest: number | undefined;
    for (const r of readOptionTsym(tsym)) {
        if (r.expiry.kind === 'nearest' || r.expiry.month < 0) continue;
        const ms = r.expiry.kind === 'day' ? Date.UTC(r.expiry.year, r.expiry.month, r.expiry.day) : Date.UTC(r.expiry.year, r.expiry.month + 1, 0);
        if (ms > Date.now() + 400 * 86400000) continue; // no listed option expires over a year out: a far-future reading is a spurious overlap (SENSEX26OCT82600CE also reads as day 26-OCT-2082)
        if (latest === undefined || ms > latest) latest = ms;
    }
    return latest;
}
