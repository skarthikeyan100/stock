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
