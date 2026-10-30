import Log from '../util/Log';
import express from 'express';
import configService from '../prism/ConfigService';
import { validateFlatConfig, validateConfigFile } from '../prism/configValidation';
import OrderClient from '../processes/strategies/OrderClient';
import StrategiesClient from '../ipc/StrategiesClient';
import { asyncRouter } from './asyncRouter';
import { requireAdmin } from './session';
const strategiesClient = StrategiesClient.getInstance();

const router = asyncRouter();
const orderClient = OrderClient.getInstance();

// ============================== Strategy Admin ==============================


const strategiesRoute = async function (req: express.Request, res: express.Response) {
    try {
        // Read-only. Enabling or disabling a strategy is a config.yml edit (hot-reloaded by every process); an in-memory toggle
        // would be lost on restart and silently diverge from the file.
        res.json(await strategiesClient.list());
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
};
router.get('/strategies', requireAdmin, strategiesRoute);
router.post('/strategies', requireAdmin, strategiesRoute);

router.post('/strategies/:type/reset', requireAdmin, async function (req: express.Request, res) {
    try {
        const { type } = req.params;
        // ?userId=BulkPcr-NIFTY resets only that instance (default: every strategy of the type); ?clearPnl=true also clears the day's realized P&L.
        const userId = typeof req.query.userId === 'string' && req.query.userId ? req.query.userId : undefined;
        res.json(await strategiesClient.reset(type, { userId, clearPnl: req.query.clearPnl === 'true' }));
    } catch (e) {
        Log.log(e);
        res.sendStatus(500);
    }
});

// ============================== Market Data / Quotes ==============================








// ============================== Reconcile ==============================

// Explicit, on-demand broker-position + strategy reconcile - called only when
// broker positions and Mongo documents disagree. Nothing waits for it (ticks,
// order events and entries work without it). Order matters: `order` restores bookkeeping.trades from the
// brokers first, and only then do strategies reconcile against them. If any
// broker could not be read, strategies are NOT reconciled (they would otherwise
// conclude "no open position" from incomplete data) - 409 with the per-broker
// status so the caller can fix that broker's session and call again.
router.post('/reconcile', requireAdmin, async (req, res) => {
    try {
        const brokers = await orderClient.reconcileBrokerPositions();
        const failed = Object.entries(brokers).filter(([, ok]) => !ok).map(([broker]) => broker);
        if (failed.length > 0) {
            res.status(409).json({
                error: `broker positions could not be read for: ${failed.join(', ')} - strategies not reconciled. Log in to that broker and call POST /reconcile again.`,
                brokers,
            });
            return;
        }
        const strategies = await strategiesClient.reconcile();
        res.json({ brokers, strategies });
    } catch (e: any) {
        Log.log('[frontend] /reconcile failed:', e);
        res.status(500).json({ error: e?.message ?? 'reconcile failed' });
    }
});

// ============================== Configuration ==============================

router.get('/config', requireAdmin, (req, res) => {
    res.json(configService.configToFlat());
});

router.post('/config', requireAdmin, async (req, res) => {
    const flat = req.body;
    const current = configService.configToFlat();
    const errors = validateFlatConfig(flat, current);
    if (errors.length > 0) {
        return res.status(400).json({ error: errors.join('; ') });
    }
    // Refuse a save that the reload would reject (ConfigService.loadConfig runs
    // the same file-level check), so the admin is told instead of the file
    // being written and the old config silently staying live.
    const nextConfig = configService.flatToConfig(flat);
    const fileErrors = validateConfigFile(nextConfig);
    if (fileErrors.length > 0) {
        return res.status(400).json({ error: fileErrors.join('; ') });
    }
    // A save must never silently drop a strategy instance (it would be removed from the running processes, possibly
    // with an open position). Removal is only allowed when explicitly requested with ?allowRemove=true.
    const kept = new Set((nextConfig.strategies || []).map((s: any) => configService.instanceKey(s)));
    const dropped = (configService.getConfig().strategies || []).filter((s: any) => !kept.has(configService.instanceKey(s)));
    if (dropped.length > 0 && req.query.allowRemove !== 'true') {
        return res.status(400).json({ error: `Save would remove strategy instance(s): ${dropped.map((s: any) => `${s.type}:${s.userId || s.type}`).join(', ')}. Re-send with ?allowRemove=true if intended.` });
    }
    configService.writeConfig(nextConfig);
    configService.reloadNow(); // this process's own in-memory copy shouldn't lag its own write either

    // config.yml is hot-*read* (ConfigService.watchConfig), but several
    // fields are only ever consumed once at process boot and cached from
    // there (a strategy's `enabled`/`broker` in `strategies`'s Strategies
    // list and expandedConfigs; `broker`/`maxInvestment`/`useGTT` in
    // `order`'s bookkeeping settings cache - see Strategies.syncFromConfig's
    // and loadUserLimits's own comments). Refresh both unconditionally on
    // every save rather than diffing which specific field changed - both are
    // cheap, idempotent, and never touch live position/trade state, so this
    // is simpler and can't miss a field the way a per-field diff can.
    try {
        await strategiesClient.syncFromConfig();
    } catch (e) {
        Log.log('[config] Failed to live-sync strategies process:', e);
    }
    try {
        await orderClient.reloadUserLimits();
    } catch (e) {
        Log.log('[config] Failed to live-sync order-process user limits:', e);
    }

    res.json(flat);
});


export default router;
