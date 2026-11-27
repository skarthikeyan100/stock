export function createDeduper(windowMs: number, now: () => number = Date.now): { isDuplicate(key: string): boolean } {
  const seenAt = new Map<string, number>();
  return {
    isDuplicate(key: string): boolean {
      const t = now();
      const prev = seenAt.get(key);
      if (prev !== undefined && t - prev <= windowMs) return true;
      seenAt.set(key, t);
      return false;
    },
  };
}
