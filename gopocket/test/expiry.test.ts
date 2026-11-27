import { describe, expect, it } from 'vitest';
import { findExpiry, nearestExpiry, parseExpiryLabel } from '../src/expiry.js';

const labels = ['NIFTY 17th NOV 25400 CE', 'NIFTY 23rd NOV 25400 CE', 'NIFTY 1st DEC 25400 CE', 'NIFTY 25th JAN27 25400 CE'];

describe('parseExpiryLabel', () => {
  it('reads day and month with the next occurrence of the year', () => {
    expect(parseExpiryLabel('NIFTY 23rd NOV 25400 CE', '2026-11-17')).toBe('2026-11-23');
  });
  it('reads a two-digit year', () => {
    expect(parseExpiryLabel('NIFTY 25th JAN27 25400 CE', '2026-11-17')).toBe('2027-01-25');
  });
  it('returns null for an unparseable label', () => {
    expect(parseExpiryLabel('garbage', '2026-11-17')).toBeNull();
  });
});

describe('nearestExpiry / findExpiry', () => {
  it('counts today as the nearest expiry', () => {
    expect(nearestExpiry(labels, '2026-11-17')?.label).toBe(labels[0]);
  });
  it('skips past expiries', () => {
    expect(nearestExpiry(labels, '2026-11-18')?.label).toBe(labels[1]);
  });
  it('finds a stated date', () => {
    expect(findExpiry(labels, '2026-12-01', '2026-11-17')?.label).toBe(labels[2]);
  });
  it('returns null when the date is not listed', () => {
    expect(findExpiry(labels, '2026-12-02', '2026-11-17')).toBeNull();
  });
});

import { chooseExpiry } from '../src/expiry.js';
describe('chooseExpiry', () => {
  const today = '2026-11-17';
  it('picks the nearest expiry of the stated month, not the nearest overall', () => {
    expect(chooseExpiry(labels, { expiryMonth: 'DEC' }, today)?.label).toBe(labels[2]);
    expect(chooseExpiry(labels, { expiryMonth: 'JAN' }, today)?.label).toBe(labels[3]);
  });
  it('picks the nearest listed expiry inside the month (today counts)', () => {
    expect(chooseExpiry(labels, { expiryMonth: 'NOV' }, today)?.label).toBe(labels[0]);
    expect(chooseExpiry(labels, { expiryMonth: 'NOV' }, '2026-11-18')?.label).toBe(labels[1]);
  });
  it('never falls back to another month when the stated month is not listed', () => {
    expect(chooseExpiry(labels, { expiryMonth: 'FEB' }, today)).toBeNull();
    // the site lists only upcoming expiries: on 24 Nov no NOV row exists any more
    expect(chooseExpiry(labels.slice(2), { expiryMonth: 'NOV' }, '2026-11-24')).toBeNull();
  });
  it('a stated date wins over a stated month', () => {
    expect(chooseExpiry(labels, { expiry: '2026-12-01', expiryMonth: 'NOV' }, today)?.label).toBe(labels[2]);
  });
  it('with neither, takes the nearest', () => {
    expect(chooseExpiry(labels, {}, today)?.label).toBe(labels[0]);
  });
});
