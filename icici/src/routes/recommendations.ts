/** Recommendations (Advanced) and the owner's approval of them, plus the contractor's scoped read-only trade view. Spec v2.1 sections 6 and 9. */
import express from 'express';
import Log from '../util/Log';
import { asyncRouter } from './asyncRouter';
import { requireAdmin, requireAuth, resolveRealUser, resolveUser } from './session';
import OrderClient from '../processes/strategies/OrderClient';
import Mongo from '../tools/mongo';
import { ObjectId } from 'mongodb';
import { getContractorByEmail, getContractor, submissionBlock } from '../contractors/store';
import { Contractor } from '../contractors/types';
import { currentVersion } from '../contractors/agreements';
import { sebiUsable } from '../contractors/validate';
import { istDate } from '../contractors/agreements';
import { notifyAdmins, notifyUser } from '../contractors/notify';
import { RateLimiter } from '../contractors/rateLimit';
import { ensureSlot } from '../contractors/slots';
import { DEFAULT_ENTRY_OFFSET, RecommendationDoc, appendDecision, armSlot, contractLabel, recommendationRules, recommendationsCol, slotBlock, slotRefusal, validateRecommendation, withinHours, istHHMM } from '../contractors/recommendations';

const router = asyncRouter();
const orderClient = OrderClient.getInstance();
const submitLimiter = new RateLimiter(10, 60_000);
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function me(req: express.Request): Promise<Contractor | null> {
    const email = resolveUser(req);
    return email ? getContractorByEmail(email) : null;
}
const ownView = (r: RecommendationDoc) => ({ id: String(r._id), contract: r.contract, index: r.index, entry: r.entry, target: r.target, stop: r.stop, status: r.status, note: r.note ?? null, createdAt: r.createdAt, decidedAt: r.decidedAt ?? null });

// ---------- contractor ----------
router.post('/recommendations', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.type !== 'BUSINESS') { res.status(403).json({ error: 'Recommendations are for Advanced (Business) contractors' }); return; }
    if (!submitLimiter.allow(c.id)) { res.status(429).json({ error: 'Too many attempts. Try again in a minute.' }); return; }
    const blocked = submissionBlock(c, await currentVersion());
    if (blocked) { res.status(403).json({ error: blocked }); return; }
    if (!sebiUsable(c.sebi, istDate())) { res.status(403).json({ error: 'Your SEBI Registration No. must be recorded, verified by the owner and not expired before you can submit.' }); return; }
    const rules = recommendationRules();
    if (!withinHours(rules)) { res.status(422).json({ error: `Recommendations are accepted from ${rules.start} to ${rules.end} IST (it is ${istHHMM()} now).` }); return; }
    const slot = await ensureSlot(c);
    if (!slot || !slotBlock(slot)) { res.status(503).json({ error: 'No trading slot is available for you yet. The owner has been told.' }); await notifyAdmins('slot_missing', `No strategy slot available for ${c.name}.`, { contractorId: c.id }); return; }
    const block = slotBlock(slot);
    const v = validateRecommendation(req.body, block.entryOffset == null ? DEFAULT_ENTRY_OFFSET : Number(block.entryOffset));
    if (!v.ok) { res.status(400).json({ error: (v as { error: string }).error }); return; }
    const ok = v as Extract<typeof v, { ok: true }>;
    const day = istDate();
    const mine = (await recommendationsCol().find({ contractorId: c.id, day }).toArray()) as RecommendationDoc[];
    if (mine.some((r) => r.status === 'PENDING')) { res.status(409).json({ error: 'You already have a recommendation waiting for approval.' }); return; }
    if (mine.length >= rules.perDay) { res.status(409).json({ error: `At most ${rules.perDay} recommendation(s) per day.` }); return; }
    const refusal = slotRefusal(slot, { contract: ok.contract, entry: ok.value.entry, target: ok.value.target, stop: ok.value.stop });
    if (refusal) { res.status(409).json({ error: `Not accepted: ${refusal}.` }); return; }
    const doc: RecommendationDoc = { ...ok.value, contractorId: c.id, contractorName: c.name, contractorEmail: c.email, slot, contract: ok.contract, orderPrice: ok.orderPrice, day, status: 'PENDING', createdAt: new Date() };
    const ins = await recommendationsCol().insertOne(doc);
    doc._id = ins.insertedId;
    await appendDecision({ kind: 'recommendation_submitted', recommendationId: String(doc._id), contractorId: c.id, contract: doc.contract, entry: doc.entry, target: doc.target, stop: doc.stop });
    await notifyAdmins('approval_required', `${c.name}: ${doc.index} ${doc.contract} entry ${doc.entry}, target ${doc.target}, stop ${doc.stop}. Approve or reject.`, { recommendationId: String(doc._id) });
    res.json(ownView(doc));
});

router.get('/recommendations', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c || c.type !== 'BUSINESS') { res.status(403).json({ error: 'Forbidden' }); return; }
    const rows = (await recommendationsCol().find({ contractorId: c.id }).sort({ createdAt: -1 }).toArray()) as RecommendationDoc[];
    res.json(rows.map(ownView));
});

// ---------- owner ----------
const ownerView = (r: RecommendationDoc) => ({ ...ownView(r), kind: 'recommendation', contractorId: r.contractorId, contractorName: r.contractorName, slot: r.slot, orderPrice: r.orderPrice, decidedBy: r.decidedBy ?? null });

router.get('/owner/recommendations', requireAdmin, async function (req, res) {
    const status = str(req.query.status);
    const rows = (await recommendationsCol().find(status ? { status } : {}).sort({ createdAt: -1 }).toArray()) as RecommendationDoc[];
    res.json(rows.map(ownerView));
});

