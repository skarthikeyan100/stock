import Log from '../util/Log';
import fs, { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { load, dump } from 'js-yaml';
import AppConfig, { StrategyInstanceConfig } from './AppConfig';
import { normalizePercentFields, formatPercentFields } from './percentConfig';
import { validateConfigFile, coerceMaxInvestment } from './configValidation';

class ConfigService {
  private configPath = process.env.CONFIG_PATH || './config.yml';
  public config: AppConfig;
  private static instance: ConfigService;
  private listeners: Array<() => void> = [];
  private reloadTimer: NodeJS.Timeout | null = null;

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
    for (const cb of this.listeners) {
      try { cb(); } catch (e) { Log.log(`[ConfigService] onChange listener failed: ${(e as Error).message}`); }
    }
  }

  // Runs after every successful (re)load, so config-derived state held outside
  // this class (strategy enabled flags, the order process's user-settings
  // cache) follows config.yml edits without a manual sync. Not called for a
  // rejected file. Listeners must not call reloadNow() (would recurse).
  public onChange(cb: () => void): void {
    this.listeners.push(cb);
  }

  // Forces an immediate re-read for callers that must act on a write they just
  // made, without waiting for the watcher's debounce.
  public reloadNow(): void {
    this.loadConfig();
  }

  // Watches the parent directory (inotify, event-driven) filtered on the file
  // name, not the file itself: editors, `sed -i` and `git checkout` save by
  // replacing the inode, which silently kills a watch on the file path after
  // the first change. Events are debounced since one save fires several.
  private watchConfig() {
    const dir = path.dirname(this.configPath);
    const base = path.basename(this.configPath);
    const arm = () => {
      try {
        const w = fs.watch(dir, (_evt, name) => {
          if (name && name !== base) return;
          if (this.reloadTimer) clearTimeout(this.reloadTimer);
          this.reloadTimer = setTimeout(() => {
            this.reloadTimer = null;
            Log.log('Config file changed. Reloading...');
            this.loadConfig();
          }, 200);
        });
        w.on('error', (e) => {
          Log.log(`[ConfigService] config watcher error: ${e.message} - re-arming`);
          w.close();
          setTimeout(arm, 1000);
        });
      } catch (e) {
        Log.log(`[ConfigService] could not watch ${dir}: ${(e as Error).message} - retrying`);
        setTimeout(arm, 5000);
      }
    };
    arm();
  }

}

export default ConfigService.getInstance()
