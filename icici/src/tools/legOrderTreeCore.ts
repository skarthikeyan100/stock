/**
 * Shared engine behind StrategyOrderTree.ts (ContinuousStrategy) and
 * SupportResistanceOrderTree.ts (SupportResistanceStrategy) - both
 * strategies emit the exact same leg-lifecycle log line shapes (they share
 * LegManager.ts), so one parser/tree-builder/renderer, parameterized by
 * owner tag + root-entry label, covers both.
 *
 * Built by scraping orchestrator.log / server.log / a saved backtest run's
 * captured stdout text (see src/util/Log.ts for the line format) - there is
 * no DB record of leg parent/child/level relationships anywhere (Trade/Mongo
 * carry no such fields), so log text is the only available source. A
 * backtest tool's captured output works too, since LegManager's Log.log
 * calls are identical in both contexts - only the `userId` used to
 * construct the strategy differs (live: normally == ownerType; backtest
 * tools construct with a custom id like 'Backtest'), which affects only
 * Outcome=... correlation (see RE_OUTCOME's own note below), not the tree
 * itself.
 *
 * Known limitations (inherent to log-scraping, not fixable here):
 *  - orchestrator.log/server.log are written via `tee` WITHOUT -a
 *    (package.json) - a process restart truncates the file, silently losing
 *    everything logged before it. Pass multiple --file paths (comma
 *    separated, concatenated in argument order) if you saved pre-restart
 *    copies yourself.
 *  - Log.log's [HH:mm:ss] timestamp has no date and no milliseconds - this
 *    tool assumes one trading day's worth of lines, ordered by file-read
 *    order (a `seq` counter), not by re-parsing the timestamp.
 *  - A refill's "filled (nested)" log line carries no parent tsym (unlike a
 *    spawn's "(parent X)" suffix) - a nested leg reopened via a refill fill
 *    can't be attached to its true parent from the log alone, so it's
 *    attached under the current generation's root as a best-effort guess,
 *    flagged the same way an unresolved spawn parent is.
 */
import * as fs from 'fs';

// --- line parsing ---

export interface ParsedLine {
    time: string;   // "HH:mm:ss" - display only, NOT the ordering key (see `seq`)
    message: string;
    seq: number;    // monotonically increasing across all concatenated --file inputs, in read order - the true ordering key
}

// [HH:mm:ss] [callerInfo] <message> - callerInfo is a raw V8 stack-frame string
// (see src/util/Log.ts), not structured data; we don't parse it, just skip past it.
const LINE_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s*\[[^\]]*\]\s*(.*)$/s;

function parseLine(raw: string, seq: number): ParsedLine | null {
    const m = LINE_RE.exec(raw);
    if (!m) return null; // e.g. an embedded Error.stack newline from a multi-arg Log.log(msg, err) call
    return { time: m[1], message: m[2], seq };
}

