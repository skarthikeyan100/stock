import fs from 'fs';
import path from 'path';
import Log from '../util/Log';
import { exchangeForIndex } from '../util/underlyings';

// A row's trading symbol: the master files spell the column "Trading Symbol" in one format and "Trading" in another.
function tradingSymbolOf(record: { 'Trading Symbol'?: string; Trading?: string }): string {
  return record['Trading Symbol'] || record.Trading || '';
}

// Start of the current UTC day in epoch ms - the cut-off the master's expiry dates are compared against.
function todayStartUtc(): number {
  return Math.floor(Date.now() / 86400000) * 86400000;
}

interface ContractRecord {
  Symbol: string;
  Token: string;
  Trading?: string;
  'Trading Symbol'?: string;
  'Strike Price': string;
  'Option Type': string;
  Exch: string;
  'Expiry Date': string;
  'Lot Size': string;
}

interface EquityRecord {
  Symbol: string;
  Token: string;
  'Group Name': string;
  Exch: string;
}

class AntContractMaster {
  private static instance: AntContractMaster;
  private nfoCache: ContractRecord[] | null = null;
  private bfoCache: ContractRecord[] | null = null;
  private nseCache: EquityRecord[] | null = null;
  private nseBysymbol: Map<string, EquityRecord> | null = null;

  private readonly NFO_PATH = path.join(__dirname, '../../data/ant/NFO_contract.json');
  private readonly BFO_PATH = path.join(__dirname, '../../data/ant/BFO_contract.json');
  private readonly NSE_PATH = path.join(__dirname, '../../data/ant/NSE_contract.json');

  private readonly STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
  private warnedStale = new Set<string>();

  private checkStaleness(filePath: string): void {
    if (this.warnedStale.has(filePath)) return;
    try {
      const ageMs = Date.now() - fs.statSync(filePath).mtimeMs;
      if (ageMs > this.STALE_THRESHOLD_MS) {
        const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
        console.warn(`[AntContractMaster] WARNING: ${filePath} is ${days} days old - re-download from https://v2api.aliceblueonline.com/restpy/static/contract_master/V2/ (see CLAUDE.md)`);
      }
      this.warnedStale.add(filePath);
    } catch (e) {
      // Non-fatal - staleness detection is a courtesy warning, not a load-blocking check.
    }
  }

  // Matches KiteContractMaster's strike-rounding table.
  static readonly STRIKE_STEP: Record<string, number> = {
    NIFTY: 50,
    SENSEX: 100,
  };

  static getInstance(): AntContractMaster {
    if (!AntContractMaster.instance) {
      AntContractMaster.instance = new AntContractMaster();
    }
    return AntContractMaster.instance;
  }

  // Fills the in-memory caches at process startup so the first lookup inside a trading window
  // doesn't pay the JSON parse. Fail-soft: a failed load is logged and lookups stay lazy as before.
  // NSE degrades to an empty table inside loadNSE itself (with its own ALERT).
  preload(opts: { bfo?: boolean } = {}): void {
    const tryLoad = (label: string, load: () => { length: number }) => {
      const t0 = Date.now();
      try {
        const rows = load().length;
        Log.log(`[AntContractMaster] preload ${label}: ${rows} rows in ${Date.now() - t0}ms`);
      } catch (e: any) {
        Log.log(`[AntContractMaster] ALERT: preload ${label} failed - lookups will retry lazily: ${e?.message ?? e}`);
      }
    };
    tryLoad('NFO', () => this.loadNFO());
    tryLoad('NSE', () => this.loadNSE());
    if (opts.bfo) tryLoad('BFO', () => this.loadBFO());
  }

  // Long-lived processes never saw a re-downloaded master (scripts/download-all-masters.sh replaces
  // the file in place): drop the cache when the file on disk is newer than what was loaded. The
  // stat is throttled to once per minute per file.
  private loadedMtime = new Map<string, number>();
  private lastMtimeCheck = new Map<string, number>();

  private cacheIsFresh(filePath: string): boolean {
    const now = Date.now();
    if (now - (this.lastMtimeCheck.get(filePath) ?? 0) < 60000) return true;
    this.lastMtimeCheck.set(filePath, now);
    try {
      return fs.statSync(filePath).mtimeMs <= (this.loadedMtime.get(filePath) ?? 0);
    } catch {
      return true; // can't stat: keep serving what we have
    }
  }

  private noteLoaded(filePath: string): void {
    try { this.loadedMtime.set(filePath, fs.statSync(filePath).mtimeMs); } catch { /* ignore */ }
    this.lastMtimeCheck.set(filePath, Date.now());
  }

