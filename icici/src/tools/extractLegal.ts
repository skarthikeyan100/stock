/**
 * Turns the frontend legal pages into plain structured text for the welcome-email PDFs (templates/legal/{terms,privacy}.json), so the PDFs
 * carry the same wording as the website. The pages stay the source of truth: re-run after editing them and commit the JSON.
 *
 *   npx tsc && node dist/tools/extractLegal.js
 */
import * as fs from 'fs';
import * as path from 'path';

export type LegalBlock = { t: 'h2' | 'h3' | 'p' | 'li'; depth?: number; text: string };
export interface LegalDoc { title: string; lastUpdated: string; blocks: LegalBlock[] }

const ENT: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘', '&ldquo;': '“', '&rdquo;': '”' };
const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, (m) => ENT[m] ?? m).replace(/\{'(.*?)'\}/g, '$1').replace(/\s+/g, ' ').trim();

export function extractLegal(tsx: string): LegalDoc {
    const title = clean((tsx.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) ?? [])[1] ?? '');
    const lastUpdated = clean((tsx.match(/Last Updated:[^<]*/) ?? [''])[0]);
    const blocks: LegalBlock[] = [];
    let depth = 0;
    // Walk h2/h3/p/li and list nesting in document order; an <li> that contains a nested <ul> keeps only its own leading text.
    const re = /<(\/?)(ul|h2|h3|p|li)\b[^>]*>|<\/?[a-zA-Z][^>]*>|([^<]+)/g;
    let m: RegExpExecArray | null;
    let open: { t: LegalBlock['t']; text: string; depth: number } | null = null;
    const flush = () => { if (open) { const text = clean(open.text); if (text) blocks.push({ t: open.t, depth: open.t === 'li' ? open.depth : undefined, text }); open = null; } };
    while ((m = re.exec(tsx))) {
        if (m[3] !== undefined) { if (open) open.text += m[3]; continue; }
        if (m[2] === undefined) continue; // inline tag (<strong>, <a>, <br/>): its text is picked up as plain text
        const closing = m[1] === '/'; const tag = m[2];
        if (tag === 'ul') { flush(); depth += closing ? -1 : 1; continue; }
        if (!closing) { flush(); open = { t: tag as LegalBlock['t'], text: '', depth: Math.max(0, depth - 1) }; } else { flush(); }
    }
    return { title, lastUpdated, blocks: blocks.filter((b) => !/^Last Updated:/.test(b.text)) };
}

if (require.main === module) {
    const root = path.resolve(__dirname, '..', '..');
    for (const [src, out] of [['TermsAndConditionsPage.tsx', 'terms.json'], ['PrivacyPolicyPage.tsx', 'privacy.json']]) {
        const doc = extractLegal(fs.readFileSync(path.join(root, 'frontend', 'src', 'pages', src), 'utf8'));
        fs.writeFileSync(path.join(root, 'templates', 'legal', out), JSON.stringify(doc, null, 1) + '\n');
        console.log(`${out}: "${doc.title}", ${doc.lastUpdated}, ${doc.blocks.length} blocks`);
    }
}
