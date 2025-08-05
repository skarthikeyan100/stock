// configService.ts
import fs, { readFileSync, writeFileSync } from 'fs';
import { load, dump } from 'js-yaml';
import AppConfig from './AppConfig';

class ConfigService {
  private configPath = './config.yml';
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

  private loadConfig() {
    const fileContents = readFileSync(this.configPath, 'utf8');
    const parsed: any = load(fileContents);
    this.config = parsed as AppConfig;
    console.log('Config Updated:', this.config);
  } 

  private watchConfig() {
    // Watch for changes
      fs.watchFile(this.configPath, () => {
        console.log('Config file changed. Reloading...');
        this.loadConfig();
      });
  }
  
}

export default ConfigService.getInstance()
