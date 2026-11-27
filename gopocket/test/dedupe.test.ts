import { describe, expect, it } from 'vitest';
import { createDeduper } from '../src/dedupe.js';

describe('createDeduper', () => {
  it('flags a repeat within the window and releases it after', () => {
    let t = 1000;
    const d = createDeduper(5000, () => t);
    expect(d.isDuplicate('a')).toBe(false);
    expect(d.isDuplicate('a')).toBe(true);
    t += 5001;
    expect(d.isDuplicate('a')).toBe(false);
  });
  it('keeps keys independent', () => {
    const d = createDeduper(5000, () => 0);
    expect(d.isDuplicate('a')).toBe(false);
    expect(d.isDuplicate('b')).toBe(false);
  });
});
