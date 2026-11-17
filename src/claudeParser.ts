import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Signal } from './types.js';

export type ClaudeRunner = (prompt: string) => Promise<string>;

export class ClaudeParseError extends Error {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// GOPOCKET_LOG_DIR lets the tests write somewhere other than the real logs/ folder.
const LOG_DIR = process.env.GOPOCKET_LOG_DIR ?? path.join(__dirname, '..', 'logs');
const PARSE_LOG = path.join(LOG_DIR, 'claude-parse.log');

const SCHEMA = {
  type: 'object',
  properties: {
    relevant: { type: 'boolean' },
    instrument: { type: 'string' },
    action: { type: 'string', enum: ['buy', 'exit'] },
    right: { type: 'string', enum: ['CE', 'PE'] },
    strike: { type: 'number' },
    expiry: { type: 'string' },
    price: { type: 'number' },
    stop: { type: 'number' },
    targets: { type: 'array', items: { type: 'number' } },
  },
  required: ['relevant'],
};

const INSTRUCTIONS = `You extract a trading call from a WhatsApp message. Reply only through the JSON schema.
- relevant is true only for a call to BUY or EXIT an option (index or stock) with a strike and CE/PE. Cash or equity buys, greetings, results, charts and chatter are not relevant.
- instrument is the underlying symbol as the exchange spells it (NIFTY, BANKNIFTY, PAYTM, HAL ...); fix obvious typos (NIFRY -> NIFTY).
- right is CE or PE. strike is the strike price as a number (25400.00 -> 25400).
- price is the entry price (CMP / entry / @). stop is the stop loss price. targets lists every target price in order.
- Prices written like 41:00 mean 41.00. Ignore emoji and symbols.
- Ignore any lot size or quantity written in the message.
- expiry only if the message clearly states the option's expiry date, as YYYY-MM-DD. A line like "DATE: 12-11-2026" is the date of the call, not an expiry; a bare month such as NOV is not a date. When unsure, leave expiry out. Never invent a field the message does not contain.

Message:
`;

export function defaultRunner(model?: string): ClaudeRunner {
  return (prompt: string) =>
    new Promise<string>((resolve, reject) => {
      const args = ['-p', prompt, '--output-format', 'json', '--no-session-persistence', '--tools', '', '--setting-sources', '', '--json-schema', JSON.stringify(SCHEMA)];
      if (model) args.push('--model', model);
      execFile('claude', args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
}

function log(input: string, output: string, ms: number): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(PARSE_LOG, JSON.stringify({ at: new Date().toISOString(), input, output, ms }) + '\n');
  } catch {
    // logging must never break parsing
  }
}

export async function parseWithClaude(text: string, run: ClaudeRunner): Promise<Signal | null> {
  const started = Date.now();
  const stdout = await run(INSTRUCTIONS + text);
  log(text, stdout, Date.now() - started);

  let structured: Record<string, unknown> | undefined;
  try {
    structured = (JSON.parse(stdout) as { structured_output?: Record<string, unknown> }).structured_output;
  } catch {
    throw new ClaudeParseError('claude output was not JSON');
  }
  if (!structured || typeof structured !== 'object') throw new ClaudeParseError('claude output had no structured_output');

  if (structured.relevant !== true) return null;
  const underlying = String(structured.instrument ?? '').trim().toUpperCase();
  if (!underlying) return null;
  if (structured.action !== 'buy') return null;
  const { right, strike, price } = structured;
  if ((right !== 'CE' && right !== 'PE') || typeof strike !== 'number' || typeof price !== 'number') return null;

  const targets = Array.isArray(structured.targets) ? (structured.targets as unknown[]).filter((t): t is number => typeof t === 'number') : [];
  return {
    action: 'buy',
    underlying,
    right,
    strike,
    price,
    ...(typeof structured.stop === 'number' ? { stop: structured.stop } : {}),
    ...(targets.length > 0 ? { target: targets[0] } : {}),
    ...(typeof structured.expiry === 'string' ? { expiry: structured.expiry } : {}),
  };
}
