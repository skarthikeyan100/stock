import Log from '../util/Log';
import { Strategy } from "./strategy";
import configService from '../prism/ConfigService';
import { createStrategiesFromConfig, expandRuleBasedConfig } from './StrategyFactory';
import { StrategyInstanceConfig } from '../prism/AppConfig';
import { isWithinTradingWindow, TRADING_WINDOW_LABEL } from '../util/marketHours';


class Strategies {
    private list : Array<Strategy> = [];
    private expandedConfigs: Map<string, StrategyInstanceConfig> = new Map();

    addToList(strategy: Strategy) {
        this.list.push(strategy);
    }

    removeFromList(userId: string) {
        this.list = this.list.filter(s => s.userId !== userId);
    }

    getList() { return this.list; }

    getByUserId(userId: string): Strategy | undefined {
        return this.list.find(s => s.userId === userId);
    }

    getExpandedConfig(userId: string): StrategyInstanceConfig | undefined {
        return this.expandedConfigs.get(userId);
    }

    async initialize() {
        const config = configService.getConfig();

        // Expand all configs (handles RuleBasedStrategy with multiple indicator rules)
        const expandedConfigArray = (config.strategies || []).flatMap(expandRuleBasedConfig);
        Log.log('[] expandedConfigArray: ', expandedConfigArray)

        // Store expanded configs in map for per-user limit lookups
        this.expandedConfigs.clear();
        for (const cfg of expandedConfigArray) {
            const userId = cfg.userId || cfg.type;
            this.expandedConfigs.set(userId, cfg);
        }

        this.list = createStrategiesFromConfig(config.strategies || []);
        // Per-user risk limits (loss/lot/investment) now live in the order
        // process (it's the only one that gates/executes orders) - see
        // orderProcess.ts's loadUserLimits().

        Log.log(`[Strategies] Initialized ${this.list.length} strategies:`,
            this.list.map(s => `${s.getClassName()}(${s.userId}, enabled=${s.enabled})`));

        this.enforceTradingWindow();
    }

    // Safety net: strategies may only ever be *enabled* inside the trading
    // window - deliberately one-directional (disable-only). Never
    // auto-re-enables a strategy just because the window reopened; the only
    // way a strategy becomes enabled again is a fresh explicit enable action
    // (a config save or the admin live-toggle, both gated through
    // setEnabledOverride/syncFromConfig below) made *while* within the
    // window. Called at startup (initialize()), on every config save
    // (syncFromConfig()), and periodically (see strategiesProcess.ts's
    // setInterval) so a strategy left enabled through window-close still gets
    // force-disabled without needing a restart.
    private enforceTradingWindow() {
        if (isWithinTradingWindow()) return;
        const toDisable = this.list.filter(s => s.enabled);
        if (toDisable.length === 0) return;
        toDisable.forEach(s => { s.enabled = false; });
        Log.log(`[Strategies] Outside trading window (${TRADING_WINDOW_LABEL}) - force-disabled ${toDisable.length} strategy(ies): ${toDisable.map(s => `${s.getClassName()}(${s.userId})`).join(', ')}`);
    }

    // Periodic re-check so a strategy enabled during the window still gets
    // force-disabled once it closes, without waiting for a restart or a
    // config save - see strategiesProcess.ts's setInterval caller. Never
    // re-enables anything (see enforceTradingWindow above).
    recheckTradingWindow() {
        this.enforceTradingWindow();
    }

    // Admin live-toggle (GET /strategies?...&enable=, strategiesProcess.ts's
    // 'setEnabled' IPC case) goes through here so an enable request outside
    // the trading window is simply refused (strategy stays disabled) rather
    // than briefly arming it before the next periodic enforceTradingWindow()
    // tick catches it - a disable request always goes through immediately,
    // window or not.
    setEnabledOverride(identifier: string, enabled: boolean): Strategy[] {
        const effective = enabled && isWithinTradingWindow();
        const matched = this.list.filter(s => s.userId === identifier || s.getClassName() === identifier);
        matched.forEach(s => { s.enabled = effective; });
        return matched;
    }

    // Live config-reload for an already-running process - unlike initialize()
    // above, this must NOT touch this.list (rebuilding it would discard live
    // per-position runtime state, e.g. BulkPcrStrategy's phase/heldTsym for an
    // open position). Refreshes only config-derived state: expandedConfigs
    // (which tokenRouter.ts's resolveSource reads for broker->feed routing)
    // and each existing strategy's enabled flag. A strategy type newly added
    // to config.yml while running still needs a restart to get an instance.
    syncFromConfig() {
        configService.reloadNow(); // don't wait on fs.watchFile's own poll - see ConfigService.reloadNow's comment
        const config = configService.getConfig();
        const expandedConfigArray = (config.strategies || []).flatMap(expandRuleBasedConfig);
        this.expandedConfigs.clear();
        for (const cfg of expandedConfigArray) {
            const userId = cfg.userId || cfg.type;
            this.expandedConfigs.set(userId, cfg);
            const strategy = this.list.find(s => s.userId === userId);
            if (strategy) strategy.enabled = cfg.enabled;
        }
        Log.log(`[Strategies] syncFromConfig: refreshed ${this.expandedConfigs.size} strategy configs`);
        this.enforceTradingWindow();
    }

    private constructor() {
    }

    static instance: Strategies | null = null;

    static getInstance() {
        if (Strategies.instance == null) {
            Strategies.instance = new Strategies();
        }
        return Strategies.instance;
      }

}


export default Strategies.getInstance()
