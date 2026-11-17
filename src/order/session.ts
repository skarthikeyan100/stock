import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import type { Config } from '../types.js';

export const BASE_URL = 'https://web.gopocket.in';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** One persistent browser profile on disk: the login token lives in its localStorage. */
export async function openContext(cfg: Config, opts: { headless?: boolean } = {}): Promise<BrowserContext> {
  return chromium.launchPersistentContext(path.resolve(ROOT, cfg.profileDir), {
    headless: opts.headless ?? cfg.headless,
    viewport: { width: 1296, height: 760 },
  });
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
