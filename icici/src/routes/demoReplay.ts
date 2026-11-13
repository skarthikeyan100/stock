/**
 * Demo replay: feeds the anonymous /demo page from one recorded day (CSV backups) instead of the live ANT feed, so Try Demo works while
 * the market is closed. Switched by settings in config.yml (hot-read, durable):
 *   demoReplay: true            # on/off
 *   demoReplayDate: Nov-13      # <Mon-DD> folder under the backup dir
 *   demoReplaySpeed: 10         # 1 = recorded speed (default 10)
 *   demoReplayDir: ~/later/data/backups   # optional
 * Replayed ticks go ONLY to the demo client sets held here, never to the authenticated /niftystream /optionstream clients or any broker
 * path, and /demo/subscribe in this mode never touches the strategies process.
 */
import express from 'express';
import Log from '../util/Log';
import configService from '../prism/ConfigService';
import AntContractMaster from '../ant/AntContractMaster';
import { loadReplayDay, ReplayDay, ReplayIndexTick, ReplayOptionTick, TickReplayer } from '../tools/tickReplay';

export interface DemoContract { token: string; tradingSymbol: string; strike: number; optionType: 'CE' | 'PE' }

const NIFTY_TOKEN = '26000';
const FRESH_VIRTUAL_MS = 5 * 60_000; // a contract counts as "ticking" if it traded within this much recorded time

export interface DemoReplaySettings { enabled: boolean; date: string; speed: number; dir?: string }

export function readDemoReplaySettings(): DemoReplaySettings {
    let s: any = {};
    try { s = (configService.getConfig()?.settings as any) ?? {}; } catch { /* config unreadable = off */ }
    const speed = Number(s.demoReplaySpeed);
    return {
        enabled: s.demoReplay === true,
        date: String(s.demoReplayDate ?? ''),
        speed: Number.isFinite(speed) && speed > 0 ? speed : 10,
        dir: s.demoReplayDir ? String(s.demoReplayDir) : undefined,
    };
}

class DemoReplay {
    readonly niftyClients = new Set<express.Response>();
    readonly optionClients = new Set<express.Response>();

    private day: ReplayDay | null = null;
    private loadedKey = '';
    private loading: Promise<void> | null = null;
    private loadError: string | null = null;
    private replayer: TickReplayer | null = null;
    private lastNifty: { ltp: number; ltt: number } | null = null;
    private virtualNowSec = 0;
    private tokenByTsym = new Map<string, DemoContract | null>();
    private lastOption = new Map<string, { ltp: number; ltt: number }>();
    private watched = new Set<string>(); // tokens a demo user holds: only these are streamed
    private contractList: DemoContract[] = [];

    isEnabled(): boolean { return readDemoReplaySettings().enabled; }

    status(): { replay: boolean; date?: string; ready?: boolean; error?: string } {
        const s = readDemoReplaySettings();
        if (!s.enabled) return { replay: false };
        return { replay: true, date: s.date, ready: !!this.day && this.loadedKey === this.key(s), error: this.loadError ?? undefined };
    }

    private key(s: DemoReplaySettings): string { return `${s.dir ?? ''}|${s.date}`; }

    private hasClients(): boolean { return this.niftyClients.size + this.optionClients.size > 0; }

    /** Called when a demo stream connects: loads the configured day once (async) and starts the paced emitter. */
    ensureStarted(): void {
        const s = readDemoReplaySettings();
        if (!s.enabled) return;
        const key = this.key(s);
        if (this.loadedKey !== key) {
            this.resetDay();
            if (!this.loading) {
                this.loading = this.load(s, key).finally(() => {
                    this.loading = null;
                    // A failed load is retried on the next demo connection, not in a tight loop; a config change during the load reloads at once.
                    if (!this.loadError) this.ensureStarted();
                });
            }
            return;
        }
        if (this.replayer && !this.replayer.running) this.replayer.start();
    }

    private resetDay(): void {
        this.replayer?.stop();
        this.replayer = null;
        this.day = null;
        this.lastNifty = null;
        this.lastOption.clear();
        this.tokenByTsym.clear();
        this.contractList = [];
        this.loadedKey = '';
    }

