export type Right = 'CE' | 'PE';

export interface Signal {
  action: 'buy';
  /** underlying symbol as the exchange spells it, upper-case: NIFTY, PAYTM, HAL ... */
  underlying: string;
  right: Right;
  strike: number;
  /** YYYY-MM-DD, only when the message states a date */
  expiry?: string;
  price: number;
  stop?: number;
  target?: number;
}

export interface OffsetRule {
  percent?: number;
  points?: number;
}

export interface Config {
  target?: OffsetRule;
  stop?: OffsetRule;
  strikeBandPercent: number;
  priceMin: number;
  priceMax: number;
  dedupeWindowSeconds: number;
  /** loopback port the WhatsApp router posts messages to */
  port: number;
  headless: boolean;
  dryRun: boolean;
  profileDir: string;
  claudeModel?: string;
}