export function readAllLines(files: string[]): ParsedLine[] {
    const result: ParsedLine[] = [];
    let seq = 0;
    for (const file of files) {
        let raw: string;
        try {
            raw = fs.readFileSync(file, 'utf-8');
        } catch (e) {
            console.error(`Warning: could not read "${file}" (${(e as Error).message}) - skipping.`);
            continue;
        }
        for (const rawLine of raw.split('\n')) {
            const parsed = parseLine(rawLine, seq);
            if (parsed) { result.push(parsed); seq++; }
        }
    }
    return result;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- tree model ---

export interface LegEvent {
    time: string;
    seq: number;
    kind: 'average' | 'status';
    level?: number; addQty?: number; price?: number; totalQty?: number; avgPrice?: number; // average
    qty?: number; avg?: number; target?: number; nextLevel?: number; nextLevelPrice?: number; squareOff?: number; // status
}

export interface OutcomeInfo {
    outcome: string; pnl: number; wins: number; losses: number; timeouts: number; winRate: string; totalPnL: number;
}

export type CloseKind = 'targetHit' | 'squareOff' | 'maxProfitClose' | 'externalSell';

export interface LegInstance {
    instanceId: number;
    tsym: string;
    isRoot: boolean;
    level: number | null; // 1-N for nested, null for root
    openedAt: { time: string; seq: number; qty: number; entry: number };
    events: LegEvent[];
    closedAt: { time: string; seq: number; kind: CloseKind; pnl: number } | null;
    outcome: OutcomeInfo | null;
    children: LegInstance[];
    unresolvedParent?: string;
}

export interface Generation {
    index: number;
    root: LegInstance;
    openedVia: 'entry' | 'refill';
    refillNotes: { time: string; seq: number; text: string }[];
}

export interface SessionEvent { time: string; seq: number; text: string; }

export interface LegTreeModel {
    generations: Generation[];
    warnings: string[]; // real anomalies (unresolved parent, event with no open leg) - always shown, not noise
    sessionEvents: SessionEvent[]; // capital-gate/maxProfit-tripped lines - session-wide, not leg-specific
}

export interface LegTreeConfig {
    ownerType: string;      // e.g. 'ContinuousStrategy' | 'SupportResistanceStrategy' - LegManager's log-line prefix
    rootEntryLabel: string; // e.g. 'T1 entry' | 'Entry' - the label openRootLeg's caller passes for a fresh root open
    displayName?: string;   // header text, defaults to ownerType
}

// Matched against the message with the leading `[ownerType] ` prefix already
// stripped (see buildLegTreeModel) - so none of these need to know ownerType.
const RE_SPAWN = /^Level (\d+) spawn: (\S+) qty=(\d+) entry=([\d.]+) \(parent (\S+)\)$/;
const RE_AVERAGE = /^Level (\d+) average: (\S+) \+qty=(\d+) @ ([\d.]+) -> totalQty=(\d+) avg=([\d.]+) \(\S+\)$/;
const RE_STATUS = /^(\S+) status: qty=(\d+) avg=([\d.]+) target=([\d.]+) nextLevel\((\d+)\)@([\d.]+) squareOff@([\d.]+)$/;
const RE_TARGET_HIT = /^Target hit \((root|nested)\): (\S+) pnl=(-?\d+)$/;
const RE_SQUAREOFF = /^Square-off \((root|nested)\): (\S+) pnl=(-?\d+)$/;
const RE_MAXPROFIT_CLOSE = /^Max-profit close \((root|nested)\): (\S+) pnl=(-?\d+)$/;
const RE_EXTERNAL_SELL = /^External\/manual sell detected: (\S+) pnl=(-?\d+)$/;
const RE_REFILL_PLACED = /^Refill placed \((root|nested)\): (\S+) qty=(\d+) price=([\d.]+)$/;
const RE_REFILL_FILLED = /^Refill filled \((root|nested)\): (\S+) qty=(\d+) entry=([\d.]+)$/;
const RE_REFILL_DEFERRED_NESTED = /^Root refill deferred \(nested legs still open\): (\S+)$/;
const RE_REFILL_PROMOTED = /^Promoting deferred root refill: (\S+)$/;
const RE_NO_REFILL_PARENT_CLOSED = /^No refill - parent closed: (\S+)$/;
const RE_CAPITAL_GATE_TRIPPED = /^CAPITAL GATE TRIPPED \(([^)]*)\) - total=(-?\d+) maxInvestment=(\d+)/;
const RE_MAXPROFIT_TRIPPED = /^MAX PROFIT TRIPPED - cumulative=(-?\d+) threshold=(\d+) \(maxProfit=([\d.]+)% of maxInvestment=(\d+)\)/;
// Outcome=... is logged by the base Strategy class under `[${this.userId}]`,
// not `[${ownerType}]` - matches only when userId defaults to ownerType
// (the normal live-trading case, StrategyFactory's `userId = config.userId
// || config.type`). A backtest tool constructed with a custom userId (e.g.
// 'Backtest') won't correlate Outcome lines - legs just show without
// per-leg win/loss/cumulative context in that case, not an error.
function outcomeRegex(ownerType: string): RegExp {
    return new RegExp(`^\\[${escapeRegExp(ownerType)}\\] Outcome=(win|loss|timeout) PnL=(-?\\d+) \\| W=(\\d+) L=(\\d+) T=(\\d+) WinRate=([\\d.]+|N\\/A)% TotalPnL=(-?\\d+)$`);
}

