import Log from '../util/Log';
import fs, { readFileSync } from 'fs';
import path from 'path';
import { load, dump } from 'js-yaml';
import AppConfig, { StrategyInstanceConfig } from './AppConfig';
import { normalizePercentFields, formatPercentFields } from './percentConfig';
import { validateConfigFile, coerceMaxInvestment } from './configValidation';
import { withCanonicalSettings, withCanonicalStrategy } from './configVocabulary';

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
    // Atomic: write a temp file in the same directory, fsync, then rename over the target. A watcher/reader (or a crash,
    // ENOSPC) can therefore never see an empty or half-written config.yml. Synchronous end to end, so two POST /config
    // handlers in this process cannot interleave their writes either.
    const tmp = `${this.configPath}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, dump(shaped, { noRefs: true }), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.configPath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  public configToFlat(): Record<string, any> {
    const flat: Record<string, any> = { settings: this.config.settings };
    for (const strategy of this.config.strategies || []) {
      const { type, ...rest } = strategy;
      const base = type.charAt(0).toLowerCase() + type.slice(1);
      // The first instance of a type keeps the plain key (what the admin UI already uses); further instances of the
      // same type (told apart by userId) get `<key>:<userId>` so none is collapsed onto another.
      let key = base;
      if (key in flat) {
        key = `${base}:${(rest as any).userId ?? ''}`;
        for (let i = 2; key in flat; i++) key = `${base}:${(rest as any).userId ?? ''}#${i}`;
      }
      flat[key] = { type, ...rest };
    }
    return flat;
  }

  public flatToConfig(flat: Record<string, any>): AppConfig {
    const { settings, ...rest } = flat;
    const strategies = Object.values(rest).filter((v): v is StrategyInstanceConfig => !!v && typeof v.type === 'string');
    return { settings, strategies } as AppConfig;
  }

  // Identity of a strategy instance for save-time comparisons: type + userId (userId defaults to the type, as
  // Strategies.initialize does).
  public instanceKey(s: { type: string; userId?: string }): string {
    return `${s.type}|${s.userId || s.type}`;
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
    // maxInvestment/maxExposure may be quoted in YAML ("100000"): coerced to a number, and both names kept in step (the canonical one
    // wins - see configVocabulary.ts).
    const normalizeBlock = (o: any) => {
      if (!o) return o;
      const exposure = o.maxExposure ?? o.maxInvestment;
      return normalizePercentFields(exposure !== undefined ? { ...o, maxExposure: coerceMaxInvestment(exposure), maxInvestment: coerceMaxInvestment(exposure) } : o);
    };
    parsed.settings = withCanonicalSettings(normalizeBlock(parsed.settings));
    if (Array.isArray(parsed.strategies)) {
      parsed.strategies = parsed.strategies.map((s: any) => withCanonicalStrategy(normalizeBlock(s)));
    }
    this.config = parsed as AppConfig;
    Log.log(`Config Updated: ${(this.config.strategies || []).length} strategies (${(this.config.strategies || []).map((s: any) => `${s.type}${s.userId ? ':' + s.userId : ''}${s.enabled ? '' : '(off)'}`).join(', ')})`);
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
