import type { Action, Right, TradeMessage } from './types.js';

const INSTRUMENT_PATTERNS: Array<{ regex: RegExp; name: string }> = [
  { regex: /\bBANKNIFTY\b/i, name: 'BANKNIFTY' },
  { regex: /\bBNF\b/i, name: 'BANKNIFTY' },
  { regex: /\bFINNIFTY\b/i, name: 'FINNIFTY' },
  { regex: /\bFNF\b/i, name: 'FINNIFTY' },
  { regex: /\bNIFTY\b/i, name: 'NIFTY' },
  { regex: /\bNF\b/i, name: 'NIFTY' },
  { regex: /\bSENSEX\b/i, name: 'SENSEX' },
];

const STRIKE_TYPE_AFTER = /\b(\d{3,6})[\s:]*(CE|PE|CALL|PUT)\b/i;
const STRIKE_TYPE_BEFORE = /\b(CE|PE|CALL|PUT)[\s:]*(\d{3,6})\b/i;

const PRICE_PATTERN = /(?:@|cmp|entry\s*price|entry|at)[\s:-]*(?:rs\.?|₹)?[\s:]*(\d+(?:\.\d+)?)/i;

const QUANTITY_PATTERN = /(?:qty|quantity)[\s:-]*(\d+)\b|\b(\d+)\s*qty\b/i;

const TARGET_PATTERN = /\btarget[\s:-]*(\d+(?:\.\d+)?)/i;
const STOPLOSS_PATTERN = /\b(?:sl|stop\s*-?\s*loss)[\s:-]*(\d+(?:\.\d+)?)/i;

const EXIT_KEYWORDS = [/\bexit\b/i, /\bsell\b/i, /\bbook\b/i, /\bclose\b/i, /\bsquare\s*-?\s*off\b/i];
const BUY_KEYWORDS = [/\bentry\b/i, /\bbuy\b/i, /\bcmp\b/i];

function stripEmojis(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');
}

function matchInstrument(text: string): string | null {
  for (const { regex, name } of INSTRUMENT_PATTERNS) {
    if (regex.test(text)) return name;
  }
  return null;
}

function normalizeRight(raw: string): Right {
  const upper = raw.toUpperCase();
  return upper === 'PE' || upper === 'PUT' ? 'put' : 'call';
}

function matchStrikeAndRight(text: string): { strikePrice: string; right: Right } | null {
  const after = text.match(STRIKE_TYPE_AFTER);
  if (after) return { strikePrice: after[1], right: normalizeRight(after[2]) };

  const before = text.match(STRIKE_TYPE_BEFORE);
  if (before) return { strikePrice: before[2], right: normalizeRight(before[1]) };

  return null;
}

function matchPrice(text: string): string | null {
  const match = text.match(PRICE_PATTERN);
  return match ? match[1] : null;
}

function matchQuantity(text: string): number | undefined {
  const match = text.match(QUANTITY_PATTERN);
  if (!match) return undefined;
  return parseInt(match[1] ?? match[2], 10);
}

function matchTarget(text: string): string | undefined {
  const match = text.match(TARGET_PATTERN);
  return match ? match[1] : undefined;
}

function matchStoploss(text: string): string | undefined {
  const match = text.match(STOPLOSS_PATTERN);
  return match ? match[1] : undefined;
}

function matchAction(text: string): Action {
  if (EXIT_KEYWORDS.some((regex) => regex.test(text))) return 'exit';
  if (BUY_KEYWORDS.some((regex) => regex.test(text))) return 'buy';
  return 'buy';
}

export function parseMessage(sender: string, message: string): TradeMessage | null {
  const text = stripEmojis(message);

  if (/trade\s+update/i.test(text)) return null;

  const index = matchInstrument(text);
  if (!index) return null;

  const strikeAndRight = matchStrikeAndRight(text);
  if (!strikeAndRight) return null;

  const price = matchPrice(text);
  if (!price) return null;

  const action = matchAction(text);
  const quantity = matchQuantity(text);
  const target = matchTarget(text);
  const stoploss = matchStoploss(text);

  return {
    sender,
    message,
    index,
    right: strikeAndRight.right,
    strikePrice: strikeAndRight.strikePrice,
    price,
    action,
    ...(quantity !== undefined ? { quantity } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(stoploss !== undefined ? { stoploss } : {}),
    timestamp: new Date(),
  };
}
