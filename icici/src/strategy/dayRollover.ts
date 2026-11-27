import Log from '../util/Log';
import { PlatformSell, readPlatformSells, unseenSells } from './platformSells';

// What a strategy says about what an EARLIER day's state file still shows unfinished (open legs, unconfirmed buys), when it first loads on a new day.
// Why (live 2026-11-25 14:40): the combined max-profit lock disabled the strategies and limit-sold every open leg. A disabled strategy is told of no
// fill, so its state still showed the legs open, and the next start ALERTed "still open when the day rolled over" for legs the platform's own sells had
// closed. The rule (trader doc, Lock profits item 6): a leg the platform's own sell closed is a normal close (a plain line, no alert); an ALERT only
// when no platform sell explains the leg.
// An unexplained item is ALERTed ONCE and its record stays in the new day's state (`carried`), so it survives the file being replaced and is only
// mentioned by a plain line on later loads. No order, cancel or booking happens here (it also runs for disabled strategies): the platform's sells are
// read, lines are logged and the strategy's own state is saved with what was said.

export type CarriedKind = 'leg' | 'pendingBuy';

// What a strategy hands over about one leg (or unconfirmed buy) of the earlier day's state.
export interface CarriedInput {
    kind?: CarriedKind;
    broker: string;    // the broker it was held (or bought) at
    tsym: string;
    open: boolean;     // unfinished when the day rolled over: only these are reported (the others only count for a legacy state's seen quantity)
    remaining: number; // open items: the quantity the platform's sells must cover for it to be explained
    accounted: number; // the quantity the strategy had already been told was sold (a closed leg: all of it)
    alert: string;     // the strategy's ALERT line for it, ending in what to check
    record: unknown;   // the leg / pending buy as the earlier day's state held it
}

export interface CarriedItem {
    kind: CarriedKind; broker: string; tsym: string; remaining: number; alert: string; record: unknown;
    alertedAt?: number; // set when its ALERT was logged: it is never ALERTed again
    recheck?: boolean;  // the platform's sells could not be read when it was ALERTed: looked up again on the next load
}

// What one earlier day left unresolved, with what is needed to look the platform's sells up again.
export interface CarriedBatch {
    day: string;
    until: number;                    // when the following day's state was first loaded: a sell made after that is not evidence
    seenIds: string[] | null;         // order ids the strategy booked that day; null = a legacy state (see platformSells.ts SeenSells)
    sellQtys?: Record<string, number>; // quantity booked per order id, for the orders booked from a fill event
    legacySeen: Record<string, number>; // legacy state only: quantity already accounted for per `${broker}|${tsym}`
    items: CarriedItem[];
}

export interface EarlierDay { day: string; carried?: CarriedBatch[]; sellIdsTracked?: boolean; seenSells?: string[]; sellQtys?: Record<string, number> }

// The `carried` list the new day's state starts with: what was already carried, plus what the earlier day's state left unfinished.
// A paper position lives only in the order process's memory: there is no broker position to check, so it is never carried or reported.
export function carryOver(earlier: EarlierDay, legs: CarriedInput[], now = Date.now()): CarriedBatch[] {
    const before = earlier.carried ?? [];
    const real = legs.filter((l) => l.broker !== 'paper');
    const items: CarriedItem[] = real.filter((l) => l.open).map((l) => ({ kind: l.kind ?? 'leg', broker: l.broker, tsym: l.tsym, remaining: l.remaining, alert: l.alert, record: l.record }));
    if (items.length === 0) return before;
    const legacySeen: Record<string, number> = {};
    for (const l of real) legacySeen[`${l.broker}|${l.tsym}`] = (legacySeen[`${l.broker}|${l.tsym}`] ?? 0) + l.accounted;
    return [...before, { day: earlier.day, until: now, seenIds: earlier.sellIdsTracked ? [...(earlier.seenSells ?? [])] : null, sellQtys: { ...(earlier.sellQtys ?? {}) }, legacySeen, items }];
}

export interface RolloverContext {
    tag: string; userId: string;
    batches: CarriedBatch[]; // the state's own `carried` list, updated in place
    persist: () => void;     // saves the strategy's state
    attempts?: number;       // reads of the platform's sells before giving up (the order process / Mongo may still be coming up)
    delayMs?: number;
}

