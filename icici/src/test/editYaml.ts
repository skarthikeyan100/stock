// Edits a temp copy of config.yml through the parsed object, not through text replacement: the running app rewrites config.yml (comments
// dropped, flow maps turned into block maps), so a test that replaced an exact line of text broke whenever the file was reformatted.
import * as fs from 'fs';
import { load, dump } from 'js-yaml';

export function editYaml(file: string, mut: (cfg: any) => void): void {
    const cfg: any = load(fs.readFileSync(file, 'utf8'));
    mut(cfg);
    fs.writeFileSync(file, dump(cfg, { lineWidth: -1 }));
}
