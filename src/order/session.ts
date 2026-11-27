import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { isListening } from '../startup.js';
import type { Config } from '../types.js';

export const BASE_URL = 'https://web.gopocket.in';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const DEBUG_PORT = 9222;

/**
 * One visible Chromium with a persistent profile on disk (the login token lives in its localStorage). It is started
 * once, detached, with a debugging port, and every gopocket run (including each tsc-watch restart) connects to that same
 * browser instead of opening a new one. It keeps running when gopocket exits.
 */
export async function openContext(cfg: Config): Promise<BrowserContext> {
  if (!(await isListening(DEBUG_PORT))) {
    // Started through a shell that exits at once, so the browser is not a child of gopocket: tsc-watch kills gopocket's
    // whole child tree on every restart, which would close a direct child.
    spawn(
      'sh',
      ['-c', 'setsid "$0" "$@" >/dev/null 2>&1 &', chromium.executablePath(), `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.resolve(ROOT, cfg.profileDir)}`, '--window-size=1296,760', '--no-first-run', '--no-default-browser-check', 'about:blank'],
      { detached: true, stdio: 'ignore' },
    ).unref();
    for (let i = 0; i < 30 && !(await isListening(DEBUG_PORT)); i++) await new Promise((r) => setTimeout(r, 500));
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  return browser.contexts()[0];
}

/** The dashboard nav ("Holdings") is visible only when logged in; the login page shows a password field. */
export function dashboardNav(page: Page) {
  return page.getByText('Holdings', { exact: true }).first();
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  const nav = dashboardNav(page);
  const password = page.locator('input[type="password"]');
  try {
    await nav.or(password).first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    return false;
  }
  return nav.isVisible();
}

/** Clicks the "Risk Disclosure" notice's button only if it is showing. */
export async function dismissNotice(page: Page): Promise<boolean> {
  const button = page.getByRole('button', { name: 'I understand' });
  try {
    await button.waitFor({ state: 'visible', timeout: 2_000 });
    await button.click();
    return true;
  } catch {
    return false;
  }
}