export async function reportCarried(ctx: RolloverContext): Promise<void> {
    const reminders: string[] = [];
    let changed = false;
    for (const batch of [...ctx.batches]) {
        const groups = new Map<string, CarriedItem[]>();
        for (const item of batch.items) {
            if (item.alertedAt && !item.recheck) { reminders.push(`${item.kind === 'pendingBuy' ? 'unconfirmed buy ' : ''}${item.broker} ${item.tsym} (${item.remaining}) from ${batch.day}`); continue; }
            const key = `${item.broker}|${item.tsym}`;
            groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        for (const [key, items] of groups) {
            changed = true;
            await checkContract(ctx, batch, key, items.sort((a, b) => Number(a.kind === 'pendingBuy') - Number(b.kind === 'pendingBuy'))); // the legs are covered first
        }
        if (batch.items.length === 0) { const i = ctx.batches.indexOf(batch); if (i >= 0) ctx.batches.splice(i, 1); }
    }
    if (reminders.length > 0) Log.log(`[${ctx.tag}] still on record in the state file as unresolved from earlier days (reported once already): ${reminders.join('; ')}`);
    if (changed) ctx.persist();
}

async function checkContract(ctx: RolloverContext, batch: CarriedBatch, key: string, items: CarriedItem[]): Promise<void> {
    const { broker, tsym } = items[0];
    // The ALERT is logged once per item; a later look at the same item only adds a plain line.
    const unexplained = (item: CarriedItem, why: string, recheck: boolean) => {
        if (!item.alertedAt) { Log.log(`[${ctx.tag}] ALERT: ${item.alert} (${why})`); item.alertedAt = Date.now(); }
        else Log.log(`[${ctx.tag}] ${item.broker} ${item.tsym} from ${batch.day} is still unresolved (${why}; reported already, the record stays in the state file)`);
        item.recheck = recheck;
    };
    try {
        let sells: PlatformSell[] | null = null;
        const attempts = ctx.attempts ?? 3;
        for (let i = 0; i < attempts && !sells; i++) {
            if (i > 0) await new Promise((resolve) => setTimeout(resolve, ctx.delayMs ?? 2000));
            sells = await readPlatformSells(ctx.userId, broker, tsym, batch.day);
        }
        if (!sells) { for (const item of items) unexplained(item, "the platform's own sells could not be read", true); return; }
        const pool = unseenSells(sells.filter((s) => !(s.at > batch.until)), { ids: batch.seenIds ? new Set(batch.seenIds) : null, legacyQty: batch.legacySeen[key] ?? 0, partQty: batch.sellQtys });
        const usable = (pool ?? []).filter((s) => s.quantity > 0);
        const total = usable.reduce((sum, s) => sum + s.quantity, 0);
        const price = total > 0 ? usable.reduce((sum, s) => sum + s.quantity * s.price, 0) / total : 0;
        let left = total;
        for (const item of items) {
            const covered = Math.min(Math.max(0, item.remaining), left);
            left -= covered;
            if (item.remaining > 0 && covered >= item.remaining) {
                const by = `the platform's own order(s) ${usable.map((s) => s.orderId).join(', ')} @ ${price.toFixed(2)}`;
                const what = item.kind === 'pendingBuy'
                    ? `the unconfirmed buy of ${item.remaining} had filled and was sold again: ${by} sold that many beyond the recorded legs`
                    : `${item.remaining} lots shown open were sold by ${by} (the strategy was not told)`;
                Log.log(`[${ctx.tag}] ${item.broker} ${item.tsym} from ${batch.day}: ${what} - a normal close, nothing to check`);
                batch.items.splice(batch.items.indexOf(item), 1);
            } else {
                unexplained(item, covered > 0 ? `the platform's own sells explain only ${covered} of ${item.remaining}` : "no sell of the platform's own explains it", false);
            }
        }
    } catch (e: any) {
        for (const item of items) if (batch.items.includes(item)) unexplained(item, `the check against the platform's own sells failed: ${e?.message ?? e}`, true);
    }
}
