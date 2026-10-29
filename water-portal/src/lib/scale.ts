/*
 * Round numbers for chart axes: 1, 2, 5 or 10 times a power of ten.
 */

/** A round step that splits `span` into about `count` parts. */
export function niceStep(span: number, count: number) {
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
}

/** About `count` round ticks covering [lo, hi] (from the round number at or below lo to the one at or above hi). */
export function niceTicks(lo: number, hi: number, count: number) {
  const step = niceStep(hi - lo || 1, count);
  const ticks = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) ticks.push(Math.round(v / step) * step);
  if (ticks.length < 2) ticks.push(ticks[0] + step);
  return ticks;
}

/** About `count` round ticks within [lo, hi]. */
export function ticksWithin(lo: number, hi: number, count: number) {
  const step = niceStep(hi - lo, count);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

/** [lo, hi] widened to round numbers (a point: one either side). */
export function niceExtent([lo, hi]: [number, number]): [number, number] {
  if (hi === lo) return [lo - 1, hi + 1];
  const step = niceStep(hi - lo, 4);
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

/** A round top for an axis from 0 to `v`, and its tick step (about three ticks). */
export function niceMax(v: number): [number, number] {
  const step = niceStep(v, 3);
  return [Math.ceil(v / step) * step, step];
}
