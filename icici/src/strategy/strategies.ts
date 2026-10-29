import Log from '../util/Log';
import { Strategy } from "./strategy";
import configService from '../prism/ConfigService';
import { createStrategiesFromConfig, expandRuleBasedConfig } from './StrategyFactory';
import { StrategyInstanceConfig } from '../prism/AppConfig';


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

    // Rebuilds the broker->feed routing table (tokenRouter.ts's resolveSource reads it) from the current config, and, when asked, copies
    // each existing strategy's `enabled` from it.
    private loadExpandedConfigs(syncEnabled: boolean): number {
        const config = configService.getConfig();
        // Expand all configs (handles RuleBasedStrategy with multiple indicator rules)
        const expandedConfigArray = (config.strategies || []).flatMap(expandRuleBasedConfig);
        this.expandedConfigs.clear();
        for (const cfg of expandedConfigArray) {
            const userId = cfg.userId || cfg.type;
            this.expandedConfigs.set(userId, cfg);
            if (syncEnabled) {
                const strategy = this.list.find(s => s.userId === userId);
                if (strategy) strategy.enabled = cfg.enabled;
            }
        }
        return this.expandedConfigs.size;
    }

    async initialize() {
        this.loadExpandedConfigs(false);
        this.list = createStrategiesFromConfig(configService.getConfig().strategies || []);
        // Per-user risk limits (loss/lot/investment) live in the order process (it's the only one that gates/executes orders) - see
        // orderProcess.ts's loadUserLimits().

        Log.log(`[Strategies] Initialized ${this.list.length} strategies:`,
            this.list.map(s => `${s.getClassName()}(${s.userId}, enabled=${s.enabled})`));
    }

    // Live config-reload for an already-running process - unlike initialize()
    // above, this must NOT touch this.list (rebuilding it would discard live
    // per-position runtime state, e.g. BulkPcrStrategy's phase/heldTsym for an
    // open position). Refreshes only config-derived state: expandedConfigs
    // and each existing strategy's enabled flag. A strategy newly added
    // to config.yml while running still needs a restart to get an instance.
    refreshFromConfig() {
        Log.log(`[Strategies] config reloaded: refreshed ${this.loadExpandedConfigs(true)} strategy configs`);
    }

    // For a caller that has just written config.yml and must see the effect now rather than after the watcher's debounce. The reload's
    // own onChange listener (the constructor below) does the refresh - calling refreshFromConfig() here as well ran it twice.
    syncFromConfig() {
        configService.reloadNow();
    }

    private constructor() {
        configService.onChange(() => {
            // Before initialize() there is no list to refresh yet.
            if (this.list.length > 0) this.refreshFromConfig();
        });
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
