import Log from '../util/Log';
import fs, { readFileSync, writeFileSync } from 'fs';
import { load, dump } from 'js-yaml';
import AppConfig, { StrategyInstanceConfig } from './AppConfig';
import { normalizePercentFields, formatPercentFields } from './percentConfig';
import { validateConfigFile, coerceMaxInvestment } from './configValidation';

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

  // Percent fields are written with a '%' suffix (e.g. 40 -> "40%") so the
  // unit is visible in config.yml. loadConfig() accepts both forms.
  public writeConfig(config: AppConfig) {
    const shaped: AppConfig = {
      ...config,
      settings: formatPercentFields(config.settings as any),
      strategies: (config.strategies || []).map(s => formatPercentFields(s)),
    } as AppConfig;
    writeFileSync(this.configPath, dump(shaped, { noRefs: true }), 'utf8');
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
    // Any failure to read or validate the file is handled the same way: a
    // file that is not valid is never traded on. At startup this fails closed
    // (throws); on a live reload the previous config stays in effect and the
    // error is logged - a half-written or mid-edit file must not crash a
    // running trading process.
    let parsed: any;
    let errors: string[];
    try {
      parsed = load(readFileSync(this.configPath, 'utf8'));
      errors = validateConfigFile(parsed);
    } catch (e) {
      errors = [`config file does not parse: ${(e as Error).message}`];
    }
    if (errors.length > 0) {
      const msg = `config file rejected: ${errors.join('; ')}`;
      if (!this.config) throw new Error(msg);
      Log.log(`[ConfigService] ${msg} - keeping previous config`);
      return;
    }
    // Percent fields may be written as "2" or "2%"; normalise to numbers so
    // every consumer does arithmetic on a number.
    const normalizeBlock = (o: any) => normalizePercentFields(
      o && o.maxInvestment !== undefined ? { ...o, maxInvestment: coerceMaxInvestment(o.maxInvestment) } : o);
    parsed.settings = normalizeBlock(parsed.settings);
    if (Array.isArray(parsed.strategies)) {
      parsed.strategies = parsed.strategies.map((s: any) => normalizeBlock(s));
    }
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
