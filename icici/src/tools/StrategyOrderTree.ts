/**
 * End-of-day order/contract tree printer for ContinuousStrategy, built by
 * scraping orchestrator.log / server.log text (see src/util/Log.ts for the
 * line format) - there is no DB record of leg parent/child/level
 * relationships anywhere (Trade/Mongo carry no such fields), so log text is
 * the only available source.
 *
 * ContinuousStrategy-only: it's the only strategy in this codebase with a
 * parent/child leg concept (root leg -> spawned nested legs -> averaging),
 * confirmed via repo-wide grep for legId/parentLegId/childByLevel/isRoot
 * (zero matches outside ContinuousStrategy.ts). Every other strategy's log
 * lines are ignored entirely - they don't have a tree to reconstruct, and
 * would need their own dedicated logic if that's ever wanted.
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
 *
 * Usage:
 *   npm run orderTree -- [--file orchestrator.log,server.log] [--ascii]
 */
import * as fs from 'fs';

function getArg(name: string, defaultValue: string): string {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : defaultValue;
}
function hasFlag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const FILES = getArg('file', 'orchestrator.log').split(',').map(s => s.trim()).filter(Boolean);
const ASCII = hasFlag('ascii');

// --- line parsing ---

interface ParsedLine {
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

function readContinuousLines(files: string[]): ParsedLine[] {
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
            if (parsed && parsed.message.startsWith('[ContinuousStrategy]')) {
                result.push(parsed);
                seq++;
            }
        }
    }
    return result;
}

// --- tree model ---

interface LegEvent {
    time: string;
    seq: number;
    kind: 'average' | 'status';
    level?: number; addQty?: number; price?: number; totalQty?: number; avgPrice?: number; // average
    qty?: number; avg?: number; target?: number; nextLevel?: number; nextLevelPrice?: number; squareOff?: number; // status
}

interface OutcomeInfo {
    outcome: string; pnl: number; wins: number; losses: number; timeouts: number; winRate: string; totalPnL: number;
}

interface LegInstance {
    instanceId: number;
    tsym: string;
    isRoot: boolean;
    level: number | null; // 1-4 for nested, null for root
    openedAt: { time: string; seq: number; qty: number; entry: number };
    events: LegEvent[];
    closedAt: { time: string; seq: number; kind: 'targetHit' | 'squareOff'; pnl: number } | null;
    outcome: OutcomeInfo | null;
    children: LegInstance[];
    unresolvedParent?: string;
}

interface Generation {
    index: number;
    root: LegInstance;
    openedVia: 'T1' | 'refill';
    refillNotes: { time: string; seq: number; text: string }[];
}

interface ContinuousModel {
    generations: Generation[];
    warnings: string[]; // real anomalies (unresolved parent, event with no open leg) - always shown, not noise
}

const RE_T1_ENTRY = /^\[ContinuousStrategy\] T1 entry: (\S+) qty=(\d+) entry=([\d.]+)$/;
const RE_REFILL_FILLED = /^\[ContinuousStrategy\] Root refill filled: (\S+) qty=(\d+) entry=([\d.]+)$/;
const RE_SPAWN = /^\[ContinuousStrategy\] Level (\d+) spawn: (\S+) qty=(\d+) entry=([\d.]+) \(parent (\S+)\)$/;
const RE_AVERAGE = /^\[ContinuousStrategy\] Level (\d+) average: (\S+) \+qty=(\d+) @ ([\d.]+) -> totalQty=(\d+) avg=([\d.]+) \(\S+\)$/;
const RE_STATUS = /^\[ContinuousStrategy\] (\S+) status: qty=(\d+) avg=([\d.]+) target=([\d.]+) nextLevel\((\d+)\)@([\d.]+) squareOff@([\d.]+)$/;
const RE_TARGET_HIT = /^\[ContinuousStrategy\] Target hit \((?:root|nested)\): (\S+) pnl=(-?\d+)$/;
const RE_SQUAREOFF = /^\[ContinuousStrategy\] 5x square-off \((?:root|nested)\): (\S+) pnl=(-?\d+)$/;
const RE_OUTCOME = /^\[ContinuousStrategy\] Outcome=(win|loss|timeout) PnL=(-?\d+) \| W=(\d+) L=(\d+) T=(\d+) WinRate=([\d.]+|N\/A)% TotalPnL=(-?\d+)$/;
const RE_REFILL_DEFERRED_NESTED = /^\[ContinuousStrategy\] Root refill deferred \(nested legs still open\): (\S+)$/;
const RE_REFILL_DEFERRED_CAPITAL = /^\[ContinuousStrategy\] Root refill deferred - would exceed allotted capital$/;
const RE_REFILL_PLACED = /^\[ContinuousStrategy\] Root refill placed: (\S+) qty=(\d+) price=([\d.]+)$/;
const RE_REFILL_PROMOTED = /^\[ContinuousStrategy\] Promoting deferred root refill: (\S+)$/;

