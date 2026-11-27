export type Right = 'CE' | 'PE';

export interface Signal {
  action: 'buy';
  /** underlying symbol as the exchange spells it, upper-case: NIFTY, SENSEX, BANKNIFTY ... */
  underlying: string;
  right: Right;
  strike: number;
  /** YYYY-MM-DD, only when the message states a date */
  expiry?: string;
  /** three-letter month (JAN..DEC) when the message names the expiry month but no date, e.g. "( NOV: 2000.00 CE)" */
  expiryMonth?: string;
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
  /** most money (rupees, price x quantity) put into one buy */
  maxInvestment: number;
  strikeBandPercent: number;
  priceMin: number;
  priceMax: number;
  dedupeWindowSeconds: number;
  /** loopback port the WhatsApp router posts messages to */
  port: number;
  profileDir: string;
  claudeModel?: string;
}
