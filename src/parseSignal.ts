import { type ClaudeRunner, parseWithClaude } from './claudeParser.js';
import type { Signal } from './types.js';

export type ParseResult = { signal: Signal; via: 'claude' } | { signal: null; reason: string };

/** Repeats ("Again ...") and cash/equity posts are never traded. Whole words only: "cashew" still goes to Claude. */
const SKIP = /\b(again|cash)\b/i;

/** CE or PE as its own token. "25400CE" counts, "PRICE" and "PEAK" do not. */
const HAS_CE_PE = /(?<![A-Za-z])(CE|PE)(?![A-Za-z])/i;

export async function parseSignal(text: string, run: ClaudeRunner): Promise<ParseResult> {
  if (SKIP.test(text)) return { signal: null, reason: 'ignored: contains "again" or "cash"' };
  if (!HAS_CE_PE.test(text)) return { signal: null, reason: 'ignored: no CE or PE in the message' };
  try {
    const signal = await parseWithClaude(text, run);
    return signal ? { signal, via: 'claude' } : { signal: null, reason: 'claude: not a buy call on an option' };
  } catch (error) {
    return { signal: null, reason: `claude failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
