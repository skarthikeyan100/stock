import { writeJsonLine } from '../../ipc/jsonLines';

// strategies' only channel back to `data`: subscribe/unsubscribe commands go out
// on strategies' own stdout, which the orchestrator relays into `data`'s stdin
// (the reverse of the tick pipe). stdout is reserved for this protocol -
// strategiesProcess.ts redirects console.log to stderr for that reason.

export function subscribeToken(token: string): void {
    writeJsonLine(process.stdout, { cmd: 'subscribe', token });
}

export function unsubscribeToken(token: string): void {
    writeJsonLine(process.stdout, { cmd: 'unsubscribe', token });
}