export function buildLegTreeModel(lines: ParsedLine[], config: LegTreeConfig): LegTreeModel {
    const ownerPrefix = `[${config.ownerType}] `;
    const rootOpenRe = new RegExp(`^${escapeRegExp(config.rootEntryLabel)}: (\\S+) qty=(\\d+) entry=([\\d.]+)$`);
    const outcomeRe = outcomeRegex(config.ownerType);

    const generations: Generation[] = [];
    const warnings: string[] = [];
    const sessionEvents: SessionEvent[] = [];
    const openLegByTsym = new Map<string, LegInstance>();
    let currentGeneration: Generation | null = null;
    let pendingOutcome: OutcomeInfo | null = null;
    let nextInstanceId = 1;

    const makeLeg = (tsym: string, isRoot: boolean, level: number | null, line: ParsedLine, qty: number, entry: number): LegInstance => ({
        instanceId: nextInstanceId++,
        tsym, isRoot, level,
        openedAt: { time: line.time, seq: line.seq, qty, entry },
        events: [], closedAt: null, outcome: null, children: [],
    });

    const openRoot = (tsym: string, qty: number, entry: number, line: ParsedLine, via: 'entry' | 'refill') => {
        const leg = makeLeg(tsym, true, null, line, qty, entry);
        const gen: Generation = { index: generations.length + 1, root: leg, openedVia: via, refillNotes: [] };
        generations.push(gen);
        currentGeneration = gen;
        openLegByTsym.set(tsym, leg);
    };

    const openNestedRefill = (tsym: string, qty: number, entry: number, line: ParsedLine) => {
        const leg = makeLeg(tsym, false, null, line, qty, entry);
        leg.unresolvedParent = '(nested refill - parent not recorded in this log line)';
        warnings.push(`[${line.time}] nested refill filled for ${tsym} - its true parent can't be determined from the log (the "Refill filled" line carries no parent tsym) - attached under the current generation's root as a best guess`);
        if (currentGeneration) (currentGeneration as Generation).root.children.push(leg);
        openLegByTsym.set(tsym, leg);
    };

    const closeLeg = (tsym: string, kind: CloseKind, pnl: number, line: ParsedLine) => {
        const leg = openLegByTsym.get(tsym);
        if (!leg) {
            warnings.push(`[${line.time}] ${kind} for ${tsym} but no open leg was tracked for it (log likely truncated before this leg's open event) - line ignored`);
            return;
        }
        leg.closedAt = { time: line.time, seq: line.seq, kind, pnl };
        leg.outcome = pendingOutcome;
        pendingOutcome = null;
        openLegByTsym.delete(tsym);
    };

    for (const line of lines) {
        if (outcomeRe.test(line.message)) {
            const m = outcomeRe.exec(line.message)!;
            pendingOutcome = { outcome: m[1], pnl: Number(m[2]), wins: Number(m[3]), losses: Number(m[4]), timeouts: Number(m[5]), winRate: m[6], totalPnL: Number(m[7]) };
            continue;
        }
        if (!line.message.startsWith(ownerPrefix)) continue;
        const msg = line.message.slice(ownerPrefix.length);
        let m: RegExpExecArray | null;

        if ((m = rootOpenRe.exec(msg))) { openRoot(m[1], Number(m[2]), Number(m[3]), line, 'entry'); continue; }

        if ((m = RE_REFILL_FILLED.exec(msg))) {
            const isRoot = m[1] === 'root';
            if (isRoot) openRoot(m[2], Number(m[3]), Number(m[4]), line, 'refill');
            else openNestedRefill(m[2], Number(m[3]), Number(m[4]), line);
            continue;
        }

        if ((m = RE_SPAWN.exec(msg))) {
            const level = Number(m[1]);
            const childTsym = m[2];
            const parentTsym = m[5];
            const parent = openLegByTsym.get(parentTsym);
            const child = makeLeg(childTsym, false, level, line, Number(m[3]), Number(m[4]));
            if (parent) {
                parent.children.push(child);
            } else {
                child.unresolvedParent = parentTsym;
                warnings.push(`[${line.time}] spawn's parent ${parentTsym} not found (log likely truncated before this generation started) - attached under the current generation's root as a best guess`);
                if (currentGeneration) (currentGeneration as Generation).root.children.push(child);
            }
            openLegByTsym.set(childTsym, child);
            continue;
        }

        if ((m = RE_AVERAGE.exec(msg))) {
            const tsym = m[2];
            const leg = openLegByTsym.get(tsym);
            if (leg) {
                leg.events.push({ time: line.time, seq: line.seq, kind: 'average', level: Number(m[1]), addQty: Number(m[3]), price: Number(m[4]), totalQty: Number(m[5]), avgPrice: Number(m[6]) });
            } else {
                warnings.push(`[${line.time}] average-add for ${tsym} but no open leg was tracked for it - line ignored`);
            }
            continue;
        }

        if ((m = RE_STATUS.exec(msg))) {
            const leg = openLegByTsym.get(m[1]);
            if (leg) {
                leg.events.push({
                    time: line.time, seq: line.seq, kind: 'status',
                    qty: Number(m[2]), avg: Number(m[3]), target: Number(m[4]),
                    nextLevel: Number(m[5]), nextLevelPrice: Number(m[6]), squareOff: Number(m[7]),
                });
            }
            continue;
        }

        if ((m = RE_TARGET_HIT.exec(msg))) { closeLeg(m[2], 'targetHit', Number(m[3]), line); continue; }
        if ((m = RE_SQUAREOFF.exec(msg))) { closeLeg(m[2], 'squareOff', Number(m[3]), line); continue; }
        if ((m = RE_MAXPROFIT_CLOSE.exec(msg))) { closeLeg(m[2], 'maxProfitClose', Number(m[3]), line); continue; }
        if ((m = RE_EXTERNAL_SELL.exec(msg))) { closeLeg(m[1], 'externalSell', Number(m[2]), line); continue; }

        if ((m = RE_REFILL_DEFERRED_NESTED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `refill deferred (nested legs still open): ${m[1]}` });
            continue;
        }
        if ((m = RE_REFILL_PLACED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `refill placed (${m[1]}): ${m[2]} qty=${m[3]} price=${m[4]}, awaiting fill` });
            continue;
        }
        if ((m = RE_REFILL_PROMOTED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `deferred refill promoted: ${m[1]}` });
            continue;
        }
        if ((m = RE_NO_REFILL_PARENT_CLOSED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `no refill - parent already closed: ${m[1]}` });
            continue;
        }

        if ((m = RE_CAPITAL_GATE_TRIPPED.exec(msg))) {
            sessionEvents.push({ time: line.time, seq: line.seq, text: `CAPITAL GATE TRIPPED (${m[1]}) - total=${m[2]} maxInvestment=${m[3]} - all further new orders blocked for the rest of the session` });
            continue;
        }
        if ((m = RE_MAXPROFIT_TRIPPED.exec(msg))) {
            sessionEvents.push({ time: line.time, seq: line.seq, text: `MAX PROFIT TRIPPED - cumulative=${m[1]} threshold=${m[2]} (maxProfit=${m[3]}% of maxInvestment=${m[4]}) - closing all legs, blocking new entries for the rest of the session` });
            continue;
        }

        // Everything else (entry gate/PCR diagnostics, skip/failed lines,
        // reconcile/legLineage plumbing) is gate/decision noise, not tree
        // data - silently ignored.
    }

    return { generations, warnings, sessionEvents };
}

