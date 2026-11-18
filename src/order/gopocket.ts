import fs from 'node:fs';
import type { Page } from 'playwright';
import { roundTick } from '../bracket.js';
import { chooseExpiry } from '../expiry.js';
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
  /** JAN..DEC: trade the nearest expiry inside this month */
  expiryMonth?: string;
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
  const choice = chooseExpiry(mine.map((x) => x.l), req, today);
  if (!choice) throw new Error(`no ${req.underlying} ${req.strike} ${req.right} listed for ${req.expiry ?? req.expiryMonth ?? 'any expiry'}`);
  const idx = mine.find((x) => x.l === choice.label)!.i;
  const row = rows.nth(idx);
  await row.hover();
  await row.locator('#mw_search_buy').click({ timeout: FILL_TIMEOUT });
  await page.locator('#ow_Cover').waitFor({ state: 'visible', timeout: 10_000 });
  return choice.label;
}

/** Values currently in the open Regular buy form (used to verify before Buy). */
async function readRegularForm(page: Page) {
  return {
    qty: await readNumber(page, '#qty'),
    price: await readNumber(page, '#price'),
    positional: await page.locator('#NRML').isChecked().catch(() => false),
  };
}

/**
 * Cover/bracket orders are not allowed, so: (1) a plain Regular Limit buy (Positional, so a GTT can exit it later),
 * (2) once it is filled, a sell OCO GTT (stoploss leg + target leg). The offsets in the request are differences from the
 * entry price. In dry run the buy form is filled, read back and cancelled; Buy is never clicked.
 */
export async function placeBracketBuy(page: Page, req: BuyRequest, cfg: Config, today: string): Promise<OrderOutcome> {
  try {
    if (!(await isLoggedIn(page))) return { status: 'unknown', reason: 'session expired: run npm run login' };
    await dismissNotice(page);
    const label = await openBuyForm(page, req, today);
    await page.locator('#ow_Regular').click();
    await page.locator('#ow_Limit').click();
    await page.locator('#NRML').check({ timeout: FILL_TIMEOUT });
    // One lot = the site's own lot quantity (the qty field's step); the lot size written in the message is ignored.
    const lot = Number(await page.locator('#qty').getAttribute('step', { timeout: FILL_TIMEOUT }));
    if (!(lot > 0)) {
      await saveEvidence(page, 'no-lot');
      await cancelForm(page);
      return { status: 'unknown', reason: 'could not read the lot size from the form' };
    }
    await setNumber(page, '#qty', lot);
    await setNumber(page, '#price', req.price);
    await page.locator('#price').blur();

    const f = await readRegularForm(page);
    console.log(`[buy-form] ${label}`, f);
    if (f.qty !== lot || !near(f.price, req.price) || !f.positional) {
      await saveEvidence(page, 'form-mismatch');
      await cancelForm(page);
      return { status: 'unknown', reason: `form mismatch: ${JSON.stringify(f)}` };
    }
    if (cfg.dryRun) {
      await cancelForm(page);
      return { status: 'unknown', reason: 'dry run' };
    }
    await page.locator('#ow_place_order_btn').click({ timeout: FILL_TIMEOUT });
    const outcome = await readResult(page, req);
    if (outcome.status !== 'placed' || !outcome.orderNo) return outcome;

    // The exit: wait for the fill, then protect the position with a sell OCO GTT.
    if (!(await waitForFill(page, req, 120_000))) {
      return { ...outcome, status: 'unknown', reason: `buy placed but not filled within 2 minutes: NO stop/target was placed, check the website (order ${outcome.orderNo})` };
    }
    try {
      await placeExitGtt(page, req, lot, today);
    } catch (err) {
      await saveEvidence(page, 'gtt-error');
      return { ...outcome, status: 'unknown', reason: `buy filled but the stop/target GTT FAILED (${(err as Error).message}): position is unprotected, check the website` };
    }
    return outcome;
  } catch (err) {
    await saveEvidence(page, 'buy-error');
    return { status: 'unknown', reason: `error: ${(err as Error).message}` };
  }
}

