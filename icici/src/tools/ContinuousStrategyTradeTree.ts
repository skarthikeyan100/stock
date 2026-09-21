/**
 * Continuous-Strategy Trade Tree - reconstructs the ContinuousStrategy leg
 * tree (which legs were open, their parent/child spawn relationships, and
 * P&L) as of any given day and (optionally) any point in time that day,
 * straight from Mongo's `Trade` (every fill, Buy and Sell - see
 * bookkeeping.ts's `_processTradeEvent`) and `legLineage` (see
 * ContinuousStrategy.ts's persistLegLineage/loadLatestLegLineage)
 * collections - not from `orchestrator.log`, which only covers the current
 * server lifetime and is truncated on every restart (see
 * scripts/continuous-strategy-trades.sh, which has exactly that gap).
 *
 * Lineage-tracking (legLineage) only started being written once this tool
 * was added - a date before that has no legLineage docs at all, so every
 * token seen that day falls back to being printed as one flat, unlinked leg
 * (its full fill history collapsed into a single node) rather than a true
 * spawn tree. This is a real, permanent limitation for historical dates, not
 * a bug - lineage that was never recorded cannot be recovered after the
 * fact.
 *
 * Usage:
 *   npm run tradeTree -- --date 2026-09-09 [--time 15:00] [--user Default]
 *
 * --date: required, YYYY-MM-DD, the trading day to inspect.
 * --time: optional, HH:mm (24h, server-local), the cutoff within that day -
 *   only fills/lineage up to this moment are considered. Defaults to the
 *   end of the given day (23:59:59), i.e. "as it stood by market close".
 * --user: optional, defaults to 'Default' (see Trade.user's own default).
 */
import Mongo from './mongo';
import Log from '../util/Log';

interface LegLineageDoc {
    legRef: string;
    token: string;
    tsym: string;
    parentLegRef: string | null;
    parentLevel: number | null;
    isRoot: boolean;
    createdAt: Date;
    userId?: string;
}

interface RawTrade {
    tsym: string;
    token: string;
    action: 'Buy' | 'Sell';
    quantity: number;
    price: number;
    entryTime?: Date;
    user?: string;
}

// One reconstructed leg - either a true lineage-tracked generation (has a
// legRef) or a pre-lineage/no-lineage flat fallback (synthesized legRef).
interface LegNode {
    legRef: string;
    parentLegRef: string | null;
    tsym: string;
    token: string;
    isRoot: boolean;
    openedAt: Date;
    buyQty: number;
    buyValue: number; // sum(qty*price) across Buy fills in this generation - avgPrice = buyValue/buyQty
    sellQty: number;
    sellValue: number;
    closedAt: Date | null; // set once sellQty >= buyQty
    children: LegNode[];
}

function parseArgs(argv: string[]): { date: string; time?: string; user: string } {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const date = get('--date');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error('Usage: --date YYYY-MM-DD [--time HH:mm] [--user <userId>]');
    }
    const time = get('--time');
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
        throw new Error('--time must be HH:mm (24h)');
    }
    const user = get('--user') || 'Default';
    return { date, time, user };
}

function newNode(legRef: string, parentLegRef: string | null, isRoot: boolean, tsym: string, token: string, openedAt: Date): LegNode {
    return { legRef, parentLegRef, tsym, token, isRoot, openedAt, buyQty: 0, buyValue: 0, sellQty: 0, sellValue: 0, closedAt: null, children: [] };
}

// Groups a token's fills into "generations" (a real, distinct leg on that
// token - it can be opened, fully closed, and later reopened as an unrelated
// leg). Two ways a new generation starts:
//  1. A legLineage doc "opens" as of this fill's time - a real spawn/refill,
//     tracked with its true legRef/parentLegRef/isRoot.
//  2. No lineage doc applies yet (none exist for this token pre-lineage, or
//     this fill predates the first one) AND either there's no generation
//     open yet, or the current one already closed (sellQty caught up to
//     buyQty) and a new Buy arrives - an untracked reopening. Synthesized
//     with a made-up legRef/isRoot:true/no parent (the pre-lineage/
//     no-lineage fallback described in the header comment) - without this
//     split, two independent open/close cycles on the same token would
//     wrongly merge into one node (bought/sold totals right, but "closed"
//     status and P&L both wrong for whichever cycle came second).
function buildLegNodes(tsym: string, token: string, lineageDocs: LegLineageDoc[], fills: RawTrade[]): LegNode[] {
    const nodes: LegNode[] = [];
    let current: LegNode | null = null;
    let lineageIdx = 0;
    let syntheticCounter = 0;

    for (const fill of fills) {
        const fillTime = fill.entryTime ?? new Date(0);
        while (lineageIdx < lineageDocs.length && lineageDocs[lineageIdx].createdAt <= fillTime) {
            const d = lineageDocs[lineageIdx];
            current = newNode(d.legRef, d.parentLegRef, d.isRoot, tsym, token, d.createdAt);
            nodes.push(current);
            lineageIdx++;
        }
        if (!current || (current.closedAt && fill.action === 'Buy')) {
            syntheticCounter++;
            current = newNode(`flat:${token}#${syntheticCounter}`, null, true, tsym, token, fillTime);
            nodes.push(current);
        }
        if (fill.action === 'Buy') {
            current!.buyQty += fill.quantity;
            current!.buyValue += fill.quantity * fill.price;
        } else {
            current!.sellQty += fill.quantity;
            current!.sellValue += fill.quantity * fill.price;
            if (current!.sellQty >= current!.buyQty) current!.closedAt = fillTime;
        }
    }
    return nodes;
}