function buildContinuousModel(lines: ParsedLine[]): ContinuousModel {
    const generations: Generation[] = [];
    const warnings: string[] = [];
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

    const openRoot = (tsym: string, qty: number, entry: number, line: ParsedLine, via: 'T1' | 'refill') => {
        const leg = makeLeg(tsym, true, null, line, qty, entry);
        const gen: Generation = { index: generations.length + 1, root: leg, openedVia: via, refillNotes: [] };
        generations.push(gen);
        currentGeneration = gen;
        openLegByTsym.set(tsym, leg);
    };

    const closeLeg = (tsym: string, kind: 'targetHit' | 'squareOff', pnl: number, line: ParsedLine) => {
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
        const msg = line.message;
        let m: RegExpExecArray | null;

        if ((m = RE_T1_ENTRY.exec(msg))) { openRoot(m[1], Number(m[2]), Number(m[3]), line, 'T1'); continue; }
        if ((m = RE_REFILL_FILLED.exec(msg))) { openRoot(m[1], Number(m[2]), Number(m[3]), line, 'refill'); continue; }

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
                if (currentGeneration) currentGeneration.root.children.push(child);
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

        if ((m = RE_OUTCOME.exec(msg))) {
            pendingOutcome = { outcome: m[1], pnl: Number(m[2]), wins: Number(m[3]), losses: Number(m[4]), timeouts: Number(m[5]), winRate: m[6], totalPnL: Number(m[7]) };
            continue;
        }
        if ((m = RE_TARGET_HIT.exec(msg))) { closeLeg(m[1], 'targetHit', Number(m[2]), line); continue; }
        if ((m = RE_SQUAREOFF.exec(msg))) { closeLeg(m[1], 'squareOff', Number(m[2]), line); continue; }

        if ((m = RE_REFILL_DEFERRED_NESTED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `refill deferred (nested legs still open): ${m[1]}` });
            continue;
        }
        if (RE_REFILL_DEFERRED_CAPITAL.test(msg)) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: 'refill deferred (would exceed allotted capital)' });
            continue;
        }
        if ((m = RE_REFILL_PLACED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `refill placed: qty=${m[2]} price=${m[3]}, awaiting fill` });
            continue;
        }
        if ((m = RE_REFILL_PROMOTED.exec(msg))) {
            currentGeneration?.refillNotes.push({ time: line.time, seq: line.seq, text: `deferred refill promoted: ${m[1]}` });
            continue;
        }

        // Everything else (T1 gate/PCR diagnostics, skip/failed lines) is
        // gate/decision noise, not tree data - silently ignored.
    }

    return { generations, warnings };
}

// --- rendering ---

interface TreeChars { branch: string; last: string; pipe: string; blank: string; }
const UNICODE_CHARS: TreeChars = { branch: '├─ ', last: '└─ ', pipe: '│  ', blank: '   ' };
const ASCII_CHARS: TreeChars = { branch: '+- ', last: '`- ', pipe: '|  ', blank: '   ' };

function legHeaderLine(leg: LegInstance): string {
    const tag = leg.isRoot ? 'root' : `L${leg.level}`;
    const unresolved = leg.unresolvedParent ? ` [unresolved parent: ${leg.unresolvedParent}]` : '';
    const openPart = `[${leg.openedAt.time}] (${tag}) ${leg.tsym} qty=${leg.openedAt.qty} entry=${leg.openedAt.entry}${unresolved}`;
    if (!leg.closedAt) return `${openPart}  -- still open at end of log`;
    const closeWord = leg.closedAt.kind === 'targetHit' ? 'Target hit' : '5x square-off';
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

function summaryLine(model: ContinuousModel): string {
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
        : 'no outcomes recorded';
    return `ContinuousStrategy summary: ${model.generations.length} generation(s), ${spawns} spawn(s), ${averages} average-add(s), ${stillOpen} leg(s) still open at end of log, ${totals}`;
}

function renderContinuous(model: ContinuousModel, ascii: boolean): string[] {
    const out: string[] = [];
    const c = ascii ? ASCII_CHARS : UNICODE_CHARS;

    out.push('');
    out.push('=== ContinuousStrategy ===');
    if (model.generations.length === 0) {
        out.push('  no generations found (T1 never entered, or no ContinuousStrategy lines in the given log file(s)).');
    } else {
        model.generations.forEach(gen => {
            out.push('');
            out.push(`--- Generation ${gen.index} (${gen.openedVia === 'T1' ? 'T1 entry' : 'root refill'}) - ${gen.root.tsym} ---`);
            printLeg(gen.root, '', true, true, out, c);
            gen.refillNotes.forEach(n => out.push(`    [${n.time}] -> ${n.text}`));
        });
    }
    if (model.warnings.length > 0) {
        out.push('');
        out.push('--- warnings ---');
        model.warnings.forEach(w => out.push(`  ${w}`));
    }
    out.push('');
    out.push(summaryLine(model));
    return out;
}

// --- main ---

function main(): void {
    const lines = readContinuousLines(FILES);
    if (lines.length === 0) {
        console.log(`No ContinuousStrategy log lines found in: ${FILES.join(', ')}.`);
        console.log('Either the file is empty/missing, was truncated by a process restart (orchestrator.log/server.log are overwritten, not appended, on each restart - see this file\'s header comment), or ContinuousStrategy never ran.');
        return;
    }
    const model = buildContinuousModel(lines);
    renderContinuous(model, ASCII).forEach(l => console.log(l));
}

main();
