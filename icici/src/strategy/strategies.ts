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
