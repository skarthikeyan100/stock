#!/usr/bin/env node
'use strict';
// Broker login helper. For each broker it opens the trading server's /<broker>/login in its own Chrome window,
// fills the constant user id and password from broker-credentials.json, then asks in this terminal for that
// broker's OTP, one broker at a time, and submits it. The server's callback handles the rest.
//
// Usage: node scripts/login.js [--dry-run] [prism] [ant] [kite] [breeze]
//   --dry-run  fill user/password only; never submits, so no OTP is triggered
//   brokers    optional subset (default: all four)
// Env: CHROME_PATH (default /usr/bin/google-chrome), LOGIN_BASE_URL (default http://localhost:3000),
//      BROKER_CREDENTIALS (default <repo>/broker-credentials.json), LOGIN_HEADLESS=1 (testing only).

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer-core');

const ROOT = path.join(__dirname, '..');
const CREDS_FILE = process.env.BROKER_CREDENTIALS || path.join(ROOT, 'broker-credentials.json');
const BASE = (process.env.LOGIN_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const HEADLESS = process.env.LOGIN_HEADLESS === '1';
const ALL = ['prism', 'ant', 'kite', 'breeze'];
const LABEL = { prism: 'Prism (Shoonya)', ant: 'ANT (AliceBlue)', kite: 'Kite', breeze: 'Breeze (ICICI Direct)' };

// Field selectors, read from the live login pages (see the plan file). OTP fields on later steps are found by
// OTP_FIELD below rather than hard-coded, since those pages were not seen before a real OTP was sent.
const SITE = {
    // Shoonya shows user id, password and OTP on one page; the OTP is typed right before LOGIN is clicked.
    // getOtp: the OTP is only sent once the "Get OTP" link is clicked, so the script clicks it after filling the form.
    prism: { user: '#lgnusrid', pass: '#lgnpwd', otp: '#lgnotp', submit: 'button.lgnBtnClss', otpOnFirstPage: true, getOtp: 'Get OTP' },
    ant: { user: '#new_login_userId', pass: '#new_login_password', submit: '#buttonLabel_Next', verifySubmit: true },
    kite: { user: '#userid', pass: '#password', submit: 'button.button-orange' },
    breeze: { user: '#txtuid', pass: '#txtPass', tnc: '#chkssTnc', submit: '#btnSubmit' },
};

const OTP_FIELD = [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]', 'input[id*="otp" i]', 'input[placeholder*="otp" i]',
    'input[name*="totp" i]', 'input[id*="totp" i]', 'input[placeholder*="totp" i]',
    'input[name*="pin" i]', 'input[id*="pin" i]', 'input[placeholder*="pin" i]',
].join(', ');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(msg);
const die = (msg) => { console.error(`login: ${msg}`); process.exit(2); };

function loadCreds(brokers) {
    if (!fs.existsSync(CREDS_FILE)) die(`missing ${CREDS_FILE} - copy broker-credentials.example.json there and fill it in`);
    if (fs.statSync(CREDS_FILE).mode & 0o077) log(`warning: ${CREDS_FILE} is readable by other users - chmod 600 it`);
    let all;
    try { all = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')); } catch (e) { die(`${CREDS_FILE} is not valid JSON`); }
    for (const b of brokers) {
        const c = all[b];
        // Never echo the values: only say which broker entry is incomplete.
        if (!c || !String(c.user || '').trim() || !String(c.password || '').trim()) die(`${CREDS_FILE}: "${b}" needs non-empty user and password`);
    }
    return all;
}

async function checkServer() {
    try {
        await fetch(`${BASE}/`, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
        die(`trading server not reachable at ${BASE} - start it first with: npm run processes`);
    }
}

// Fill user id and password; for Breeze also tick the T&C box. Submits unless it is a dry run or the page
// takes the OTP on the same screen (Shoonya), which is submitted together with the OTP later.
async function fillCredentials(page, name, cred, dryRun) {
    const s = SITE[name];
    await page.waitForSelector(s.user, { visible: true, timeout: 30000 });
    await page.type(s.user, cred.user, { delay: 25 });
    await page.type(s.pass, cred.password, { delay: 25 });
    if (s.tnc && !(await page.$eval(s.tnc, (e) => e.checked))) await page.click(s.tnc);
    if (dryRun) return;
    if (s.getOtp) {
        const clicked = await page.evaluate((text) => {
            const el = [...document.querySelectorAll('a,button,span,div')]
                .find((e) => e.offsetParent !== null && (e.innerText || '').trim() === text);
            if (el) el.click();
            return !!el;
        }, s.getOtp);
        if (!clicked) throw new Error(`"${s.getOtp}" link not found`);
    }
    if (s.otpOnFirstPage) return;
    if (s.verifySubmit) await submitCredentials(page, s);
    else await page.click(s.submit);
}

// True while the password box is still on screen. A navigation (or a destroyed execution context) means the
// page moved on, so that counts as "step done".
const passwordStillShown = (page, s) =>
    page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && e.offsetParent !== null; }, s.pass)
        .catch(() => false);

