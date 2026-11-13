/**
 * Replays one recorded NIFTY day (public/demo-ticks.txt: `ltt,sym,ltp`, thinned by src/tools/makeDemoTicks.ts) inside the browser, so Try
 * Demo works with the market closed and with the trading server down. No DOM and no React here (pure, so it can be tested on its own).
 * Pacing follows the recorded `ltt` gaps divided by DEMO_SPEED; at the end of the day it pauses and starts again from the open.
 */

export const DEMO_TICKS_URL = '/demo-ticks.txt';
export const DEMO_SPEED = 10;
const RESTART_PAUSE_MS = 3000;
const FRESH_VIRTUAL_S = 5 * 60; // a contract counts as "ticking" if it traded within this much recorded time

export interface DemoContract { token: string; tradingSymbol: string; strike: number; optionType: 'CE' | 'PE' }
export interface DemoNiftyTick { ltp: number; ltt: string; prevClose: number; change: number; changePercent: number }

interface Tick { t: number; sym: string; ltp: number }
export interface ParsedDemoTicks { ticks: Tick[]; contracts: DemoContract[] }

// "NIFTY17NOV26C25150" -> strike 25150, call. The trading symbol is the contract's token here (there is no broker feed to subscribe).
const OPTION_SYM = /([CP])(\d+)$/;

export function parseDemoTicks(text: string): ParsedDemoTicks {
  const ticks: Tick[] = [];
  const contracts = new Map<string, DemoContract>();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) { // line 0 is the header
    const line = lines[i];
    if (!line) continue;
    const a = line.indexOf(',');
    const b = line.lastIndexOf(',');
    if (a < 0 || b <= a) continue;
    const t = Number(line.slice(0, a));
    const sym = line.slice(a + 1, b);
    const ltp = Number(line.slice(b + 1));
    if (!Number.isFinite(t) || !(ltp > 0) || !sym) continue;
    ticks.push({ t, sym, ltp });
    if (sym !== 'NIFTY' && !contracts.has(sym)) {
      const m = OPTION_SYM.exec(sym);
      if (m) contracts.set(sym, { token: sym, tradingSymbol: sym, strike: Number(m[2]), optionType: m[1] === 'P' ? 'PE' : 'CE' });
    }
  }
  if (!ticks.some((t) => t.sym === 'NIFTY')) throw new Error('demo ticks have no NIFTY rows');
  ticks.sort((x, y) => x.t - y.t);
  const list = [...contracts.values()].sort((x, y) => x.strike - y.strike || x.optionType.localeCompare(y.optionType));
  return { ticks, contracts: list };
}

export interface DemoFeedListener {
  nifty?: (tick: DemoNiftyTick) => void;
  option?: (token: string, ltp: number, ltt: number) => void;
  /** The recorded day ended and starts over: open demo positions should be closed (prices jump back to the open). */
  restart?: () => void;
}

export class DemoFeed {
  private data: ParsedDemoTicks | null = null;
  private loading: Promise<void> | null = null;
  private readonly listeners = new Set<DemoFeedListener>();
  private idx = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private virtualBaseMs = 0;
  private realBaseMs = 0;
  private lastNiftyTick: DemoNiftyTick | null = null;
  private firstNifty = 0;
  private readonly lastOption = new Map<string, { ltp: number; ltt: number }>();
  private virtualNowS = 0;

  /** Fetches and parses the CSV once; a failure is not cached, so the next call retries. */
  load(fetchText: () => Promise<string> = defaultFetch): Promise<void> {
    if (this.data) return Promise.resolve();
    if (!this.loading) {
      this.loading = fetchText()
        .then((text) => { this.data = parseDemoTicks(text); this.firstNifty = this.data.ticks.find((t) => t.sym === 'NIFTY')!.ltp; })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  isLoaded(): boolean { return this.data !== null; }

  /** Starts delivering (and catches the listener up with the latest prices); the feed runs while anyone listens. */
  subscribe(l: DemoFeedListener): () => void {
    this.listeners.add(l);
    if (this.lastNiftyTick) l.nifty?.(this.lastNiftyTick);
    this.startIfNeeded();
    return () => {
      this.listeners.delete(l);
      if (this.listeners.size === 0) this.stop();
    };
  }

  contracts(): DemoContract[] { return this.data?.contracts ?? []; }
  lastNifty(): DemoNiftyTick | null { return this.lastNiftyTick; }
  lastPrice(token: string): number | undefined { return this.lastOption.get(token)?.ltp; }

  /** The recorded day, e.g. "13 Nov 2026" (IST). */
  dateLabel(): string | null {
    const first = this.data?.ticks[0];
    if (!first) return null;
    return new Date(first.t * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  }

  /** At-the-money contract of the wanted side (nearest strike to the replayed NIFTY), preferring ones that traded recently. */
  resolveATM(right: 'call' | 'put' | string): DemoContract | null {
    const nifty = this.lastNiftyTick?.ltp;
    if (!nifty) return null;
    const type = right === 'put' ? 'PE' : 'CE';
    const side = this.contracts().filter((c) => c.optionType === type);
    if (side.length === 0) return null;
    const fresh = side.filter((c) => { const l = this.lastOption.get(c.token); return !!l && this.virtualNowS - l.ltt <= FRESH_VIRTUAL_S; });
    const pool = fresh.length > 0 ? fresh : side;
    return pool.reduce((best, c) => (Math.abs(c.strike - nifty) < Math.abs(best.strike - nifty) ? c : best));
  }

  private startIfNeeded(): void {
    if (this.timer || !this.data) return;
    const next = this.data.ticks[this.idx];
    this.virtualBaseMs = (next ? next.t : this.data.ticks[0].t) * 1000;
    this.realBaseMs = Date.now();
    this.schedule(0);
  }

  private stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => this.step(), Math.max(0, ms));
  }

  private step(): void {
    this.timer = null;
    if (!this.data || this.listeners.size === 0) return;
    const ticks = this.data.ticks;
    const virtual = this.virtualBaseMs + (Date.now() - this.realBaseMs) * DEMO_SPEED;
    while (this.idx < ticks.length && ticks[this.idx].t * 1000 <= virtual) this.emit(ticks[this.idx++]);
    if (this.idx >= ticks.length) {
      this.idx = 0;
      this.lastOption.clear();
      for (const l of [...this.listeners]) l.restart?.();
      this.virtualBaseMs = ticks[0].t * 1000;
      this.realBaseMs = Date.now() + RESTART_PAUSE_MS;
      this.schedule(RESTART_PAUSE_MS);
      return;
    }
    const wait = (ticks[this.idx].t * 1000 - virtual) / DEMO_SPEED;
    this.schedule(Math.min(1000, Math.max(20, wait)));
  }

  private emit(tick: Tick): void {
    this.virtualNowS = Math.max(this.virtualNowS, tick.t);
    if (tick.sym === 'NIFTY') {
      const change = tick.ltp - this.firstNifty;
      const n: DemoNiftyTick = { ltp: tick.ltp, ltt: String(tick.t), prevClose: this.firstNifty, change, changePercent: (change / this.firstNifty) * 100 };
      this.lastNiftyTick = n;
      for (const l of [...this.listeners]) l.nifty?.(n);
    } else {
      this.lastOption.set(tick.sym, { ltp: tick.ltp, ltt: tick.t });
      for (const l of [...this.listeners]) l.option?.(tick.sym, tick.ltp, tick.t);
    }
  }
}

async function defaultFetch(): Promise<string> {
  const res = await fetch(DEMO_TICKS_URL, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`demo ticks: HTTP ${res.status}`);
  return res.text();
}

export const demoFeed = new DemoFeed();
