// Minimal Mongo filter matcher for the in-memory fake databases of the tests: equality, $in/$nin (null matches a missing field, a RegExp matches
// a string), $exists, $ne, $gte/$lt on dates/numbers, and $or / $and.
export function matches(d: any, f: any): boolean {
    return Object.keys(f ?? {}).every((k) => {
        if (k === '$or') return (f.$or as any[]).some((x) => matches(d, x));
        if (k === '$and') return (f.$and as any[]).every((x) => matches(d, x));
        const c = f[k], v = d[k];
        const eq = (a: any, b: any) => (b instanceof RegExp ? typeof a === 'string' && b.test(a) : b == null ? a == null : a === b);
        if (c && typeof c === 'object' && !(c instanceof RegExp) && !(c instanceof Date) && Object.keys(c).some((x) => x.startsWith('$'))) {
            if ('$in' in c && !c.$in.some((x: any) => eq(v, x))) return false;
            if ('$nin' in c && c.$nin.some((x: any) => eq(v, x))) return false;
            if ('$exists' in c && (v !== undefined) !== !!c.$exists) return false;
            if ('$ne' in c && eq(v, c.$ne)) return false;
            if ('$gte' in c && !(v >= c.$gte)) return false;
            if ('$lt' in c && !(v < c.$lt)) return false;
            return true;
        }
        return eq(v, c);
    });
}
