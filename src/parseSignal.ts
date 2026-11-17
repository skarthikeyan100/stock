import { type ClaudeRunner, parseWithClaude } from './claudeParser.js';
import { parseMessage } from './parser.js';
import type { Signal } from './types.js';

export type ParseResult = { signal: Signal; via: 'regex' | 'claude' } | { signal: null; reason: string };

const OTHER_INSTRUMENT = /\b(BANKNIFTY|BNF|FINNIFTY|FNF|SENSEX)\b/i;
const NIFTY_WORD = /\b(NIFTY|NF)\b/i;
const OPTION_TOKEN = /\b(CE|PE|CALL|PUT)\b/i;

function looksLikeSignal(text: string): boolean {
  return OPTION_TOKEN.test(text) && /\d/.test(text);
}

export async function parseSignal(text: string, run: ClaudeRunner): Promise<ParseResult> {
  const trade = parseMessage('', text);

  if ((trade && trade.index !== 'NIFTY') || (OTHER_INSTRUMENT.test(text) && !NIFTY_WORD.test(text))) {
    return { signal: null, reason: 'not NIFTY' };
  }
  if (trade?.action === 'exit') return { signal: null, reason: 'exit messages are not handled' };

  if (trade && trade.stoploss !== undefined && trade.target !== undefined) {
    return {
      via: 'regex',
      signal: {
        action: 'buy',
        right: trade.right === 'put' ? 'PE' : 'CE',
        strike: Number(trade.strikePrice),
        price: Number(trade.price),
        stop: Number(trade.stoploss),
        target: Number(trade.target),
      },
    };
  }

  if (!looksLikeSignal(text)) return { signal: null, reason: 'not a signal' };

  try {
    const signal = await parseWithClaude(text, run);
    return signal ? { signal, via: 'claude' } : { signal: null, reason: 'claude: not a NIFTY buy call' };
  } catch (error) {
    return { signal: null, reason: `claude failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
