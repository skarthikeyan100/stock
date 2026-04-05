import Log from '../util/Log';
import { Strategy } from "./strategy";
import configService from '../prism/ConfigService';
import { createStrategiesFromConfig, expandRuleBasedConfig } from './StrategyFactory';
import { StrategyInstanceConfig } from '../prism/AppConfig';
import Monitor from '../monitor';
import { USER_LOSS_LIMIT, DEFAULT_LOT_LIMIT, DEFAULT_MAX_INVESTMENT } from "../constants";
import { getUser } from '../user';


class Strategies {
    private list : Array<Strategy> = [];
    private expandedConfigs: Map<string, StrategyInstanceConfig> = new Map();

    addToList(strategy: Strategy) {
        this.list.push(strategy);
        Monitor.getInstance().registerStrategy(strategy);
    }

    removeFromList(userId: string) {
        this.list = this.list.filter(s => s.userId !== userId);
        Monitor.getInstance().unregisterStrategy(userId);
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

        // Register each strategy with Monitor + set per-user limits
        for (const strategy of this.list) {
            Monitor.getInstance().registerStrategy(strategy);

            const strategyConfig = this.expandedConfigs.get(strategy.userId);
            if (strategyConfig) {
                const mongoUser = await getUser(strategy.userId);
                Monitor.getInstance().updateUserSettings(strategy.userId, {
                    lossLimit: mongoUser?.lossLimit ?? USER_LOSS_LIMIT,
                    lotLimit: mongoUser?.lotCount ?? DEFAULT_LOT_LIMIT,
                    maxInvestment: strategyConfig.maxInvestment || DEFAULT_MAX_INVESTMENT,
                });
            }
        }

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
