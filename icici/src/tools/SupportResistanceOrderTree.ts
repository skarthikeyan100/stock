/**
 * End-of-day leg/order tree printer for SupportResistanceStrategy - mirrors
 * StrategyOrderTree.ts (ContinuousStrategy), sharing legOrderTreeCore.ts's
 * engine (both strategies emit identical LegManager log line shapes; only
 * the owner tag and root-entry label differ - see the shared module's doc
 * comment for log format/limitations). Works against orchestrator.log/
 * server.log, or against a saved backtest run's captured stdout
 * (SupportResistanceStrategyBacktest.ts emits the same lines).
 *
 * Usage:
 *   npm run orderTree:supportResistance -- [--file orchestrator.log,server.log] [--ascii]
 */
import { readAllLines, buildLegTreeModel, renderLegTree, getArg, hasFlag } from './legOrderTreeCore';

const FILES = getArg('file', 'orchestrator.log').split(',').map(s => s.trim()).filter(Boolean);
const ASCII = hasFlag('ascii');

const CONFIG = { ownerType: 'SupportResistanceStrategy', rootEntryLabel: 'Entry', displayName: 'SupportResistanceStrategy' };

function main(): void {
    const lines = readAllLines(FILES);
    if (lines.length === 0) {
        console.log(`No lines found in: ${FILES.join(', ')}.`);
        console.log('Either the file is empty/missing, or was truncated by a process restart (orchestrator.log/server.log are overwritten, not appended, on each restart - see legOrderTreeCore.ts\'s header comment).');
        return;
    }
    const model = buildLegTreeModel(lines, CONFIG);
    renderLegTree(model, ASCII, CONFIG).forEach(l => console.log(l));
}

main();