// A Sell fill with no matching Buy in the queried window (buyQty=0) is a real
// data gap - e.g. a Buy doc that predates entryTime being recorded, or one
// genuinely lost to a past incident (see ToDo.md's 2026-09-03 restart-safety
// entries) - not something to paper over with a fabricated price. Guarded to
// 0 (not NaN) so it still prints/sums cleanly; the raw bought=0 in the
// printed line already surfaces the gap honestly.
function avgBuyPrice(node: LegNode): number {
    return node.buyQty > 0 ? node.buyValue / node.buyQty : 0;
}

function printTree(node: LegNode, depth: number, out: string[]): void {
    const indent = '  '.repeat(depth);
    const avgPrice = avgBuyPrice(node);
    const status = node.closedAt ? `CLOSED @ ${node.closedAt.toLocaleTimeString()}` : 'OPEN';
    const openQty = node.buyQty - node.sellQty;
    let pnlText = '';
    if (node.sellQty > 0) {
        // Realized P&L on whatever's been sold so far, using this generation's
        // overall avg buy price - not a strict FIFO/per-fill match, but
        // consistent with how ContinuousStrategy's own avgPrice-based P&L
        // (processOptionQuote's target-hit/square-off branches) already works.
        const realized = node.sellValue - avgPrice * node.sellQty;
        pnlText = ` realizedPnL=${Math.round(realized)}`;
    }
    out.push(`${indent}${node.isRoot ? 'ROOT' : 'HEDGE'} ${node.tsym} (token ${node.token}) avg=${avgPrice.toFixed(2)} bought=${node.buyQty} sold=${node.sellQty} openQty=${openQty} ${status}${pnlText}`);
    for (const child of node.children) printTree(child, depth + 1, out);
}

async function main(): Promise<void> {
    const { date, time, user } = parseArgs(process.argv.slice(2));
    const cutoff = time ? new Date(`${date}T${time}:00`) : new Date(`${date}T23:59:59`);
    if (Number.isNaN(cutoff.getTime())) throw new Error(`Invalid --date/--time: ${date} ${time ?? ''}`);

    await Mongo.init();
    const db = Mongo.getInstance().db;

    const lineageDocsRaw = await db.collection('legLineage')
        .find({ userId: user, createdAt: { $lte: cutoff } })
        .sort({ createdAt: 1 })
        .toArray();
    const lineageDocs = lineageDocsRaw as unknown as LegLineageDoc[];

    const fillsRaw = await db.collection('Trade')
        .find({ user, entryTime: { $lte: cutoff, $exists: true } })
        .sort({ entryTime: 1 })
        .toArray();
    const fills = fillsRaw as unknown as RawTrade[];

    if (fills.length === 0) {
        console.log(`No fills found for user=${user} up to ${cutoff.toISOString()}.`);
        process.exit(0);
    }

    const lineageByToken = new Map<string, LegLineageDoc[]>();
    for (const d of lineageDocs) {
        if (!lineageByToken.has(d.token)) lineageByToken.set(d.token, []);
        lineageByToken.get(d.token)!.push(d);
    }
    const fillsByToken = new Map<string, RawTrade[]>();
    for (const f of fills) {
        if (!fillsByToken.has(f.token)) fillsByToken.set(f.token, []);
        fillsByToken.get(f.token)!.push(f);
    }

    const allNodes: LegNode[] = [];
    for (const [token, tokenFills] of fillsByToken) {
        const tsym = tokenFills[0].tsym;
        allNodes.push(...buildLegNodes(tsym, token, lineageByToken.get(token) ?? [], tokenFills));
    }

    const byRef = new Map<string, LegNode>();
    for (const n of allNodes) byRef.set(n.legRef, n);
    const roots: LegNode[] = [];
    for (const n of allNodes) {
        const parent = n.parentLegRef ? byRef.get(n.parentLegRef) : undefined;
        if (parent) parent.children.push(n);
        else roots.push(n); // true root, or an orphaned child (parent outside this query window) - printed at top level either way
    }

    const out: string[] = [];
    out.push(`Trade tree for user=${user} as of ${cutoff.toLocaleString()} (${lineageDocs.length} lineage doc(s), ${fills.length} fill(s) considered):`);
    for (const root of roots) printTree(root, 1, out);

    const closedLegs = allNodes.filter((n) => n.closedAt);
    const openLegs = allNodes.filter((n) => !n.closedAt);
    // Every sell already booked counts toward realized P&L, whether or not
    // the leg it belongs to has fully closed yet (a still-open leg can have
    // partial sells too, e.g. tryAverageLevel's target-hit on part of a
    // position) - deliberately not restricted to closedLegs.
    const totalRealized = allNodes.reduce((sum, n) => sum + (n.sellValue - avgBuyPrice(n) * n.sellQty), 0);
    out.push('');
    out.push(`Summary: ${allNodes.length} leg(s) total - ${closedLegs.length} closed, ${openLegs.length} still open as of cutoff. Total realized P&L: ${Math.round(totalRealized)}`);

    console.log(out.join('\n'));
    process.exit(0);
}

main().catch((e) => {
    Log.log('[ContinuousStrategyTradeTree] Fatal error:', e);
    console.error(e.message);
    process.exit(1);
});