    private async load(s: DemoReplaySettings, key: string): Promise<void> {
        try {
            this.loadError = null;
            const day = await loadReplayDay(s.dir, s.date);
            // A config change during the (seconds-long) load makes this day stale: drop it and let ensureStarted() reload.
            if (this.key(readDemoReplaySettings()) !== key) return;
            const symbols = new Set(day.options.map((o) => o.tsym));
            const resolved = AntContractMaster.getInstance().mapTradingSymbols(symbols);
            const contracts = new Map<string, DemoContract>();
            const meta = new Map<string, ReplayOptionTick>();
            for (const t of day.options) if (!meta.has(t.tsym)) meta.set(t.tsym, t);
            for (const [tsym, t] of meta) {
                const hit = resolved.get(tsym);
                const c: DemoContract | null = hit ? { token: hit.token, tradingSymbol: hit.tradingSymbol, strike: t.strike, optionType: t.optionType } : null;
                this.tokenByTsym.set(tsym, c);
                if (c) contracts.set(c.token, c);
            }
            this.contractList = [...contracts.values()].sort((a, b) => a.strike - b.strike || a.optionType.localeCompare(b.optionType));
            this.day = day;
            this.loadedKey = key;
            this.replayer = new TickReplayer(day, () => readDemoReplaySettings().speed, {
                nifty: (t) => this.onNifty(t),
                option: (t) => this.onOption(t),
            }, () => this.shouldRun());
            Log.log(`[demo-replay] loaded ${s.date}: ${day.nifty.length} NIFTY ticks, ${day.options.length} option ticks, ${this.contractList.length} contracts with a token (of ${this.tokenByTsym.size} symbols)`);
        } catch (e: any) {
            this.loadError = e?.message ?? String(e);
            Log.log('[demo-replay] load failed:', this.loadError);
        }
    }

    // Parks the emitter when nobody watches or the switch is off; switching it off also ends the replay streams so clients reconnect to the live ones.
    private shouldRun(): boolean {
        if (!this.isEnabled()) {
            for (const res of [...this.niftyClients, ...this.optionClients]) { try { res.end(); } catch { /* already closed */ } }
            this.niftyClients.clear();
            this.optionClients.clear();
            return false;
        }
        return this.hasClients();
    }

    private onNifty(t: ReplayIndexTick): void {
        this.lastNifty = t;
        this.virtualNowSec = t.ltt;
        const payload = `data: ${JSON.stringify({ nifty: this.niftyQuote(t) })}\n\n`;
        for (const res of this.niftyClients) res.write(payload);
    }

    private niftyQuote(t: ReplayIndexTick): Record<string, unknown> {
        const prev = this.day?.prevClose ?? this.day?.nifty[0]?.ltp;
        const change = prev ? t.ltp - prev : undefined;
        return { token: NIFTY_TOKEN, ltp: t.ltp, ltt: String(t.ltt), prevClose: prev, change, changePercent: prev && change !== undefined ? (change / prev) * 100 : undefined };
    }

    private onOption(t: ReplayOptionTick): void {
        this.virtualNowSec = Math.max(this.virtualNowSec, t.ltt);
        const c = this.tokenByTsym.get(t.tsym);
        if (!c) return;
        this.lastOption.set(c.token, { ltp: t.ltp, ltt: t.ltt });
        if (!this.watched.has(c.token) || this.optionClients.size === 0) return;
        const payload = `data: ${JSON.stringify({ token: c.token, ltp: t.ltp, ltt: String(t.ltt) })}\n\n`;
        for (const res of this.optionClients) res.write(payload);
    }

    /** First message for a client connecting to the NIFTY stream (same role as the live lastNiftyQuote replay). */
    replayNifty(): string | null {
        return this.lastNifty ? `data: ${JSON.stringify({ nifty: this.niftyQuote(this.lastNifty) })}\n\n` : null;
    }

    lastNiftyLtp(): number | null { return this.lastNifty?.ltp ?? null; }

    /** Contracts of the recorded day that have a token in the ANT contract master (so a pick always ticks). */
    contracts(): DemoContract[] { return this.contractList; }

    /** ATM contract (nearest strike to the replayed NIFTY) of the wanted side, preferring ones that traded recently in recorded time. */
    resolveATM(optionType: 'CE' | 'PE'): DemoContract | null {
        const ltp = this.lastNifty?.ltp;
        if (!ltp) return null;
        const side = this.contractList.filter((c) => c.optionType === optionType);
        if (side.length === 0) return null;
        const fresh = side.filter((c) => {
            const l = this.lastOption.get(c.token);
            return !!l && this.virtualNowSec - l.ltt <= FRESH_VIRTUAL_MS / 1000;
        });
        const pool = fresh.length > 0 ? fresh : side;
        return pool.reduce((best, c) => (Math.abs(c.strike - ltp) < Math.abs(best.strike - ltp) ? c : best));
    }

    /** A demo user started/stopped holding a token: only held tokens are streamed. A new hold gets the last known price straight away. */
    setWatched(token: string, watched: boolean): void {
        if (!watched) { this.watched.delete(token); return; }
        this.watched.add(token);
        const l = this.lastOption.get(token);
        if (l && this.optionClients.size > 0) {
            const payload = `data: ${JSON.stringify({ token, ltp: l.ltp, ltt: String(l.ltt) })}\n\n`;
            for (const res of this.optionClients) res.write(payload);
        }
    }
}

export const demoReplay = new DemoReplay();