/** What the persistent approval pop-up shows: everything still waiting for the owner (it reappears after a reload until acted on). */
router.get('/owner/approvals/pending', requireAdmin, async function (_req, res) {
    const rows = (await recommendationsCol().find({ status: 'PENDING' }).sort({ createdAt: 1 }).toArray()) as RecommendationDoc[];
    res.json(rows.map(ownerView));
});

router.post('/owner/recommendations/:id/decision', requireAdmin, async function (req, res) {
    if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ error: 'bad id' }); return; }
    const decision = str(req.body?.decision);
    if (decision !== 'approve' && decision !== 'reject') { res.status(400).json({ error: 'decision must be approve or reject' }); return; }
    const note = str(req.body?.note) || undefined;
    const rec = (await recommendationsCol().findOne({ _id: new ObjectId(req.params.id) })) as RecommendationDoc | null;
    if (!rec || rec.status !== 'PENDING') { res.status(404).json({ error: 'No pending recommendation with that id' }); return; }
    const actor = resolveRealUser(req) ?? 'admin';
    if (decision === 'approve') {
        const c = await getContractor(rec.contractorId);
        if (!c || c.status !== 'ACTIVE') { res.status(409).json({ error: 'The contractor is no longer active' }); return; }
        if (rec.day !== istDate()) { res.status(409).json({ error: 'This recommendation is from an earlier day' }); return; }
        if (!sebiUsable(c.sebi, istDate())) { res.status(409).json({ error: 'The contractor SEBI registration is not verified or has expired' }); return; }
        const refusal = slotRefusal(rec.slot, rec);
        if (refusal) { res.status(409).json({ error: `Cannot approve now: ${refusal}.` }); return; }
    }
    // compare-and-set so a double click or two tabs cannot decide twice
    const r: any = await recommendationsCol().findOneAndUpdate({ _id: rec._id, status: 'PENDING' }, { $set: { status: decision === 'approve' ? 'APPROVED' : 'REJECTED', decidedAt: new Date(), decidedBy: actor, note } }, { returnOriginal: true });
    if (!r?.value) { res.status(409).json({ error: 'Already decided' }); return; }
    if (decision === 'approve') {
        try { armSlot(rec.slot, rec); }
        catch (e: any) {
            Log.log('[recommendations] arming the slot failed; reverting the approval:', e);
            await recommendationsCol().updateOne({ _id: rec._id }, { $set: { status: 'PENDING' }, $unset: { decidedAt: '', decidedBy: '' } });
            res.status(500).json({ error: `Could not arm the strategy: ${e?.message ?? e}` }); return;
        }
    }
    await appendDecision({ kind: 'recommendation', recommendationId: String(rec._id), contractorId: rec.contractorId, decision, actor, note, slot: rec.slot, contract: rec.contract, entry: rec.entry, target: rec.target, stop: rec.stop });
    await notifyUser(rec.contractorEmail, 'recommendation_decision', decision === 'approve' ? `${rec.contract} was approved.` : `${rec.contract} was not approved${note ? `: ${note}` : '.'}`);
    await notifyAdmins('approval_resolved', `${rec.contractorName} ${rec.contract}: ${decision === 'approve' ? 'approved' : 'rejected'}.`, { recommendationId: String(rec._id) });
    res.json(ownerView({ ...rec, status: decision === 'approve' ? 'APPROVED' : 'REJECTED', note }));
});

// ---------- the contractor's own trades: entry price and live P&L, read-only ----------
export function safeTrade(t: any, open: boolean) {
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return { contract: t.tsym ?? null, entryPrice: num(t.price), ltp: open ? num(Number(t.ltp)) : null, pnl: num(open ? t.unrealizedPnL : t.realizedPnL), open, entryTime: t.entryTime ?? null, exitTime: open ? null : (t.exitTime ?? null) };
}
async function tradesOf(slot: string) {
    if (!slot) return [];
    const stats = await orderClient.stats();
    const open = (stats.trades ?? []).filter((t: any) => t.user === slot && t.open !== false).map((t: any) => safeTrade(t, true));
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const closed = (await Mongo.getInstance().db.collection('closedTrades').find({ user: slot, exitTime: { $gte: since } }).sort({ exitTime: -1 }).toArray()).map((t: any) => safeTrade(t, false));
    return [...open, ...closed];
}
router.get('/contractor/trades', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forbidden' }); return; }
    res.json(await tradesOf(c.pseudoUserId));
});

const streamClients = new Map<express.Response, string>(); // res -> the contractor's slot
router.get('/contractor/positionstream', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forbidden' }); return; }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    req.on('close', () => streamClients.delete(res));
    streamClients.set(res, c.pseudoUserId);
    res.write(`data: ${JSON.stringify(await tradesOf(c.pseudoUserId))}\n\n`);
});
orderClient.onPositionsChanged(async () => {
    if (streamClients.size === 0) return;
    try {
        const stats = await orderClient.stats();
        for (const [res, slot] of streamClients) {
            if (!slot) continue;
            const open = (stats.trades ?? []).filter((t: any) => t.user === slot && t.open !== false).map((t: any) => safeTrade(t, true));
            const closed = (stats.closedTrades ?? []).filter((t: any) => t.user === slot).map((t: any) => safeTrade(t, false));
            res.write(`data: ${JSON.stringify([...open, ...closed])}\n\n`);
        }
    } catch (e) { Log.log('[contractor] positionstream push failed:', e); }
});

export default router;
