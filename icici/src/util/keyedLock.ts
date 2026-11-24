// One-at-a-time critical section per key, in this process: `const release = await acquireKeyLock(k); try { ... } finally { release(); }`.
// Used for check-then-insert sequences (daily limits, "one pending") that two parallel requests of the SAME contractor could both pass.
const tails = new Map<string, Promise<void>>();
export async function acquireKeyLock(key: string): Promise<() => void> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    return () => { release(); if (tails.get(key) === tail) tails.delete(key); };
}
