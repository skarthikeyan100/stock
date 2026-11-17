import type { Page } from 'playwright';

/** NIFTY 50 level from the top bar, e.g. "NIFTY 50 25387.40 (0.38%)". Throws when it cannot be read. */
export async function readSpot(page: Page): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const text = await page.locator('body').innerText();
    const m = text.match(/NIFTY 50\s+([\d,]+(?:\.\d+)?)/);
    if (m) return Number(m[1].replace(/,/g, ''));
    await page.waitForTimeout(500);
  }
  throw new Error('could not read the NIFTY 50 level from the page');
}

export interface BuyRequest {
  right: 'CE' | 'PE';
  strike: number;
  /** YYYY-MM-DD; absent means the nearest listed expiry */
  expiry?: string;
  price: number;
  lots: number;
  stopOffset: number;
  targetOffset: number;
}

export type OrderOutcome = { status: 'placed' | 'rejected' | 'unknown'; orderNo?: string; symbol?: string; reason?: string };
