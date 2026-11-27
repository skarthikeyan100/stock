import type { Page } from 'playwright';
import { BASE_URL, dashboardNav, dismissNotice } from './session.js';

export interface Credentials {
  mobile: string;
  password: string;
}

/** 6 digits, ignoring spaces and dashes; null otherwise. */
export function parseOtp(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

/** The site takes the 10-digit number without +91. */
export function normalizeMobile(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

/** From GOPOCKET_MOBILE / GOPOCKET_PASSWORD. Errors name the variable and never include a value. */
export function readCredentials(env: Record<string, string | undefined>): Credentials {
  const mobile = normalizeMobile(env.GOPOCKET_MOBILE ?? '');
  if (!mobile) throw new Error('GOPOCKET_MOBILE is missing or is not a 10-digit mobile number (set it in .env)');
  const password = env.GOPOCKET_PASSWORD;
  if (!password) throw new Error('GOPOCKET_PASSWORD is missing (set it in .env)');
  return { mobile, password };
}

/**
 * Mobile -> password -> 6-box OTP -> dashboard (field ids recorded from the site on 2026-11-17). The OTP is asked for
 * only after the password was accepted. Throws with a reason if a step does not appear; never logs a credential.
 */
export async function loginWithOtp(page: Page, creds: Credentials, askOtp: () => Promise<string>): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('#mobileNo_input').fill(creds.mobile, { timeout: 20_000 });
  await page.locator('#mobileNo_submit_btn').click();

  await page.locator('#password_input').fill(creds.password, { timeout: 20_000 });
  await page.locator('#password_submit_btn').click();

  const boxes = page.locator('input[type="tel"]');
  try {
    await boxes.first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    throw new Error('the OTP screen did not appear: the mobile number or password was probably rejected');
  }
  if ((await boxes.count()) !== 6) throw new Error('unexpected OTP screen (not 6 boxes)');

  const otp = parseOtp(await askOtp());
  if (!otp) throw new Error('the OTP must be exactly 6 digits');
  for (let i = 0; i < 6; i++) await boxes.nth(i).fill(otp[i]);
  const submit = page.locator('#verifyWebAuthOtp_submit_btn');
  if (await submit.isEnabled().catch(() => false)) await submit.click().catch(() => undefined); // it may already have submitted by itself

  try {
    await dashboardNav(page).waitFor({ state: 'visible', timeout: 30_000 });
  } catch {
    throw new Error('the dashboard did not appear: the OTP was probably wrong or expired');
  }
  await dismissNotice(page);
}

/**
 * For a headed browser: fills mobile + password from .env and leaves the OTP to the owner, who types it in the browser
 * window. Resolves once the dashboard is visible; throws if that does not happen within `waitMinutes`.
 */
export async function loginWithBrowserOtp(page: Page, creds: Credentials, waitMinutes = 10): Promise<void> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  // The site remembers the last account and may show only the password field.
  const mobile = page.locator('#mobileNo_input');
  const password = page.locator('#password_input');
  await mobile.or(password).first().waitFor({ state: 'visible', timeout: 20_000 });
  if (await mobile.isVisible()) {
    // The page may advance to the password step while this fills (the field is then detached); password.fill below decides.
    await mobile.fill(creds.mobile, { timeout: 5_000 }).catch(() => undefined);
    await page.locator('#mobileNo_submit_btn').click({ timeout: 5_000 }).catch(() => undefined); // the page may advance by itself
  }
  await password.fill(creds.password, { timeout: 20_000 });
  await page.locator('#password_submit_btn').click();
  console.log(`GoPocket: mobile and password submitted. Type the OTP in the browser window (waiting up to ${waitMinutes} minutes) ...`);
  try {
    await dashboardNav(page).waitFor({ state: 'visible', timeout: waitMinutes * 60_000 });
  } catch {
    throw new Error('the dashboard did not appear: the OTP was not entered in time, or was wrong');
  }
  await dismissNotice(page);
}
