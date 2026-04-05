import Log from '../util/Log';
import fs, { readFileSync, writeFileSync } from 'fs';
import { load, dump } from 'js-yaml';
import AppConfig, { StrategyInstanceConfig } from './AppConfig';

class ConfigService {
  private configPath = process.env.CONFIG_PATH || './config.yml';
  public config: AppConfig;
  private static instance: ConfigService;

  private constructor() {
    this.loadConfig();
    this.watchConfig();
  }

  static getInstance() {
    if (ConfigService.instance == null) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  public writeConfig(config: AppConfig) {
    writeFileSync(this.configPath, dump(config), 'utf8');
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  public configToFlat(): Record<string, any> {
    const flat: Record<string, any> = { settings: this.config.settings };
    for (const strategy of this.config.strategies || []) {
      const { type, ...rest } = strategy;
      const key = type.charAt(0).toLowerCase() + type.slice(1);
      flat[key] = { type, ...rest };
    }
    return flat;
  }

  public flatToConfig(flat: Record<string, any>): AppConfig {
    const { settings, ...rest } = flat;
    const strategies = Object.values(rest).filter((v): v is StrategyInstanceConfig => !!v && typeof v.type === 'string');
    return { settings, strategies } as AppConfig;
  }

  public getStrategyConfig(type: string): StrategyInstanceConfig {
    const strategies = this.config.strategies || [];
    return strategies.find(s => s.type === type) || { type, enabled: false };
  }

  private loadConfig() {
    const fileContents = readFileSync(this.configPath, 'utf8');
    const parsed: any = load(fileContents);
    this.config = parsed as AppConfig;
    Log.log('Config Updated:', this.config);
  } 

  private watchConfig() {
    fs.watchFile(this.configPath, () => {
        Log.log('Config file changed. Reloading...');
        this.loadConfig();
      });
  }
  
}

export default ConfigService.getInstance()
