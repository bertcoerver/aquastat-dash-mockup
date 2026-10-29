/** `v` kept between `lo` and `hi`. */
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** `t` of the way from `a` to `b`. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