// --- rendering ---

interface TreeChars { branch: string; last: string; pipe: string; blank: string; }
const UNICODE_CHARS: TreeChars = { branch: '├─ ', last: '└─ ', pipe: '│  ', blank: '   ' };
const ASCII_CHARS: TreeChars = { branch: '+- ', last: '`- ', pipe: '|  ', blank: '   ' };

const CLOSE_WORDS: Record<CloseKind, string> = {
    targetHit: 'Target hit',
    squareOff: 'Square-off',
    maxProfitClose: 'Max-profit close',
    externalSell: 'External/manual sell',
};

function legHeaderLine(leg: LegInstance): string {
    const tag = leg.isRoot ? 'root' : (leg.level != null ? `L${leg.level}` : 'nested');
    const unresolved = leg.unresolvedParent ? ` [unresolved parent: ${leg.unresolvedParent}]` : '';
    const openPart = `[${leg.openedAt.time}] (${tag}) ${leg.tsym} qty=${leg.openedAt.qty} entry=${leg.openedAt.entry}${unresolved}`;
    if (!leg.closedAt) return `${openPart}  -- still open at end of log`;
    const closeWord = CLOSE_WORDS[leg.closedAt.kind];
    const pnlStr = `${leg.closedAt.pnl >= 0 ? '+' : ''}${leg.closedAt.pnl}`;
    const outcomeStr = leg.outcome
        ? ` (${leg.outcome.outcome}, cum W${leg.outcome.wins} L${leg.outcome.losses} T${leg.outcome.timeouts} TotalPnL=${leg.outcome.totalPnL})`
        : ' (no matching Outcome= line found)';
    return `${openPart}  ->  [${leg.closedAt.time}] ${closeWord} pnl=${pnlStr}${outcomeStr}`;
}

function eventLine(e: LegEvent): string {
    if (e.kind === 'average') {
        return `[${e.time}] Level ${e.level} average: +qty=${e.addQty} @ ${e.price} -> totalQty=${e.totalQty} avg=${e.avgPrice}`;
    }
    return `[${e.time}] status: qty=${e.qty} avg=${e.avg} target=${e.target} nextLevel(${e.nextLevel})@${e.nextLevelPrice} squareOff@${e.squareOff}`;
}

