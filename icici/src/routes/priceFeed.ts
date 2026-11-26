import express from 'express';
import Log from '../util/Log';
import AntContractMaster from '../ant/AntContractMaster';
import OrderClient from '../processes/strategies/OrderClient';
import { DataLink } from '../ipc/DataLink';
import { parseCanonicalSymbol, formatCanonicalSymbol } from '../model/CanonicalSymbol';
import { exchangeForIndex, exchangeForTsym } from '../util/underlyings';

// The trading page's price stream (GET /order/pricestream): the live ANT tick price of every contract the page can buy or sell at a click
// (the two Flash Trade contracts of the selected index, the contract picked in Search & Buy, the viewer's open positions), each with its age,
// plus the viewer's resting orders. The page sends back the exact price it showed as the order's limit. Read-only: it subscribes ticks, places
// nothing. Prices come from the data feed only (no broker REST call per viewer).

export type PageIndex = 'NIFTY' | 'SENSEX';
type OptionType = 'CE' | 'PE';
type Exchange = 'NFO' | 'BFO';

interface Quote { contract: string; strike: number; token: string; tradingSymbol: string; price: number | null; ageMs: number | null }
interface Wanted { token: string; exchange: Exchange }
interface Client { res: express.Response; user: string; index: PageIndex; contract: string | null; signature: string; sentAt: number }

const SPOT_MAX_AGE_MS = 15_000; // an index value older than this picks no Flash Trade contract
const STRIKE_SETTLE_MS = 1_500; // a new at-the-money strike must hold this long, so the buttons do not flip under the finger
const PUSH_MS = 250;
const HEARTBEAT_MS = 2_000;
const ORDER_STATE_MS = 1_500;
const UNUSED_TOKEN_MS = 60_000;
const MAX_TOKENS = 400;
const MAX_CLIENTS_PER_USER = 6;
const FLASH_ISSUED_MS = 60_000;

const orderClient = OrderClient.getInstance();
const clients = new Set<Client>();
const spots: Partial<Record<PageIndex, { ltp: number; at: number }>> = {};
const prices = new Map<string, { ltp: number; at: number }>();
const watched = new Map<string, { exchange: Exchange; neededAt: number }>();
const strikes = new Map<string, { strike: number; next?: number; since?: number }>();
const flashIssued = new Map<string, number>(); // `${user}|${index}|${type}|${strike}` -> last time shown to that user
let orderState: { pending: any[]; positions: Array<{ user: string; broker: string; tsym: string; token: string }>; outcomes: any[] } = { pending: [], positions: [], outcomes: [] };
let orderStateAt = 0;
let orderStateBusy = false;

/** server.ts's tick handler. */
export function onPriceTick(tick: any): void {
    const ltp = Number(tick?.quote?.ltp);
    if (!(ltp > 0)) return;
    if (tick.type === 'nifty') spots.NIFTY = { ltp, at: Date.now() };
    else if (tick.type === 'sensex') spots.SENSEX = { ltp, at: Date.now() };
    else if (tick.type === 'option') {
        const token = String(tick.quote.token);
        if (watched.has(token)) prices.set(token, { ltp, at: Date.now() });
    }
}

/** Level gating (Flash Trade): true when this exact contract was on the user's Flash Trade button within the last minute. */
export function wasFlashContractShown(user: string, index: string, right: string, strike: number): boolean {
    const at = flashIssued.get(`${user}|${index}|${right === 'put' ? 'PE' : 'CE'}|${strike}`);
    return at !== undefined && Date.now() - at <= FLASH_ISSUED_MS;
}

function want(w: Wanted, now: number): void {
    const held = watched.get(w.token);
    if (held) { held.neededAt = now; return; }
    if (watched.size >= MAX_TOKENS) return;
    watched.set(w.token, { exchange: w.exchange, neededAt: now });
    DataLink.getInstance().subscribe('prices', { cmd: 'subscribe', token: w.token, source: 'ant', exchange: w.exchange });
}