// Clicks the submit button and checks the credentials step really went away. Every Next click that reaches
// AliceBlue's server sends an OTP SMS and opens popups, so a click is only ever repeated when NO request left the
// page after the previous one (the 2026-11-03 case: the click was ignored). Once a request is in flight the
// script just waits for the page to move on; it never clicks again. (Checked 2026-11-05: the form renders about
// 5s after navigation, right after the vendor-details call, and Next is enabled from the first moment.)
async function submitCredentials(page, s) {
    const attempts = [
        () => page.click(s.submit),
        () => page.$eval(s.submit, (b) => b.click()),
        () => page.focus(s.pass).then(() => page.keyboard.press('Enter')),
    ];
    let sent = 0;
    const onRequest = (r) => { if (r.method() !== 'GET' && /aliceblueonline\.com\/omk\//.test(r.url())) sent++; };
    page.on('request', onRequest);
    try {
        for (const attempt of attempts) {
            const before = sent;
            try { await attempt(); } catch (e) { if (!(await passwordStillShown(page, s))) return; }
            for (let i = 0; i < 12 && sent === before; i++) await sleep(150);
            if (sent === before) continue; // nothing was sent: the click was ignored, safe to try the next way
            // A request is in flight (an OTP is on its way): wait for the page to move on, never click again.
            for (let i = 0; i < 60; i++) {
                if (!(await passwordStillShown(page, s))) return;
                await sleep(500);
            }
            throw new Error('Next was clicked and a request was sent, but the page stayed on the password step (not clicking again to avoid a second OTP)');
        }
    } finally {
        page.off('request', onRequest);
    }
    throw new Error('submit button did not move past the user id/password step');
}

// Runs in the page: the first visible, empty OTP-type field matching OTP_FIELD, else the first empty numeric-looking box.
const FIND_OTP = (sel) => {
    const usable = (e) => e.offsetParent !== null && !e.disabled && !e.readOnly && !e.value &&
        !['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(e.type);
    const named = [...document.querySelectorAll(sel)].find(usable);
    if (named) return named;
    const inputs = [...document.querySelectorAll('input')].filter(usable);
    // ANT: Next removes the password box and shows one empty box for the OTP; the user id box is already filled.
    return inputs.find((e) => e.inputMode === 'numeric' || e.type === 'tel' || e.type === 'number' || e.maxLength === 4 || e.maxLength === 6)
        || inputs.find((e) => ['text', 'password', ''].includes(e.type))
        || null;
};

// Windows that were not opened in phase 1: a popup or new tab a broker may open for its OTP step.
async function extraPages(browser, known) {
    const knownSet = new Set(Object.values(known));
    return (await browser.pages()).filter((p) => !knownSet.has(p) && p.url() !== 'about:blank' && !p.isClosed());
}

// Waits up to 30s for an empty OTP field on the broker's window or any popup it opened. Returns {page, field} or null.
async function waitForOtpField(browser, known, name, timeoutMs = 30000) {
    const s = SITE[name];
    if (s.otpOnFirstPage) {
        const field = await known[name].$(s.otp);
        return field ? { page: known[name], field } : null;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const p of [known[name], ...(await extraPages(browser, known))]) {
            const field = (await p.evaluateHandle(FIND_OTP, OTP_FIELD)).asElement();
            if (field) return { page: p, field };
        }
        await sleep(500);
    }
    return null;
}

function ask(rl, question) {
    return new Promise((resolve) => rl.question(question, resolve));
}

// After the OTP is submitted, the broker redirects to the trading server's /<broker>/callback (or /shoonya/callback).
// The redirect may land in the broker's window or in a popup, so every window is checked. Returns the page that landed.
async function waitForCallback(browser, known, name, timeoutMs = 90000) {
    const origin = new URL(BASE).origin;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        for (const p of [known[name], ...(await extraPages(browser, known))]) {
            const u = new URL(p.url());
            // Back on the trading server and past the broker's own /<broker>/login route. Shoonya lands on "/" after
            // its callback, so the path is not required to contain "callback".
            if (u.origin === origin && !u.pathname.startsWith(`/${name}/login`)) return p;
        }
        await sleep(500);
    }
    throw new Error(`no redirect back to the trading server within ${timeoutMs / 1000}s (wrong or expired OTP?)`);
}

// Submits the OTP step: clicks the visible Submit/Verify/Login/Continue button on the page that holds the field
// (Breeze needs this; Enter alone does not submit), and presses Enter only when no such button exists.
async function submitOtp(page, field) {
    const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button,input[type=submit],input[type=button],a[role=button]')]
            .find((e) => e.offsetParent !== null && !e.disabled &&
                /submit|verify|login|continue|next|proceed/i.test((e.innerText || e.value || '').trim()));
        if (btn) btn.click();
        return !!btn;
    });
    if (!clicked) await field.press('Enter');
}

