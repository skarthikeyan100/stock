import fs from 'node:fs';
import type { Page } from 'playwright';
import { findExpiry, nearestExpiry } from '../expiry.js';
import type { Config } from '../types.js';
import { BASE_URL, dismissNotice, isLoggedIn } from './session.js';

/** NIFTY 50 level from the top bar, e.g. "NIFTY 50 25387.40 (0.38%)". Throws when it cannot be read. */
export async function readSpot(page: Page): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText();
    const m = text.match(/NIFTY 50\s+([\d,]+(?:\.\d+)?)/);
    const value = m ? Number(m[1].replace(/,/g, '')) : 0;
    if (value > 0) return value; // the bar shows 0 until the first quote arrives
    await page.waitForTimeout(500);
  }
  throw new Error('could not read the NIFTY 50 level from the page');
}

export interface BuyRequest {
  /** underlying symbol, e.g. NIFTY, PAYTM */
  underlying: string;
  right: 'CE' | 'PE';
  strike: number;
  /** YYYY-MM-DD; absent means the nearest listed expiry */
  expiry?: string;
  price: number;
  stopOffset: number;
  targetOffset: number;
}

export type OrderOutcome = { status: 'placed' | 'rejected' | 'unknown'; orderNo?: string; symbol?: string; reason?: string };

const FILL_TIMEOUT = 5_000;

async function saveEvidence(page: Page, tag: string): Promise<void> {
  try {
    fs.mkdirSync('logs', { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: `logs/${stamp}-${tag}.png` });
    fs.writeFileSync(`logs/${stamp}-${tag}.html`, await page.content());
  } catch {
    // evidence is best effort
  }
}

async function cancelForm(page: Page): Promise<void> {
  await page.locator('#ow_close_btn').click({ timeout: FILL_TIMEOUT }).catch(() => undefined);
}

async function setNumber(page: Page, selector: string, value: number): Promise<void> {
  const input = page.locator(selector);
  await input.fill(String(value), { timeout: FILL_TIMEOUT });
}

async function readNumber(page: Page, selector: string): Promise<number> {
  return Number(await page.locator(selector).inputValue({ timeout: FILL_TIMEOUT }));
}

/** Values currently in the open buy form (used to verify before Buy). */
export async function readForm(page: Page) {
  return {
    qty: await readNumber(page, '#qty'),
    price: await readNumber(page, '#price'),
    stop: await readNumber(page, '#triggerPrice'),
    target: await readNumber(page, '#targetPrice'),
    bracket: await page.locator('#ow_bo_checkbox').isChecked(),
  };
}

/** A search row belongs to this underlying: "NIFTY 17th NOV ..." yes, "FINNIFTY 17th NOV ..." no. */
export function underlyingRow(label: string, underlying: string): boolean {
  return label.toUpperCase().startsWith(`${underlying.toUpperCase()} `) && /^\S+ \d{1,2}(st|nd|rd|th) /i.test(label);
}