function releaseUnused(now: number): void {
    for (const [token, w] of Array.from(watched)) {
        if (now - w.neededAt < UNUSED_TOKEN_MS) continue;
        watched.delete(token);
        prices.delete(token);
        DataLink.getInstance().subscribe('prices', { cmd: 'unsubscribe', token, source: 'ant', exchange: w.exchange });
    }
}

function quoteOf(contract: string, strike: number, token: string, tradingSymbol: string, now: number): Quote {
    const p = prices.get(token);
    return { contract, strike, token, tradingSymbol, price: p?.ltp ?? null, ageMs: p ? now - p.at : null };
}

// Contract lookups scan the whole contract master, and the push runs several times a second for every viewer: each answer is kept for a short while.
const LOOKUP_TTL_MS = 30_000;
const lookups = new Map<string, { value?: unknown; at: number }>(); // no value: the lookup failed (logged once, retried after the TTL)
function remembered<T>(key: string, now: number, find: () => T): T | null {
    const hit = lookups.get(key);
    if (hit && now - hit.at < LOOKUP_TTL_MS) return (hit.value ?? null) as T | null;
    if (lookups.size > 5_000) lookups.clear();
    let value: T | undefined;
    try { value = find(); } catch (e: any) { Log.log(`[priceFeed] contract lookup ${key} failed:`, e?.message ?? e); }
    lookups.set(key, { value, at: now });
    return value ?? null;
}
const nearestContract = (symbol: string, strike: number, optionType: OptionType, now: number) =>
    remembered(`c|${symbol}|${strike}|${optionType}`, now, () => AntContractMaster.getInstance().findNearestExpiryOption({ symbol, exch: exchangeForIndex(symbol), strike, optionType }));

// The contract Flash Trade would buy now: the same entry strike every broker's market entry uses (AntContractMaster.entryStrike), nearest expiry.
function flashQuote(index: PageIndex, optionType: OptionType, now: number): Quote | null {
    const spot = spots[index];
    if (!spot || now - spot.at > SPOT_MAX_AGE_MS) return null;
    // The entry strike changes only with the at-the-money strike, so it is looked up once per at-the-money step.
    const step = AntContractMaster.STRIKE_STEP[index];
    const atm = Math.round(spot.ltp / step) * step;
    const candidate = remembered(`e|${index}|${optionType}|${atm}`, now, () => AntContractMaster.getInstance().entryStrike(atm, optionType, index));
    if (candidate === null) return null;
    const key = `${index}|${optionType}`;
    let s = strikes.get(key);
    if (!s) { s = { strike: candidate }; strikes.set(key, s); }
    if (candidate === s.strike) { s.next = undefined; s.since = undefined; }
    else if (s.next !== candidate) { s.next = candidate; s.since = now; }
    else if (now - (s.since ?? now) >= STRIKE_SETTLE_MS) { s.strike = candidate; s.next = undefined; s.since = undefined; }
    const c = nearestContract(index, s.strike, optionType, now);
    if (!c) return null;
    want({ token: String(c.token), exchange: c.exch as Exchange }, now);
    return quoteOf(formatCanonicalSymbol({ symbol: index, strike: s.strike, optionType }), s.strike, String(c.token), c.tradingSymbol, now);
}

function contractQuote(contract: string, now: number): Quote | null {
    const c = parseCanonicalSymbol(contract);
    const r = nearestContract(c.symbol, c.strike, c.optionType, now);
    if (!r) return null;
    want({ token: String(r.token), exchange: r.exch as Exchange }, now);
    return quoteOf(contract, c.strike, String(r.token), r.tradingSymbol, now);
}

// ANT's token of a position: the position's own token, except a Breeze position (keyed by Breeze's token) which is found by its trading symbol.
function antTokenOf(p: { broker: string; tsym: string; token: string }): string | null {
    if (p.broker !== 'breeze') return p.token;
    return remembered(`b|${p.tsym}`, Date.now(), () => AntContractMaster.getInstance().findByAnyBrokerTradingSymbol(p.tsym, exchangeForTsym(p.tsym))?.token);
}