/** Matches an Executed row of this contract, e.g. "MANAPPURAM 23rd NOV 280 PE". */
export function contractRow(req: BuyRequest): RegExp {
  return new RegExp(`${req.underlying}\\s.*\\b${req.strike}(\\.0+)?\\s*${req.right}\\b`, 'i');
}

/** Polls Orders > Executed until the order shows COMPLETE. False on REJECTED/CANCELLED or timeout. */
async function waitForFill(page: Page, req: BuyRequest, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.goto(`${BASE_URL}/order`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/^Executed/).first().click({ timeout: FILL_TIMEOUT }).catch(() => undefined);
    await page.waitForTimeout(1_500);
    // The Executed rows carry no order number: look at every row of this contract.
    const rows = page.locator('tr, [role="row"]').filter({ hasText: contractRow(req) });
    const texts = await rows.allInnerTexts().catch(() => [] as string[]);
    if (texts.some((t) => /COMPLETE/i.test(t))) return true;
    await page.waitForTimeout(3_000);
  }
  return false;
}

/** Sell OCO GTT: stoploss leg (limit a little under the trigger so it fills) and target leg. */
export async function placeExitGtt(page: Page, req: BuyRequest, lot: number, today: string): Promise<void> {
  const stop = roundTick(req.price - req.stopOffset);
  const target = roundTick(req.price + req.targetOffset);
  const stopLimit = roundTick(stop * 0.95);
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
  await openBuyForm(page, req, today);
  await page.locator('#ow_sell:visible').click({ timeout: FILL_TIMEOUT });
  await page.locator('#ow_GTT:visible').click({ timeout: FILL_TIMEOUT });
  await page.locator('#ow_OCO:visible').click({ timeout: FILL_TIMEOUT });
  await setNumber(page, '#trigger_price:visible', stop);
  await setNumber(page, '#sl_bid_qty:visible', lot);
  await setNumber(page, '#scrip_price:visible', stopLimit);
  await setNumber(page, '#target_trig_price:visible', target);
  await setNumber(page, '#tar_bid_qty:visible', lot);
  await setNumber(page, '#target_price_ocd:visible', target);
  await page.locator('#target_price_ocd:visible').blur();
  console.log('[gtt-form]', {
    stop: await readNumber(page, '#trigger_price:visible'),
    stopLimit: await readNumber(page, '#scrip_price:visible'),
    target: await readNumber(page, '#target_trig_price:visible'),
    targetLimit: await readNumber(page, '#target_price_ocd:visible'),
    qty: await readNumber(page, '#sl_bid_qty:visible'),
  });
  await page.locator('#agreeCB:visible').check({ timeout: FILL_TIMEOUT });
  await page.locator('#gtt_ow_place_order_btn:visible').click({ timeout: FILL_TIMEOUT });
  await page.waitForTimeout(2_000);
}

/** Toast "<SYMBOL> - BUY - <orderNo>" + status; a REJECTED order's reason comes from Orders > Executed > Info. */
async function readResult(page: Page, req: BuyRequest): Promise<OrderOutcome> {
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
    return { status: 'rejected', symbol, orderNo, reason: await readRejectReason(page, req) };
  }
  if (status?.trim() && /OPEN|PENDING|COMPLETE|TRIGGER/.test(status)) return { status: 'placed', symbol, orderNo };
  await saveEvidence(page, 'toast-unclear');
  return { status: 'unknown', symbol, orderNo, reason: `toast status "${status?.trim() ?? ''}": check the website orders page` };
}

async function readRejectReason(page: Page, req: BuyRequest): Promise<string> {
  try {
    await page.goto(`${BASE_URL}/order`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/^Executed/).first().click({ timeout: FILL_TIMEOUT });
    const row = page.locator('tr, [role="row"]').filter({ hasText: /REJECTED/ }).filter({ hasText: contractRow(req) }).first();
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