async function completeOtp(browser, known, name, rl) {
    const s = SITE[name];
    const found = await waitForOtpField(browser, known, name);
    if (!found) throw new Error('OTP field not found within 30s');
    const otp = (await ask(rl, `OTP for ${LABEL[name]}: `)).trim();
    if (!otp) throw new Error('no OTP entered');
    await found.field.type(otp, { delay: 25 });
    if (s.otpOnFirstPage) await found.page.click(s.submit);
    else await submitOtp(found.page, found.field);
    const landed = await waitForCallback(browser, known, name);
    // The server answers the callback with JSON; an error body means the session was not stored.
    const body = await landed.evaluate(() => (document.body && document.body.innerText) || '');
    if (/"error"\s*:/.test(body)) throw new Error(`server rejected the callback: ${body.slice(0, 160)}`);
    return landed;
}

// Visible form state of a page for a failure report: URL without its query (codes/tokens), title, the visible
// fields and buttons (never their typed values), and the start of the visible text (e.g. "Invalid OTP").
async function describePage(p) {
    return p.evaluate(() => {
        const vis = (e) => e.offsetParent !== null;
        return {
            url: location.origin + location.pathname,
            title: document.title,
            fields: [...document.querySelectorAll('input,select,textarea')].filter(vis).map((e) => ({
                type: e.type, id: e.id, name: e.name, placeholder: e.placeholder,
                autocomplete: e.autocomplete, inputmode: e.inputMode, maxlength: e.maxLength, filled: !!e.value,
            })),
            buttons: [...document.querySelectorAll('button,input[type=submit],input[type=button],a[role=button]')]
                .filter(vis).map((e) => `${(e.innerText || e.value || '').trim().slice(0, 30)} #${e.id}`),
            text: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
        };
    });
}

// Prints why a broker failed: the page state, the other open windows, and a screenshot file for the window.
async function report(browser, name, page, message) {
    log(`${LABEL[name]}: ✘ ${message}`);
    if (page && !page.isClosed()) {
        log(`  page state: ${JSON.stringify(await describePage(page).catch((e) => `unreadable: ${e.message}`))}`);
        const file = path.join(os.tmpdir(), `icici-login-${name}-fail.png`);
        await page.screenshot({ path: file }).catch(() => {});
        log(`  screenshot: ${file}`);
    }
    const others = (await browser.pages().catch(() => [])).map((p) => p.url().replace(/\?.*$/, '?…'));
    log(`  open windows: ${JSON.stringify(others)}`);
}

async function main() {
    const argv = process.argv.slice(2);
    const dryRun = argv.includes('--dry-run');
    const wanted = argv.filter((a) => !a.startsWith('--'));
    const brokers = wanted.length ? wanted : ALL;
    for (const b of brokers) if (!ALL.includes(b)) die(`unknown broker "${b}" (use: ${ALL.join(' ')})`);

    const creds = loadCreds(brokers);
    await checkServer();

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'icici-login-'));
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: HEADLESS,
        userDataDir,
        defaultViewport: null,
        args: ['--no-first-run', '--no-default-browser-check'],
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const pages = {};
    const failed = {};

    try {
        // One broker at a time: open it, enter user id and password (which triggers its OTP), then ask for that OTP
        // right away, so no OTP sits waiting while another broker is being handled. Dry run stops before any OTP.
        for (const b of brokers) {
            try {
                pages[b] = await browser.newPage();
                await pages[b].goto(`${BASE}/${b}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await fillCredentials(pages[b], b, creds[b], dryRun);
                log(`${LABEL[b]}: user id and password entered${dryRun ? ' (dry run, not submitted)' : ''}`);
                if (dryRun) continue;
                const landed = await completeOtp(browser, pages, b, rl);
                log(`${LABEL[b]}: ✔ logged in`);
                if (!landed.isClosed()) await landed.close();
                if (!pages[b].isClosed()) await pages[b].close();
            } catch (e) {
                failed[b] = e.message;
                await report(browser, b, pages[b], e.message);
                log(`  window left open to finish by hand`);
            }
        }
    } finally {
        rl.close();
        const failures = Object.keys(failed);
        if (failures.length || dryRun) {
            // Leave Chrome running so any failed window can be finished by hand.
            browser.disconnect();
            log(`Not logged in: ${failures.length ? failures.map((b) => LABEL[b]).join(', ') : 'none'}${dryRun ? ' (dry run: nothing submitted)' : ''}`);
        } else {
            await browser.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
            log(`All ${brokers.length} brokers logged in.`);
        }
        process.exitCode = failures.length ? 1 : 0;
    }
}

// Exit explicitly: after browser.disconnect() the Chrome pipes would otherwise keep Node alive.
main()
    .then(() => process.exit(process.exitCode || 0))
    .catch((e) => {
        console.error(`login: ${e.message}`);
        process.exit(1);
    });