function messageFor(client: Client, now: number): object {
    const flash = { call: flashQuote(client.index, 'CE', now), put: flashQuote(client.index, 'PE', now) };
    for (const [type, q] of [['CE', flash.call], ['PE', flash.put]] as const) if (q && q.price !== null) flashIssued.set(`${client.user}|${client.index}|${type}|${q.strike}`, now);
    const positions = orderState.positions.filter((p) => p.user === client.user).map((p) => {
        const token = antTokenOf(p);
        if (token) want({ token, exchange: exchangeForTsym(p.tsym) }, now);
        const price = token ? prices.get(token) : undefined;
        return { broker: p.broker, tsym: p.tsym, token: p.token, price: price?.ltp ?? null, ageMs: price ? now - price.at : null };
    });
    const fresh = now - orderStateAt < 10_000;
    return {
        index: client.index,
        flash,
        contract: client.contract ? contractQuote(client.contract, now) : null,
        positions,
        // null while the order process cannot be read: the page keeps what it had instead of showing "no pending order".
        pending: fresh ? orderState.pending.filter((o) => o.userId === client.user) : null,
        outcomes: fresh ? orderState.outcomes.filter((o) => o.userId === client.user) : null,
    };
}

function refreshOrderState(): void {
    if (orderStateBusy) return;
    orderStateBusy = true;
    orderClient.userOrderState()
        .then((s) => { orderState = s; orderStateAt = Date.now(); })
        .catch(() => undefined) // reported to the page as pending: null; an order process without this request type never answers it
        .finally(() => { orderStateBusy = false; });
}

function push(client: Client, now: number): void {
    const message = messageFor(client, now);
    // Ages change on every pass: they alone do not make a new message (the page counts them up itself).
    const signature = JSON.stringify(message, (k, v) => (k === 'ageMs' ? (v === null ? null : v < 1000 ? 'fresh' : Math.floor(v / 5000)) : v));
    if (signature === client.signature && now - client.sentAt < HEARTBEAT_MS) return;
    client.signature = signature;
    client.sentAt = now;
    client.res.write(`data: ${JSON.stringify(message)}\n\n`);
}

let timer: NodeJS.Timeout | null = null;
let lastOrderStatePoll = 0;
function tick(): void {
    const now = Date.now();
    releaseUnused(now);
    for (const [k, at] of flashIssued) if (now - at > FLASH_ISSUED_MS) flashIssued.delete(k);
    if (clients.size === 0) {
        if (watched.size === 0 && timer) { clearInterval(timer); timer = null; }
        return;
    }
    if (now - lastOrderStatePoll >= ORDER_STATE_MS) { lastOrderStatePoll = now; refreshOrderState(); }
    for (const c of clients) {
        try { push(c, now); } catch (e) { Log.log('[priceFeed] push failed:', e); }
    }
}

/** Adds one SSE client (the response is already open as a stream). A user's oldest stream is closed when too many are open. */
export function addPriceClient(res: express.Response, user: string, index: PageIndex, contract: string | null): void {
    let mine = 0;
    for (const c of clients) if (c.user === user) mine++;
    if (mine >= MAX_CLIENTS_PER_USER) {
        const oldest = Array.from(clients).find((c) => c.user === user)!;
        clients.delete(oldest);
        oldest.res.end();
    }
    clients.add({ res, user, index, contract, signature: '', sentAt: 0 });
    refreshOrderState();
    if (!timer) timer = setInterval(tick, PUSH_MS);
}

export function removePriceClient(res: express.Response): void {
    for (const c of clients) if (c.res === res) clients.delete(c);
}

export function priceStreamResponses(): express.Response[] {
    return Array.from(clients, (c) => c.res);
}
