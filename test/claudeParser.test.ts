import { describe, expect, it } from 'vitest';
import { ClaudeParseError, parseWithClaude } from '../src/claudeParser.js';

const SAMPLE = 'BUY NIFRY (25400.00 CE) CMP 54:)) STOPLLOSS 41:00 TARGET 68:00-80:00-100:00++(LOT SIZE 65)';
const cli = (structured: unknown) => async () => JSON.stringify({ is_error: false, structured_output: structured });

describe('parseWithClaude', () => {
  it('maps the sample message to a Signal using the first target', async () => {
    const run = cli({ relevant: true, instrument: 'NIFTY', action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, targets: [68, 80, 100] });
    expect(await parseWithClaude(SAMPLE, run)).toEqual({ action: 'buy', right: 'CE', strike: 25400, price: 54, stop: 41, target: 68 });
  });

  it('keeps a stated expiry date', async () => {
    const run = cli({ relevant: true, instrument: 'NIFTY', action: 'buy', right: 'PE', strike: 25300, price: 80, expiry: '2026-12-01' });
    expect((await parseWithClaude('x', run))?.expiry).toBe('2026-12-01');
  });

  it('returns null when Claude says the message is not relevant', async () => {
    expect(await parseWithClaude('hello', cli({ relevant: false }))).toBeNull();
  });

  it('returns null for another instrument', async () => {
    const run = cli({ relevant: true, instrument: 'BANKNIFTY', action: 'buy', right: 'CE', strike: 62000, price: 100 });
    expect(await parseWithClaude('x', run)).toBeNull();
  });

  it('returns null for an exit', async () => {
    const run = cli({ relevant: true, instrument: 'NIFTY', action: 'exit', right: 'CE', strike: 25400, price: 70 });
    expect(await parseWithClaude('x', run)).toBeNull();
  });

  it('returns null when strike, right or price is missing', async () => {
    expect(await parseWithClaude('x', cli({ relevant: true, instrument: 'NIFTY', action: 'buy', right: 'CE', price: 54 }))).toBeNull();
  });

  it('throws ClaudeParseError for non-JSON output', async () => {
    await expect(parseWithClaude('x', async () => 'not json')).rejects.toBeInstanceOf(ClaudeParseError);
  });

  it('throws ClaudeParseError when structured_output is absent', async () => {
    await expect(parseWithClaude('x', async () => JSON.stringify({ result: 'hi' }))).rejects.toBeInstanceOf(ClaudeParseError);
  });

  it('propagates a runner failure such as a timeout', async () => {
    await expect(parseWithClaude('x', async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
  });
});