  // Loads (and hot-reloads) one exchange's master file. A reload parses first and swaps only on success, so a half-written or corrupt
  // file keeps the working cache.
  private loadMaster(key: 'NFO' | 'BFO'): ContractRecord[] {
    const path = key === 'NFO' ? this.NFO_PATH : this.BFO_PATH;
    const read = (): ContractRecord[] => JSON.parse(fs.readFileSync(path, 'utf-8'))[key] || [];
    const cached = key === 'NFO' ? this.nfoCache : this.bfoCache;
    const store = (data: ContractRecord[]) => { if (key === 'NFO') this.nfoCache = data; else this.bfoCache = data; this.noteLoaded(path); };
    if (cached && !this.cacheIsFresh(path)) {
      Log.log(`[AntContractMaster] ${key} master file changed on disk - reloading`);
      try {
        store(read());
      } catch (e: any) {
        Log.log(`[AntContractMaster] ${key} reload failed, keeping the previous cache: ${e?.message ?? e}`);
      }
    }
    if (!(key === 'NFO' ? this.nfoCache : this.bfoCache)) {
      this.checkStaleness(path);
      store(read());
    }
    return (key === 'NFO' ? this.nfoCache : this.bfoCache)!;
  }

  private loadNFO(): ContractRecord[] { return this.loadMaster('NFO'); }
  private loadBFO(): ContractRecord[] { return this.loadMaster('BFO'); }

  private nseFailedAt = 0;

  // NSE cash-segment (equity) contract master - unlike NFO/BFO, no expiry
  // concept, so no staleness-driven missing-contract risk the way a stale
  // options file silently routes into the wrong expiry (see checkStaleness's
  // comment on that 2026-10-13 incident) - still warned the same way as a
  // courtesy, since a delisted/renamed symbol could otherwise go unnoticed.
  private loadNSE(): EquityRecord[] {
    // A failed load is retried after a cooldown instead of being cached as empty forever.
    if (!this.nseCache && this.nseFailedAt && Date.now() - this.nseFailedAt < 5 * 60 * 1000) {
      return [];
    }
    if (!this.nseCache) {
      // Missing/unreadable file (e.g. a fresh checkout - the NSE master is gitignored) degrades to an
      // empty table, cached, with one ALERT. Otherwise every findEquityToken call re-throws, which
      // aborts the whole universe loop instead of skipping the symbols.
      try {
        this.checkStaleness(this.NSE_PATH);
        const data = JSON.parse(fs.readFileSync(this.NSE_PATH, 'utf-8'));
        this.nseCache = data.NSE || [];
      } catch (e: any) {
        Log.log(`[AntContractMaster] ALERT: NSE equity contract master unavailable at ${this.NSE_PATH} (${e?.message ?? e}) - equity token lookups will return nothing until it is downloaded`);
        this.nseFailedAt = Date.now();
        this.nseBysymbol = new Map();
        return [];
      }
      this.nseFailedAt = 0;
      // Built once per process lifetime, not per lookup - ~9900 equity rows,
      // a linear scan per symbol (as findNearestStrikeOption does for options)
      // would be wasteful for a 100-symbol batch called once per trading day.
      this.nseBysymbol = new Map();
      for (const r of this.nseCache) {
        if (r['Group Name'] === 'EQ' && !this.nseBysymbol.has(r.Symbol)) this.nseBysymbol.set(r.Symbol, r);
      }
    }
    return this.nseCache;
  }

  // Resolves a plain NSE equity symbol (e.g. 'RELIANCE') to its ANT-native
  // cash-segment token - used by TopStockOptionsOpeningGapStrategy to fetch
  // each stock's own today's-open/prev-close directly from ANT instead of
  // the external Chartink/Yahoo-Finance screener. 'Group Name' === 'EQ'
  // filters out other listed instrument types sharing the same symbol
  // (rights/warrants/etc) - confirmed live: AliceBlue's NSE contract master
  // lists more than one row for some symbols, EQ is the plain equity line.
  findEquityToken(symbol: string): { token: string; exch: 'NSE' } | undefined {
    this.loadNSE();
    const record = this.nseBysymbol!.get(symbol);
    if (!record) return undefined;
    return { token: record.Token, exch: 'NSE' };
  }

  findOption(params: {
    symbol: string;
    exch: string;
    strike: string;
    optionType: string;
    expiryEpochMs: number;
  }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const { symbol, exch, strike, optionType, expiryEpochMs } = params;
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();

    const record = cache.find(
      (r) =>
        r.Symbol === symbol &&
        r.Exch === exch &&
        Number(r['Strike Price']) === Number(strike) &&
        r['Option Type'] === optionType &&
        parseInt(r['Expiry Date']) === expiryEpochMs
    );

    if (!record) {
      throw new Error(
        `Contract not found: ${symbol} ${exch} strike ${strike} ${optionType} expiry ${new Date(expiryEpochMs).toDateString()}`
      );
    }

    const tradingSymbol = tradingSymbolOf(record);
    return {
      token: record.Token,
      exch: record.Exch,
      tradingSymbol,
      lotSize: record['Lot Size'],
    };
  }

