import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgwrite-'));
const file = path.join(dir, 'config.yml');
fs.writeFileSync(file, 'settings:\n  maxProfit: 5\nstrategies: []\nforecast:\n  enabled: true\nother:\n  a: 1\n');
process.env.CONFIG_PATH = file;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const configService = require('../prism/ConfigService').default;

const readKeys = () => Object.keys(require('js-yaml').load(fs.readFileSync(file, 'utf8')) as any).sort();
const fresh = () => ({ settings: { maxProfit: 5 }, strategies: [] } as any);

// default: a caller that writes a config without a block removes it (no hidden re-adding)
configService.writeConfig(fresh());
assert.deepStrictEqual(readKeys(), ['settings', 'strategies'], 'plain writeConfig keeps the old behaviour');

// opt-in (POST /config): other top-level blocks of the file survive
fs.writeFileSync(file, 'settings:\n  maxProfit: 5\nstrategies: []\nforecast:\n  enabled: true\nother:\n  a: 1\n');
configService.writeConfig(fresh(), { preserveTopLevelKeys: true });
assert.deepStrictEqual(readKeys(), ['forecast', 'other', 'settings', 'strategies'], 'preserveTopLevelKeys keeps forecast and other');

fs.rmSync(dir, { recursive: true, force: true });
console.log('configWritePreserveKeys: all assertions passed');
process.exit(0);
