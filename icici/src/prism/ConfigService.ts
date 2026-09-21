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

  // Forces an immediate re-read, bypassing fs.watchFile's polling interval
  // (~5s by default). Needed by any live-sync path that must act on a config
  // write immediately (e.g. server.ts's POST /config calling into the
  // `strategies`/`order` processes' own syncFromConfig/loadUserLimits right
  // after writing) - each process has its own ConfigService instance with
  // its own independent poller, so without this, a sync call could read
  // stale in-memory config if it runs before that process's own poll happens
  // to fire, silently reintroducing the staleness this is meant to fix.
  public reloadNow(): void {
    this.loadConfig();
  }

  // fs.watch (inotify-backed on Linux) instead of fs.watchFile's stat-polling -
  // event-driven, near-instant, and avoids polling every process for a file
  // that changes rarely. fs.watch can fire more than once for a single save
  // (a well-known Node quirk) - harmless here since loadConfig() is a cheap,
  // idempotent re-read. Watches the file directly rather than its parent
  // directory: correct for this app's own writes (writeConfig always
  // overwrites in place via writeFileSync, never replaces the inode via
  // rename), which is the only writer that matters in practice.
  private watchConfig() {
    fs.watch(this.configPath, () => {
        Log.log('Config file changed. Reloading...');
        this.loadConfig();
      });
  }
  
}

export default ConfigService.getInstance()