/** Stocks are listed on NFO and BFO: trade the NFO contract; BFO only when that is all there is (SENSEX). */
export function preferNfo(labels: string[]): string[] {
  const nfo = labels.filter((l) => /\bNFO\s*$/.test(l));
  return nfo.length > 0 ? nfo : labels;
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.001;

/** Opens the buy form for the contract: search, pick the expiry row, hover, click B. Returns the row label. */
async function openBuyForm(page: Page, req: BuyRequest, today: string): Promise<string> {
  await page.getByPlaceholder(/Search eg/).fill(`${req.underlying} ${req.strike} ${req.right}`);
  const rows = page.locator('[id^="mw_searchlist_li_"]');
  await rows.first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(800); // let the list settle after the last keystroke
  const labels = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  const rowsOfUnderlying = labels.map((l, i) => ({ l, i })).filter((x) => underlyingRow(x.l, req.underlying));
  const wanted = new Set(preferNfo(rowsOfUnderlying.map((x) => x.l)));
  const mine = rowsOfUnderlying.filter((x) => wanted.has(x.l));
  const choice = req.expiry ? findExpiry(mine.map((x) => x.l), req.expiry, today) : nearestExpiry(mine.map((x) => x.l), today);
  if (!choice) throw new Error(req.expiry ? `no ${req.underlying} ${req.strike} ${req.right} listed for ${req.expiry}` : `no ${req.underlying} ${req.strike} ${req.right} expiry found`);
  const idx = mine.find((x) => x.l === choice.label)!.i;
  const row = rows.nth(idx);
  await row.hover();
  await row.locator('#mw_search_buy').click({ timeout: FILL_TIMEOUT });
  await page.locator('#ow_Cover').waitFor({ state: 'visible', timeout: 10_000 });
  return choice.label;
}

/**
 * Bracket buy: Cover tab, Limit, Target (Bracket) ticked, stoploss/target as differences.
 * In dry run the form is filled, read back and cancelled; Buy is never clicked.
 */
export async function placeBracketBuy(page: Page, req: BuyRequest, cfg: Config, today: string): Promise<OrderOutcome> {
  try {
    if (!(await isLoggedIn(page))) return { status: 'unknown', reason: 'session expired: run npm run login' };
    await dismissNotice(page);
    const label = await openBuyForm(page, req, today);
    await page.locator('#ow_Cover').click();
    await page.locator('#ow_Limit').click();
    const box = page.locator('#ow_bo_checkbox');
    if (!(await box.isChecked())) await page.getByText('Target (Bracket)').click({ timeout: FILL_TIMEOUT });
    // One lot = the site's own lot quantity (the qty field's step); the lot size written in the message is ignored.
    const lot = Number(await page.locator('#qty').getAttribute('step', { timeout: FILL_TIMEOUT }));
    if (!(lot > 0)) {
      await saveEvidence(page, 'no-lot');
      await cancelForm(page);
      return { status: 'unknown', reason: 'could not read the lot size from the form' };
    }
    await setNumber(page, '#qty', lot);
    await setNumber(page, '#price', req.price);
    await setNumber(page, '#triggerPrice', req.stopOffset);
    await setNumber(page, '#targetPrice', req.targetOffset);
    await page.locator('#targetPrice').blur();

    const f = await readForm(page);
    const ok =
      f.bracket && f.qty === lot && near(f.price, req.price) && near(f.stop, req.stopOffset) && near(f.target, req.targetOffset);
    console.log(`[buy-form] ${label}`, f);
    if (!ok) {
      await saveEvidence(page, 'form-mismatch');
      await cancelForm(page);
      return { status: 'unknown', reason: `form mismatch: ${JSON.stringify(f)}` };
    }
    if (cfg.dryRun) {
      await cancelForm(page);
      return { status: 'unknown', reason: 'dry run' };
    }
    await page.locator('#ow_place_order_btn').click({ timeout: FILL_TIMEOUT });
    return await readResult(page);
  } catch (err) {
    await saveEvidence(page, 'buy-error');
    return { status: 'unknown', reason: `error: ${(err as Error).message}` };
  }
}

/** Toast "<SYMBOL> - BUY - <orderNo>" + status; a REJECTED order's reason comes from Orders > Executed > Info. */
async function readResult(page: Page): Promise<OrderOutcome> {
  const deadline = Date.now() + 10_000;
  let m: RegExpMatchArray | null = null;
  while (Date.now() < deadline && !m) {
    const text = await page.locator('body').innerText();
    m = text.match(/([A-Z][A-Z0-9&-]*\d\w*)\s*-\s*BUY\s*-\s*(\d+)\s*\n?\s*([A-Z ]+)?/);
    if (!m) await page.waitForTimeout(500);
  }
  if (!m) {
    await saveEvidence(page, 'no-toast');
    return { status: 'unknown', reason: 'no confirmation toast: check the website orders page' };
  }
  const [, symbol, orderNo, status] = m;
  if (status?.trim() === 'REJECTED') {
    return { status: 'rejected', symbol, orderNo, reason: await readRejectReason(page, orderNo) };
  }
  if (status?.trim() && /OPEN|PENDING|COMPLETE|TRIGGER/.test(status)) return { status: 'placed', symbol, orderNo };
  await saveEvidence(page, 'toast-unclear');
  return { status: 'unknown', symbol, orderNo, reason: `toast status "${status?.trim() ?? ''}": check the website orders page` };
}

async function readRejectReason(page: Page, orderNo: string): Promise<string> {
  try {
    await page.goto(`${BASE_URL}/order`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/^Executed/).first().click({ timeout: FILL_TIMEOUT });
    const row = page.locator('tr, [role="row"], div').filter({ hasText: /REJECTED/ }).filter({ hasText: orderNo }).last();
    await row.hover({ timeout: FILL_TIMEOUT });
    await row.getByText('More', { exact: true }).click({ timeout: FILL_TIMEOUT });
    await page.getByText('Info', { exact: true }).click({ timeout: FILL_TIMEOUT });
    const text = await page.locator('body').innerText();
    const r = text.match(/Rejected reason:?\s*(.+)/i);
    return r ? r[1].trim() : 'rejected (reason not shown)';
  } catch {
    await saveEvidence(page, 'reject-reason');
    return 'rejected (could not read the reason: check the website orders page)';
  }
}
