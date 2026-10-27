/*
 * Changes on the map eased in, rather than jumping (mostly for playing a range: the
 * Country and Basin views' maps change at every step).
 *
 * The areas' fills use deck.gl's own transitions (`transitions` on the layer): they
 * pair the values by index, which is fine for them, as each tile's features keep their
 * order. The circles, bars and scheme lines and dots don't: they're sorted by size, so
 * a step reorders them, and deck.gl would slide them from one place to another. Those
 * are eased here instead, paired by a key of each (its area, say).
 */

export interface Timing {
  duration: number;
  easing: (t: number) => number;
}

export const linear = (t: number) => t;
export const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** A list as drawn: `key` changes at every frame of the easing (for updateTriggers). */
export interface Eased<T> {
  key: string;
  items: T[];
}

export interface Tween<T> {
  /** Eases from what's drawn now to `next`: what comes grows, what goes shrinks away (null: all of it, then nothing's drawn). */
  set(next: Eased<T> | null): void;
  /** What to draw (null: nothing). */
  get(): Eased<T> | null;
}

/**
 * `keyOf` pairs the items; `zero` is how one comes and goes (e.g. `{ radius: 0 }`: it
 * grows and shrinks). Numbers and lists of numbers (colours) are eased, all else is the
 * new item's. While easing, the list drawn is the same array, its items changed in
 * place, so deck.gl only recomputes the attributes the key triggers (not, say, paths).
 */
export function createTween<T extends object>({
  keyOf,
  zero,
  timing,
  onFrame,
}: {
  keyOf: (item: T) => unknown;
  zero: Partial<T>;
  timing: () => Timing;
  onFrame: () => void;
}): Tween<T> {
  let target: Eased<T> | null = null;
  let shown: T[] = [];
  let frame = 0;
  let raf = 0;

  return {
    set(next) {
      cancelAnimationFrame(raf);
      raf = 0;
      frame++;
      const before = new Map(shown.map((item) => [keyOf(item), item]));
      const { duration, easing } = timing();
      if (!duration || (!shown.length && !next?.items.length)) {
        target = next;
        shown = next?.items ?? [];
        return;
      }
      // (Going: still drawn until it has shrunk away.)
      target = next ?? (target && { key: `${target.key}:going`, items: [] });
      const kept = new Set(next?.items.map(keyOf));
      // Those going first (under the rest), shrinking away.
      const pairs: [T, T][] = [
        ...shown.filter((item) => !kept.has(keyOf(item))).map((item): [T, T] => [item, { ...item, ...zero }]),
        ...(next?.items ?? []).map((item): [T, T] => [before.get(keyOf(item)) ?? { ...item, ...zero }, item]),
      ];
      const eased = pairs.map(([from]) => ({ ...from }));
      shown = eased;
      const start = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / duration);
        frame++;
        if (t < 1) {
          const e = easing(t);
          pairs.forEach(([from, to], i) => mix(eased[i], from, to, e));
          raf = requestAnimationFrame(step);
        } else {
          target = next;
          shown = next?.items ?? [];
          raf = 0;
        }
        onFrame();
      };
      raf = requestAnimationFrame(step);
    },
    get: () => target && { key: `${target.key}:${frame}`, items: shown },
  };
}

function mix<T extends object>(out: T, from: T, to: T, t: number) {
  const o = out as Record<string, unknown>;
  const a = from as Record<string, unknown>;
  const b = to as Record<string, unknown>;
  for (const k in b) {
    const x = a[k];
    const y = b[k];
    if (x === y) o[k] = y;
    else if (typeof x === "number" && typeof y === "number") o[k] = x + (y - x) * t;
    else if (isNumbers(x) && isNumbers(y) && x.length === y.length) o[k] = y.map((v, i) => x[i] + (v - x[i]) * t);
    else o[k] = y;
  }
}

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && typeof v[0] === "number";
