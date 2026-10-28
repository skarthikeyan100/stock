import fs from 'fs';

// A process's Unix-socket file, tracked by inode: on shutdown it is unlinked ONLY if it is still the file THIS process created.
// During a hot restart the replacement may already have bound the same path, and deleting that would cut every IPC client off
// from a healthy process.
export function ownSocketTracker() {
    let ino: number | null = null;
    return {
        // Call once the server is listening on `socketPath`.
        record(socketPath: string): void {
            try { ino = fs.statSync(socketPath).ino; } catch { /* ignore */ }
        },
        unlink(socketPath: string): void {
            try {
                if (ino !== null && fs.statSync(socketPath).ino === ino) fs.unlinkSync(socketPath);
            } catch { /* already gone */ }
        },
    };
}
