export type Right = 'CE' | 'PE';

export interface Signal {
  action: 'buy';
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
  allowedSenders: string[];
  investment: number;
  lotSize: number;
  target?: OffsetRule;
  stop?: OffsetRule;
  strikeBandPercent: number;
  priceMin: number;
  priceMax: number;
  dedupeWindowSeconds: number;
  headless: boolean;
  dryRun: boolean;
  profileDir: string;
  claudeModel?: string;
}
