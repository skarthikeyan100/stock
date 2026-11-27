import { type ClaudeRunner, parseWithClaude } from './claudeParser.js';
import type { Signal } from './types.js';

export type ParseResult = { signal: Signal; via: 'claude' } | { signal: null; reason: string };

/** Repeats ("Again ...") and cash/equity posts are never traded. Whole words only: "cashew" still goes to Claude. */
const SKIP = /\b(again|cash)\b/i;

/** Exception: a "Positional (AGAIN)" header line is a fresh positional call and is traded. */
const POSITIONAL_AGAIN_HEADER = /^[^\n]*\bpositional\s*\(\s*again\s*\)[^\n]*\n/i;

/** The only underlyings traded; every other index and every stock is ignored. */
const TRADED = new Set(['NIFTY', 'SENSEX', 'BANKNIFTY']);

/** CE or PE as its own token. "25400CE" counts, "PRICE" and "PEAK" do not. */
const HAS_CE_PE = /(?<![A-Za-z])(CE|PE)(?![A-Za-z])/i;

export async function parseSignal(text: string, run: ClaudeRunner): Promise<ParseResult> {
  if (SKIP.test(text.replace(POSITIONAL_AGAIN_HEADER, ''))) return { signal: null, reason: 'ignored: contains "again" or "cash"' };
  if (!HAS_CE_PE.test(text)) return { signal: null, reason: 'ignored: no CE or PE in the message' };
  try {
    const signal = await parseWithClaude(text, run);
    if (!signal) return { signal: null, reason: 'claude: not a buy call on an option' };
    if (!TRADED.has(signal.underlying)) return { signal: null, reason: `ignored: ${signal.underlying} is not NIFTY, SENSEX or BANKNIFTY` };
    return { signal, via: 'claude' };
  } catch (error) {
    return { signal: null, reason: `claude failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
