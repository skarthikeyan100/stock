import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/parser.js';

describe('parseMessage', () => {
  it('parses "Nifty 23400 ce Cmp 120"', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('buy');
    expect(result?.price).toBe('120');
    expect(result?.index).toBe('NIFTY');
    expect(result?.right).toBe('call');
    expect(result?.strikePrice).toBe('23400');
  });

  it('parses "Script: NIFTY 16th JUN 23350 PE\\nEntry Price: 138"', () => {
    const result = parseMessage('John Trader', 'Script: NIFTY 16th JUN 23350 PE\nEntry Price: 138');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('buy');
    expect(result?.price).toBe('138');
    expect(result?.index).toBe('NIFTY');
    expect(result?.right).toBe('put');
    expect(result?.strikePrice).toBe('23350');
  });

  it('parses "Exit Banknifty 45000 CE @ 180"', () => {
    const result = parseMessage('John Trader', 'Exit Banknifty 45000 CE @ 180');
    expect(result).not.toBeNull();
    expect(result?.action).toBe('exit');
    expect(result?.price).toBe('180');
    expect(result?.index).toBe('BANKNIFTY');
    expect(result?.right).toBe('call');
    expect(result?.strikePrice).toBe('45000');
  });

  it('handles case-insensitivity and colon separators', () => {
    const result = parseMessage('John Trader', 'nifty:23400:ce:cmp:120');
    expect(result).not.toBeNull();
    expect(result?.index).toBe('NIFTY');
    expect(result?.price).toBe('120');
  });

  it('handles instrument abbreviations (NF, BNF)', () => {
    const nf = parseMessage('John Trader', 'NF 23400 CE Cmp 120');
    expect(nf?.index).toBe('NIFTY');

    const bnf = parseMessage('John Trader', 'BNF 45000 PE Cmp 180');
    expect(bnf?.index).toBe('BANKNIFTY');
  });

  it('resolves an exit keyword that overlaps with buy keywords ("book")', () => {
    const result = parseMessage('John Trader', 'Book profit Nifty 23400 CE @ 150');
    expect(result?.action).toBe('exit');
  });

  it('returns null for messages with no recognizable instrument', () => {
    expect(parseMessage('John Trader', 'Hello, how are you?')).toBeNull();
  });

  it('returns null when option type cannot be determined', () => {
    expect(parseMessage('John Trader', 'Nifty 23400 Cmp 120')).toBeNull();
  });

  it('returns null when price cannot be determined', () => {
    expect(parseMessage('John Trader', 'Nifty 23400 CE')).toBeNull();
  });

  it('leaves quantity undefined when not mentioned', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120');
    expect(result?.quantity).toBeUndefined();
  });

  it('parses an explicit quantity override ("200 qty")', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120, 200 qty');
    expect(result?.quantity).toBe(200);
  });

  it('parses an explicit quantity override ("qty: 200")', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120, qty: 200');
    expect(result?.quantity).toBe(200);
  });

  it('recognizes SENSEX as an instrument', () => {
    const result = parseMessage('John Trader', 'Sensex 75000 ce Cmp 120');
    expect(result?.index).toBe('SENSEX');
  });

  it('parses stop-loss and the first of multiple targets', () => {
    const result = parseMessage('John Trader', 'Sensex 76900 ce\nCmp 260\nSl 160\nTarget 360,380,410++');
    expect(result?.target).toBe('360');
    expect(result?.stoploss).toBe('160');
  });

  it('parses "Stop Loss" written as two words', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120 Stop Loss 100 Target 150');
    expect(result?.stoploss).toBe('100');
    expect(result?.target).toBe('150');
  });

  it('leaves target and stoploss undefined when not mentioned', () => {
    const result = parseMessage('John Trader', 'Nifty 23400 ce Cmp 120');
    expect(result?.target).toBeUndefined();
    expect(result?.stoploss).toBeUndefined();
  });
});
