/** Beginner forecasts: submit, state, history, accuracy (contractor) and the owner's pilot dashboard. Spec v2.1 sections 7, 8 and 12. Nothing here tells a contractor whether or how a forecast was used. */
import express from 'express';
import { asyncRouter } from './asyncRouter';
import { requireAdmin, requireAuth, resolveUser } from './session';
import Mongo from '../tools/mongo';
import { getContractorByEmail, listContractors } from '../contractors/store';
import { Contractor } from '../contractors/types';
import { ForecastEngine } from '../forecast/engine';
import { ForecastDoc, accuracyOf, forecastsCol, forecastsOfDay } from '../forecast/store';
import { getForecastConfig, istParts } from '../forecast/rules';
import { istDate } from '../contractors/agreements';
import { isNiftyExpiryDay } from '../util/marketHours';

const router = asyncRouter();
const engine = () => ForecastEngine.getInstance();

async function me(req: express.Request): Promise<Contractor | null> {
    const email = resolveUser(req);
    const c = email ? await getContractorByEmail(email) : null;
    return c && c.type === 'INDIVIDUAL' ? c : null;
}
const view = (f: ForecastDoc) => ({
    id: f.id, direction: f.direction, confidence: f.confidence ?? null, submittedAt: f.submittedAt, windowEndsAt: new Date(f.submittedAt.getTime() + f.windowMinutes * 60_000),
    outcome: f.outcome, indexAtSubmit: f.refValueStart, indexAtEnd: f.refValueEnd ?? null, scoredAt: f.scoredAt ?? null,
});

router.post('/forecast', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forecasts are for Researchers (Individual, PAN)' }); return; }
    const r = await engine().submit(c, req.body);
    if (r.ok === false) { const f = r as { status: number; error: string }; res.status(f.status).json({ error: f.error }); return; }
    const ok = r as Extract<typeof r, { ok: true }>;
    res.json({ ...ok.forecast, message: `Forecast recorded at ${istParts(ok.forecast.submittedAt).hhmm}. Window closes at ${istParts(ok.forecast.windowEndsAt).hhmm}.` });
});

/** What the Up/Down screen needs: the live NIFTY value, today's count, the open window if any, and whether submitting is possible. */
router.get('/forecast/state', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forbidden' }); return; }
    const cfg = getForecastConfig();
    const today = await forecastsOfDay(c.id, istDate());
    const open = today.find((f) => f.outcome === 'OPEN' && f.submittedAt.getTime() + f.windowMinutes * 60_000 > Date.now());
    let expiry = false; try { expiry = isNiftyExpiryDay(); } catch { /* normal day */ }
    const latest = engine().latest();
    res.json({ nifty: latest && Date.now() - latest.ts < 10_000 ? latest.ltp : null, dailyLimit: cfg.dailyLimit, usedToday: today.length, windowMinutes: cfg.windowMinutes,
        hours: { start: cfg.hours.start, end: expiry ? cfg.hours.expiryEnd : cfg.hours.end }, openWindow: open ? view(open) : null, available: engine().isReady() });
});

router.get('/forecast/history', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forbidden' }); return; }
    const rows = (await forecastsCol().find({ contractorId: c.id }).sort({ submittedAt: -1 }).limit(200).toArray()) as ForecastDoc[];
    res.json(rows.map(view));
});

/** Rolling accuracy over 7 days, 30 days and all time (VOID is excluded). */
router.get('/forecast/accuracy', requireAuth, async function (req, res) {
    const c = await me(req);
    if (!c) { res.status(403).json({ error: 'Forbidden' }); return; }
    const rows = (await forecastsCol().find({ contractorId: c.id, outcome: { $ne: 'OPEN' } }).toArray()) as ForecastDoc[];
    const since = (d: number) => new Date(Date.now() - d * 86_400_000);
    res.json({ d7: accuracyOf(rows.filter((r) => r.submittedAt >= since(7))), d30: accuracyOf(rows.filter((r) => r.submittedAt >= since(30))), all: accuracyOf(rows) });
});

// ---------- owner pilot dashboard ----------
router.get('/owner/engine', requireAdmin, async function (_req, res) {
    const e = engine();
    res.json({ ready: e.isReady(), startFailure: e.startFailure(), ordersEnabled: e.ordersEnabled(), passThroughAlarm: { firing: e.alarm.firing(), rejectionRate: e.alarm.rate() }, niftyAgeMs: e.latest() ? Date.now() - (e.latest() as { ts: number }).ts : null });
});

router.get('/owner/forecasts', requireAdmin, async function (req, res) {
    const day = typeof req.query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day) ? req.query.day : istDate();
    const contractors = (await listContractors()).filter((c) => c.type === 'INDIVIDUAL');
    const names = new Map(contractors.map((c) => [c.id, c.name]));
    const forecasts = (await forecastsCol().find({ day }).sort({ submittedAt: -1 }).toArray()) as ForecastDoc[];
    const decisions = await Mongo.getInstance().db.collection('decisions').find({ kind: 'forecast', forecastId: { $in: forecasts.map((f) => f.id) } }).toArray();
    const byForecast = new Map(decisions.map((d: any) => [d.forecastId, d]));
    const per = contractors.map((c) => {
        const fs = forecasts.filter((f) => f.contractorId === c.id);
        const ds = fs.map((f) => byForecast.get(f.id)).filter(Boolean) as any[];
        return { contractorId: c.id, name: c.name, forecasts: fs.length, accepted: ds.filter((d) => d.accepted).length, rejected: ds.filter((d) => !d.accepted).length, ordersPlaced: ds.filter((d) => d.orderPlaced).length, accuracy: accuracyOf(fs.filter((f) => f.outcome !== 'OPEN')) };
    });
    res.json({ day, per, recent: forecasts.slice(0, 100).map((f) => ({ ...view(f), contractor: names.get(f.contractorId) ?? f.contractorId, decision: byForecast.get(f.id) ? { accepted: (byForecast.get(f.id) as any).accepted, reason: (byForecast.get(f.id) as any).reason, filters: (byForecast.get(f.id) as any).filters, orderPlaced: (byForecast.get(f.id) as any).orderPlaced, orderNote: (byForecast.get(f.id) as any).orderNote } : null })) });
});

export default router;