  // ATM-by-LTP resolution: rounds to the nearest strike step for the given
  // symbol, then delegates to findNearestExpiryOption. Mirrors
  // KiteContractMaster.findATMOption.
  findATMOption(underlyingLtp: number, optionType: string, symbol: string = 'NIFTY'): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const step = AntContractMaster.STRIKE_STEP[symbol] ?? 50;
    const atmStrike = Math.round(underlyingLtp / step) * step;
    const exch = exchangeForIndex(symbol);
    return this.findNearestExpiryOption({ symbol, exch, strike: atmStrike, optionType, expiryOffset: 0 });
  }

  // ATM-by-nearest-listed-strike resolution for symbols with no sane fixed
  // strike step (individual stocks - unlike NIFTY/SENSEX's flat 50/100,
  // strike increments vary wildly by price band, e.g. 2.5/5/10/20/50/100,
  // so findATMOption's STRIKE_STEP-rounding approach almost never lands on
  // a real listed strike). Instead picks whichever actually-listed strike
  // (for the nearest expiry >= today) is closest to referencePrice. Used by
  // TopStockOptionsOpeningGapStrategy.
  findNearestStrikeOption(symbol: string, optionType: string, referencePrice: number, exch: string = 'NFO'): { token: string; exch: string; tradingSymbol: string; lotSize: string; strike: number; expiry: string } {
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();
    const todayStart = todayStartUtc();

    const candidates = cache.filter(
      (r) => r.Symbol === symbol && r.Exch === exch && r['Option Type'] === optionType && parseInt(r['Expiry Date']) >= todayStart
    );
    if (candidates.length === 0) {
      throw new Error(`No ${symbol} ${exch} ${optionType} contract found for any strike (nearest expiry)`);
    }
    const nearestExpiry = Math.min(...candidates.map((r) => parseInt(r['Expiry Date'])));
    const atNearestExpiry = candidates.filter((r) => parseInt(r['Expiry Date']) === nearestExpiry);

    let best = atNearestExpiry[0];
    let bestDiff = Math.abs(Number(best['Strike Price']) - referencePrice);
    for (const r of atNearestExpiry) {
      const diff = Math.abs(Number(r['Strike Price']) - referencePrice);
      if (diff < bestDiff) {
        best = r;
        bestDiff = diff;
      }
    }

    return {
      token: best.Token,
      exch: best.Exch,
      tradingSymbol: tradingSymbolOf(best),
      lotSize: best['Lot Size'],
      strike: Number(best['Strike Price']),
      expiry: new Date(nearestExpiry).toISOString(),
    };
  }

  // Exact (symbol, strike, expiry, optionType) resolution, expiry given as a
  // date string (not epoch-ms) - mirrors KiteContractMaster.findExactOption's
  // caller contract. Converts internally to findOption's epoch-ms comparison.
  findExactOption(params: { symbol: string; strike: number; expiry: string; optionType: string }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const exch = exchangeForIndex(params.symbol);
    const expiryEpochMs = new Date(params.expiry).getTime();
    return this.findOption({
      symbol: params.symbol,
      exch,
      strike: String(params.strike),
      optionType: params.optionType,
      expiryEpochMs,
    });
  }

  // Canonical-symbol resolution: exact (symbol, strike, optionType), no
  // expiry given - resolves to the nearest expiry (expiryOffset=0) or the
  // Nth-nearest (expiryOffset=1 => "next", etc), same shape as
  // KiteContractMaster.findNearestExpiryOption. Now wired to the ANT order
  // path (see src/processes/order/antExecutor.ts).
  findNearestExpiryOption(params: {
    symbol: string;
    exch: string;
    strike: number;
    optionType: string;
    expiryOffset?: number;
  }): { token: string; exch: string; tradingSymbol: string; lotSize: string } {
    const { symbol, exch, strike, optionType, expiryOffset = 0 } = params;
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();
    // 'Expiry Date' is stored as midnight UTC of the expiry date (confirmed:
    // today's contract carries exactly 00:00:00 UTC = 5:30am IST) - comparing
    // against the raw current instant excluded a contract expiring LATER
    // TODAY for the rest of the trading day, every single week, since market
    // hours are entirely after 5:30am IST. Compare against the start of
    // today (UTC) instead, mirroring KiteContractMaster's day-truncated
    // comparison (`today.setHours(0,0,0,0)`) so a same-day expiry still counts.
    const todayStart = todayStartUtc();

    const candidates = cache
      .filter(
        (r) =>
          r.Symbol === symbol &&
          r.Exch === exch &&
          Number(r['Strike Price']) === strike &&
          r['Option Type'] === optionType &&
          parseInt(r['Expiry Date']) >= todayStart
      )
      .sort((a, b) => parseInt(a['Expiry Date']) - parseInt(b['Expiry Date']));

    const record = candidates[expiryOffset];
    if (!record) {
      throw new Error(`No ${symbol} ${exch} ${optionType} contract found for strike ${strike} (expiryOffset=${expiryOffset})`);
    }

    return {
      token: record.Token,
      exch: record.Exch,
      tradingSymbol: tradingSymbolOf(record),
      lotSize: record['Lot Size'],
    };
  }

  // The ANT-native token is the common/canonical token used everywhere
  // outside of a broker-specific API call (trade.token, exitMonitor's
  // live-tick subscription via dataProcess.ts) - ANT is the sole live-tick
  // source and only understands its own token scheme. A Kite
  // instrument_token must never be stored as trade.token: see
  // ToDo.md 2026-08-27, where a manual PE buy did exactly that, subscribed a
  // nonexistent instrument on ANT's feed, and the live price froze at the
  // fill price forever even though the position was actively trading.
  //
  // Every Kite-side contract lookup (findATMOption/findExactOption/
  // findNearestExpiryOption) has a same-shaped counterpart here - call this
  // alongside whichever one was used, with the same selector, to get the
  // common token to store instead of that call's instrument_token.
  resolveCommonToken(
    symbol: string,
    optionType: 'CE' | 'PE',
    selector: { atmLtp: number } | { strike: number; expiry: string } | { strike: number }
  ): string {
    if ('atmLtp' in selector) return this.findATMOption(selector.atmLtp, optionType, symbol).token;
    if ('expiry' in selector) return this.findExactOption({ symbol, strike: selector.strike, expiry: selector.expiry, optionType }).token;
    const exch = exchangeForIndex(symbol);
    return this.findNearestExpiryOption({ symbol, exch, strike: selector.strike, optionType }).token;
  }

  // Full option chain (both CE and PE, every strike) for the nearest expiry
  // >= today - used by the demo-mode contract search, which needs to offer a
  // pickable list of ANT-native (symbol, token) pairs rather than resolving
  // one strike at a time.
  listNearestExpiryOptions(symbol: string, exch: string = 'NFO'): { token: string; tradingSymbol: string; strike: number; optionType: string }[] {
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();
    const todayStart = todayStartUtc();
    const candidates = cache.filter((r) => r.Symbol === symbol && r.Exch === exch && parseInt(r['Expiry Date']) >= todayStart);
    if (candidates.length === 0) return [];
    const nearestExpiry = Math.min(...candidates.map((r) => parseInt(r['Expiry Date'])));
    return candidates
      .filter((r) => parseInt(r['Expiry Date']) === nearestExpiry)
      .map((r) => ({
        token: r.Token,
        tradingSymbol: tradingSymbolOf(r),
        strike: Number(r['Strike Price']),
        optionType: r['Option Type'],
      }));
  }

  // Recovers strike/optionType/exch/tradingSymbol from a common (ANT-native)
  // token alone - used by restart reconciliation (ContinuousStrategy.reconcile,
  // order's loadOpenTradesFromBroker) where only trade.token is known.
  // Deliberately a linear scan rather than a regex over the trading symbol -
  // the tsym format is ambiguous (expiry-code digits run into the strike,
  // e.g. NIFTY2690124200CE), so the cache is the only reliable source.
  findByToken(token: string): { strike: number; optionType: string; exch: string; tradingSymbol: string } | undefined {
    const record = this.loadNFO().find((r) => r.Token === token) || this.loadBFO().find((r) => r.Token === token);
    if (!record) return undefined;
    return {
      strike: Number(record['Strike Price']),
      optionType: record['Option Type'],
      exch: record.Exch,
      tradingSymbol: tradingSymbolOf(record),
    };
  }

  // The reverse of findByToken - resolves a stored trading symbol (e.g. from
  // a previous run's CSV output) back to its token, so a later re-quote hits
  // the exact same contract instead of re-deriving nearest-OTM against a spot
  // price that's since moved. Used by GapScreenerOptionQuoteEod.ts.
  findByTradingSymbol(tradingSymbol: string, exch: 'NFO' | 'BFO' = 'NFO'): { token: string; strike: number; optionType: string; exch: string; tradingSymbol: string; lotSize: string } | undefined {
    const cache = exch === 'NFO' ? this.loadNFO() : this.loadBFO();
    const record = cache.find((r) => tradingSymbolOf(r) === tradingSymbol);
    if (!record) return undefined;
    return {
      token: record.Token,
      strike: Number(record['Strike Price']),
      optionType: record['Option Type'],
      exch: record.Exch,
      tradingSymbol: tradingSymbolOf(record),
      lotSize: record['Lot Size'],
    };
  }
}

export default AntContractMaster;
