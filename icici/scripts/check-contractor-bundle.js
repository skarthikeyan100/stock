#!/usr/bin/env node
// Spec v2.1 acceptance tests 13 and 14: no user-facing string a CONTRACTOR can load contains a forbidden word, and no broker secret is in the client bundle.
// A contractor loads the entry chunk and the chunks it imports statically, plus the public Privacy Notice page. The trading, admin, owner and profile pages are
// separate lazy chunks that a contractor never downloads (their role is refused by the server anyway), so they are not scanned here.
// Usage: (cd frontend && SKIP_DEPLOY=1 npm run build) && node scripts/check-contractor-bundle.js
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const manifestPath = path.join(pub, '.vite', 'manifest.json');
if (!fs.existsSync(manifestPath)) { console.error('no public/.vite/manifest.json: build the frontend first'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
const CONTRACTOR_LAZY = ['src/pages/PrivacyNoticePage.tsx'];

const files = new Set();
const seen = new Set();
function visit(key) {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    const m = manifest[key];
    files.add(m.file);
    for (const c of m.css || []) files.add(c);
    for (const i of m.imports || []) visit(i);
}
visit(entryKey);
for (const k of CONTRACTOR_LAZY) visit(k);

const FORBIDDEN = [/PropFirm/i, /\btraders?\b/i, /Zerodha/i, /ICICI/i, /Alice\s*Blue/i, /\bKite\b/i, /Breeze/i, /allocated\s+capital/i, /forfeit/i];
const SECRETS = [/KYC_ENCRYPTION_KEY/, /SESSION_COOKIE_SECRET/, /GMAIL_REFRESH_TOKEN/, /GMAIL_CLIENT_SECRET/, /PDF_SIGN_P12/, /api[_-]?secret/i, /BEGIN (RSA |EC )?PRIVATE KEY/];
let bad = 0;
for (const f of files) {
    const text = fs.readFileSync(path.join(pub, f), 'utf8');
    for (const re of FORBIDDEN) {
        const m = text.match(new RegExp(`.{0,40}${re.source}.{0,40}`, re.flags.replace('g', '')));
        if (m) { bad++; console.error(`FORBIDDEN ${re} in ${f}: ...${m[0].replace(/\s+/g, ' ')}...`); }
    }
    for (const re of SECRETS) if (re.test(text)) { bad++; console.error(`SECRET-LIKE ${re} in ${f}`); }
}
// the HTML shell too
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
for (const re of FORBIDDEN) if (re.test(html)) { bad++; console.error(`FORBIDDEN ${re} in index.html`); }
console.log(`scanned ${files.size} contractor-loadable files: ${bad ? bad + ' problem(s)' : 'clean'}`);
process.exit(bad ? 1 : 0);
