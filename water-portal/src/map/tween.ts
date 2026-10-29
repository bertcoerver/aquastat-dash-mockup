/*
 * Changes on the map eased in, rather than jumping (mostly for playing a range: the
 * Country and Basin views' maps change at every step).
 *
 * The circles, bars and scheme lines are eased item by item, paired by a key
 * of each (its area, say): they're sorted by size, so a step reorders them, and
 * deck.gl's own transitions, which pair values by index, would slide them from one
 * place to another (createTween).
 *
 * The areas' fills fade: the layer is drawn twice, the new fills over the last, coming
 * in by its opacity (createFade). Not deck.gl's transitions: for polygons, those read
 * the colours back from the GPU at every change, which stalls each step.
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

/** One of a fading layer's two copies: its fills, how opaque it is, and whether it's drawn. */
export interface Copy<F> {
  slot: 0 | 1;
  fills: F;
  opacity: number;
  visible: boolean;
}

export interface Fade<F> {
  /** The fills to show: a change fades in over the last (with no timing: at once). */
  to(fills: F, timing: Timing | null): void;
  /** The copies to draw, bottom to top. Both always (hidden, the one under keeps its tiles). */
  copies(): Copy<F>[];
}

/**
 * Fills (anything with a `key` naming them, or undefined) faded in over the last. Each
 * copy keeps its fills until it's the one to fade in again, so deck.gl only recomputes
 * a copy's colours once per change; while fading, only the top one's opacity changes.
 * A change while fading puts the new fills over the last ones as set, not as blended.
 */
export function createFade<F extends { key: unknown } | undefined>(onFrame: () => void): Fade<F> {
  const fills = [undefined, undefined] as [F, F];
  let top: 0 | 1 = 0;
  let t = 1; // the top copy's opacity
  let cancel = () => {};

  return {
    to(next, timing) {
      if (next?.key === fills[top]?.key) return;
      cancel();
      if (!timing?.duration) {
        fills[top] = next;
        t = 1;
        return;
      }
      top = top ? 0 : 1;
      fills[top] = next;
      t = 0;
      cancel = animate(timing, (e) => {
        t = e;
        onFrame();
      });
    },
    copies() {
      const under = top ? 0 : 1;
      return [
        { slot: under, fills: fills[under], opacity: 1, visible: t < 1 },
        { slot: top, fills: fills[top], opacity: t, visible: true },
      ];
    },
  };
}

/** Runs `onStep` at every frame with the eased time, 0 to 1 (1 last); returns a cancel. */
export function animate({ duration, easing }: Timing, onStep: (t: number) => void): () => void {
  let raf = 0;
  const start = performance.now();
  const step = () => {
    const p = Math.min(1, (performance.now() - start) / duration);
    if (p < 1) raf = requestAnimationFrame(step);
    onStep(easing(p));
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
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
    else if (isNumbers(x) && isNumbers(y) && x.length === y.length) {
      // (Into the array of the last frame, once there is one of its own: not a new one
      // per colour per item per frame.)
      const was = o[k];
      const out = Array.isArray(was) && was !== x && was !== y ? (was as number[]) : new Array<number>(y.length);
      for (let i = 0; i < y.length; i++) out[i] = x[i] + (y[i] - x[i]) * t;
      o[k] = out;
    } else o[k] = y;
  }
}

const isNumbers = (v: unknown): v is number[] => Array.isArray(v) && typeof v[0] === "number";
