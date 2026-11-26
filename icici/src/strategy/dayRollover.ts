import Log from '../util/Log';
import { PlatformSell, readPlatformSells, unseenSells } from './platformSells';

// What a strategy says about the legs an EARLIER day's state file still shows open, when it first loads on a new day.
// Why (live 2026-11-25 14:40): the overall max-profit lock disabled the strategies and limit-sold every open leg. A disabled strategy is told of no
// fill, so its state still showed the legs open, and the next start ALERTed "still open when the day rolled over" for legs the platform's own sells had
// closed. The rule (trader doc, Lock profits item 6): a leg the platform's own sell closed is a normal close (a plain line, no alert); an ALERT only
// when no platform sell explains the leg.
// Read-only: nothing is booked, ordered or written here (it also runs for disabled strategies). The old day's state is not carried over.

export interface CarriedLeg {
    broker: string;    // the broker the leg was held at
    tsym: string;
    open: boolean;     // still open when the day rolled over: only these are reported (the others only count for a legacy state's seen quantity)
    remaining: number; // open legs: the quantity the platform's sells must cover for the leg to be explained
    accounted: number; // the quantity of the leg the strategy had already been told was sold (a closed leg: all of it)
    alert: string;     // the strategy's ALERT line for this leg ("<contract> from <day> was still ... - check the broker position by hand")
}

export interface RolloverContext {
    tag: string; userId: string; fromDay: string;
    legs: CarriedLeg[];
    seenIds: Set<string> | null; // order ids the strategy booked that day; null = a legacy state (see platformSells.ts SeenSells)
    attempts?: number;           // reads of the platform's sells before giving up (the order process / Mongo may still be coming up)
    delayMs?: number;
}

export async function reportCarriedLegs(ctx: RolloverContext): Promise<void> {
    const loadedAt = Date.now(); // a sell made after the new day's state was loaded belongs to the new day
    const groups = new Map<string, CarriedLeg[]>();
    // A paper position lives only in the order process's memory: there is no broker position to check, so it is never reported.
    for (const l of ctx.legs) {
        if (l.broker === 'paper') continue;
        const key = `${l.broker}|${l.tsym}`;
        groups.set(key, [...(groups.get(key) ?? []), l]);
    }
    for (const group of groups.values()) {
        const open = group.filter((l) => l.open);
        if (open.length === 0) continue;
        const { broker, tsym } = open[0];
        const alert = (l: CarriedLeg, why: string) => Log.log(`[${ctx.tag}] ALERT: ${l.alert} (${why})`);
        try {
            let sells: PlatformSell[] | null = null;
            const attempts = ctx.attempts ?? 3;
            for (let i = 0; i < attempts && !sells; i++) {
                if (i > 0) await new Promise((resolve) => setTimeout(resolve, ctx.delayMs ?? 2000));
                sells = await readPlatformSells(ctx.userId, broker, tsym, ctx.fromDay);
            }
            if (!sells) { for (const l of open) alert(l, "the platform's own sells could not be read"); continue; }
            const pool = unseenSells(sells.filter((s) => !(s.at > loadedAt)), { ids: ctx.seenIds, legacyQty: group.reduce((sum, l) => sum + l.accounted, 0) });
            const usable = (pool ?? []).filter((s) => s.quantity > 0);
            const total = usable.reduce((sum, s) => sum + s.quantity, 0);
            const price = total > 0 ? usable.reduce((sum, s) => sum + s.quantity * s.price, 0) / total : 0;
            let left = total;
            for (const l of open) {
                const covered = Math.min(Math.max(0, l.remaining), left);
                left -= covered;
                if (l.remaining > 0 && covered >= l.remaining) {
                    Log.log(`[${ctx.tag}] ${l.broker} ${l.tsym} from ${ctx.fromDay}: ${l.remaining} lots shown open were sold by the platform's own order(s) ${usable.map((s) => s.orderId).join(', ')} @ ${price.toFixed(2)} (the strategy was not told) - a normal close, nothing to check`);
                } else {
                    alert(l, covered > 0 ? `the platform's own sells explain only ${covered} of ${l.remaining}` : "no sell of the platform's own explains it");
                }
            }
        } catch (e: any) {
            for (const l of open) alert(l, `the check against the platform's own sells failed: ${e?.message ?? e}`);
        }
    }
}
