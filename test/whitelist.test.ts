import { describe, expect, it } from 'vitest';
import { isAllowedSender } from '../src/whitelist.js';

const allowedSenders = ['John Trader', '+91 98765 43210', 'Trading Signals'];

describe('isAllowedSender', () => {
  it('matches a sender by display name (case-insensitive)', () => {
    expect(isAllowedSender(['919876543210@c.us', 'john trader', undefined], allowedSenders)).toBe(true);
  });

  it('matches a phone number JID regardless of "+" or spacing in the whitelist', () => {
    expect(isAllowedSender(['919876543210@c.us', undefined, undefined], allowedSenders)).toBe(true);
  });

  it('matches a group by chat name', () => {
    expect(isAllowedSender(['123456-7890@g.us', null, 'Trading Signals'], allowedSenders)).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(isAllowedSender(['911111111111@c.us', 'Random Person', undefined], allowedSenders)).toBe(false);
  });
});
