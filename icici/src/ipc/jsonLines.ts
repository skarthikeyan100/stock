import readline from 'readline';

// Shared newline-delimited-JSON framing, reused for both the stdio pipes
// (orchestrator -> data -> strategies/frontend) and the order<->strategies/frontend
// Unix-domain-socket channel - a net.Socket and a process stdin/stdout are both
// plain Node Readable/Writable streams, so one framing helper covers both transports.

export function writeJsonLine(stream: NodeJS.WritableStream, obj: unknown): void {
    stream.write(JSON.stringify(obj) + '\n');
}

export function readJsonLines(
    stream: NodeJS.ReadableStream,
    onMessage: (obj: any) => void,
    onError?: (line: string, err: unknown) => void
): readline.Interface {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
            onMessage(JSON.parse(line));
        } catch (e) {
            if (onError) onError(line, e);
        }
    });
    // readline.Interface re-emits its underlying stream's 'error' on itself -
    // an EventEmitter throws synchronously if 'error' has no listener, so a
    // dropped socket (e.g. `order` restarting mid-dev) would otherwise crash
    // whichever process was reading from it. The stream's own error is still
    // reported separately by the caller (e.g. OrderClient's socket.on('error')).
    rl.on('error', (e) => {
        if (onError) onError('', e);
    });
    return rl;
}
