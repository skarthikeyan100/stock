import assert from 'assert';
import { runOrderWrite, setOrderQueueTimingsForTest } from '../util/brokerOrderQueue';
import { isNotPlaced } from '../util/notPlaced';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const GAP = 120;

async function main() {
    setOrderQueueTimingsForTest({ gapMs: GAP, maxQueueWaitMs: 1500, maxSlotHoldMs: 400 });

    // 1. FIFO order, one at a time, gap measured end-to-start, results returned to each caller.
    {
        const log: Array<{ id: number; start: number; end: number }> = [];
        const mk = (id: number, work: number) => runOrderWrite('kite', `o${id}`, async () => {
            const start = Date.now(); await sleep(work); log.push({ id, start, end: Date.now() }); return id * 10;
        });
        const res = await Promise.all([mk(1, 30), mk(2, 5), mk(3, 20), mk(4, 1)]);
        assert.deepStrictEqual(res, [10, 20, 30, 40], 'each caller gets its own result');
        assert.deepStrictEqual(log.map((l) => l.id), [1, 2, 3, 4], 'FIFO');
        for (let i = 1; i < log.length; i++) assert.ok(log[i].start - log[i - 1].end >= GAP - 5, `gap before #${log[i].id}: ${log[i].start - log[i - 1].end}`);
    }

    // 2. A failure rejects its own caller with the real error and does not stall or skip the next write.
    {
        const boom = new Error('429 Too Many Requests');
        const a = runOrderWrite('ant', 'bad', async () => { throw boom; });
        const b = runOrderWrite('ant', 'good', async () => 'ok');
        await assert.rejects(a, (e) => e === boom);
        assert.strictEqual(await b, 'ok');
    }

    // 3. Brokers are independent: a slow kite write does not delay breeze.
    {
        const t0 = Date.now();
        const slow = runOrderWrite('kite', 'slow', async () => { await sleep(300); });
        const fast = runOrderWrite('breeze', 'fast', async () => Date.now() - t0);
        assert.ok((await fast) < 100, 'breeze did not wait for kite');
        await slow;
    }

    // 4. A cancel-then-place sequence by one caller keeps its order even with another caller interleaved.
    {
        const seen: string[] = [];
        const caller1 = (async () => {
            await runOrderWrite('prism', 'cancel', async () => { seen.push('cancel'); });
            await runOrderWrite('prism', 'place', async () => { seen.push('place'); });
        })();
        const other = runOrderWrite('prism', 'other', async () => { seen.push('other'); });
        await Promise.all([caller1, other]);
        assert.ok(seen.indexOf('cancel') < seen.indexOf('place'), seen.join(','));
        assert.strictEqual(seen.length, 3);
    }

    // 5. A hung call releases the line after maxSlotHoldMs; the caller of the hung call still gets its real result later.
    {
        const t0 = Date.now();
        const hung = runOrderWrite('breeze', 'hung', async () => { await sleep(900); return 'late'; });
        const next = runOrderWrite('breeze', 'next', async () => Date.now() - t0);
        const nextAt = await next;
        assert.ok(nextAt >= 400 && nextAt < 800, `next released after the hold limit, not after the hung call: ${nextAt}`);
        assert.strictEqual(await hung, 'late');
    }

    // 6. A write whose turn does not come within maxQueueWaitMs is not sent and fails NOT_PLACED.
    {
        setOrderQueueTimingsForTest({ gapMs: GAP, maxQueueWaitMs: 200, maxSlotHoldMs: 5000 });
        let sent = false;
        const blocker = runOrderWrite('kite', 'blocker', async () => { await sleep(350); });
        const starved = runOrderWrite('kite', 'starved', async () => { sent = true; });
        await assert.rejects(starved, (e) => isNotPlaced(e));
        assert.strictEqual(sent, false, 'a starved write is never sent');
        await blocker;
        // the line still works afterwards
        assert.strictEqual(await runOrderWrite('kite', 'after', async () => 7), 7);
    }

    setOrderQueueTimingsForTest();
    console.log('ALL TESTS PASSED');
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