function lastStatusEvent(leg: LegInstance): LegEvent | undefined {
    for (let i = leg.events.length - 1; i >= 0; i--) if (leg.events[i].kind === 'status') return leg.events[i];
    return undefined;
}

// Only the last status snapshot per leg is shown (it supersedes earlier
// ones); every average-add is shown, since each is a distinct real event.
function printLeg(leg: LegInstance, prefix: string, isRootCall: boolean, isLast: boolean, out: string[], c: TreeChars): void {
    const connector = isRootCall ? '' : (isLast ? c.last : c.branch);
    out.push(`${prefix}${connector}${legHeaderLine(leg)}`);
    const childPrefix = isRootCall ? prefix : prefix + (isLast ? c.blank : c.pipe);

    const lastStatus = lastStatusEvent(leg);
    const eventsToShow = leg.events.filter(e => e.kind !== 'status' || e === lastStatus);

    // Merge events and children into one seq-ordered list so output reads
    // chronologically (top to bottom) rather than all-events-then-all-children.
    type Item = { seq: number; render: (p: string, last: boolean) => void };
    const items: Item[] = [];
    eventsToShow.forEach(e => items.push({
        seq: e.seq,
        render: (p, last) => out.push(`${p}${last ? c.last : c.branch}${eventLine(e)}`),
    }));
    leg.children.forEach(child => items.push({
        seq: child.openedAt.seq,
        render: (p, last) => printLeg(child, p, false, last, out, c),
    }));
    items.sort((a, b) => a.seq - b.seq);
    items.forEach((item, i) => item.render(childPrefix, i === items.length - 1));
}

function summaryLine(model: LegTreeModel, displayName: string): string {
    let spawns = 0, averages = 0, stillOpen = 0;
    let lastOutcome: OutcomeInfo | null = null;
    let lastOutcomeSeq = -1;
    const walk = (leg: LegInstance) => {
        if (!leg.isRoot) spawns++;
        averages += leg.events.filter(e => e.kind === 'average').length;
        if (!leg.closedAt) stillOpen++;
        if (leg.outcome && leg.closedAt && leg.closedAt.seq > lastOutcomeSeq) {
            lastOutcome = leg.outcome;
            lastOutcomeSeq = leg.closedAt.seq;
        }
        leg.children.forEach(walk);
    };
    model.generations.forEach(g => walk(g.root));
    const totals = lastOutcome
        ? `W=${(lastOutcome as OutcomeInfo).wins} L=${(lastOutcome as OutcomeInfo).losses} T=${(lastOutcome as OutcomeInfo).timeouts} TotalPnL=${(lastOutcome as OutcomeInfo).totalPnL}`
        : 'no outcomes recorded (see note above on Outcome=... correlation)';
    return `${displayName} summary: ${model.generations.length} generation(s), ${spawns} spawn(s), ${averages} average-add(s), ${stillOpen} leg(s) still open at end of log, ${totals}`;
}

export function renderLegTree(model: LegTreeModel, ascii: boolean, config: LegTreeConfig): string[] {
    const out: string[] = [];
    const c = ascii ? ASCII_CHARS : UNICODE_CHARS;
    const displayName = config.displayName ?? config.ownerType;

    out.push('');
    out.push(`=== ${displayName} ===`);
    if (model.generations.length === 0) {
        out.push(`  no generations found (no root entry ever fired, or no ${config.ownerType} lines in the given log file(s)).`);
    } else {
        model.generations.forEach(gen => {
            out.push('');
            out.push(`--- Generation ${gen.index} (${gen.openedVia === 'entry' ? 'root entry' : 'root refill'}) - ${gen.root.tsym} ---`);
            printLeg(gen.root, '', true, true, out, c);
            gen.refillNotes.forEach(n => out.push(`    [${n.time}] -> ${n.text}`));
        });
    }
    if (model.sessionEvents.length > 0) {
        out.push('');
        out.push('--- session events (capital gate / maxProfit) ---');
        model.sessionEvents.forEach(e => out.push(`  [${e.time}] ${e.text}`));
    }
    if (model.warnings.length > 0) {
        out.push('');
        out.push('--- warnings ---');
        model.warnings.forEach(w => out.push(`  ${w}`));
    }
    out.push('');
    out.push(summaryLine(model, displayName));
    return out;
}

export function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}
export function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}
