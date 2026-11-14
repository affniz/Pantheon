/**
 * Parse a numeric query parameter, falling back to `dflt` for missing or
 * non-numeric input and clamping to [min, max]. Without this, `?limit=abc`
 * reached the database as NaN and `?limit=1e9` as an unbounded scan.
 */
export function intParam(raw: string | undefined, dflt: number, min: number, max: number): number {
    const n = Math.trunc(Number(raw));
    if (raw === undefined || raw.trim() === "" || !Number.isFinite(n)) return dflt;
    return Math.min(Math.max(n, min), max);
}
