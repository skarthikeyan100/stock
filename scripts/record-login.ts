import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { dashboardNav } from '../src/order/session.js';

// One-time recorder: opens a headed browser with a THROWAWAY profile, you log in by hand, and every time the page's
// form changes it writes the field ids / labels / button texts to logs/login-flow.json. It never reads what you type
// (no input values), and the throwaway profile is deleted at the end. Your real session in browser-profile/ is untouched.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-record-login-'));
const context = await chromium.launchPersistentContext(dir, { headless: false, viewport: { width: 1296, height: 760 } });
const page = await context.newPage();
await page.goto('https://web.gopocket.in/', { waitUntil: 'domcontentloaded' });
console.log('Log in in the browser window (mobile number, password, OTP ...). Recording field names only. Waiting up to 10 minutes.');

const steps: unknown[] = [];
let last = '';
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  const snap = await page
    .evaluate(() => ({
      url: location.pathname,
      inputs: Array.from(document.querySelectorAll('input')).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => ({ id: e.id, name: e.name, type: e.type, placeholder: e.placeholder, maxLength: e.maxLength })),
      buttons: Array.from(document.querySelectorAll('button')).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => ({ id: e.id, text: (e.innerText || '').trim().slice(0, 40) })),
      headings: Array.from(document.querySelectorAll('h1,h2,h3,label')).map((e) => (e as HTMLElement).innerText.trim().slice(0, 60)).filter(Boolean).slice(0, 12),
    }))
    .catch(() => null);
  if (snap) {
    const key = JSON.stringify(snap);
    if (key !== last) {
      last = key;
      steps.push({ at: new Date().toISOString(), ...snap });
      console.log('screen', steps.length, snap.url, snap.inputs.map((i) => i.id || i.name || i.type).join(','), '|', snap.buttons.map((b) => b.text).join(','));
    }
  }
  if (await dashboardNav(page).isVisible().catch(() => false)) break;
  await page.waitForTimeout(500);
}
fs.mkdirSync('logs', { recursive: true });
fs.writeFileSync('logs/login-flow.json', JSON.stringify(steps, null, 2));
console.log(`Saved ${steps.length} screens to logs/login-flow.json`);
await context.close();
fs.rmSync(dir, { recursive: true, force: true });
