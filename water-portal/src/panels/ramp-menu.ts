/*
 * The colour ramp of a map legend as a menu (title-menu.ts): how much of the values the
 * colours span, all of them or without 1% or 5% at either end, so a few extreme ones
 * don't wash out the rest. The WaPOR legend's (of the values in view; for a variable
 * WaPOR publishes, also WaPOR's own range), the Basin and Country legends' (of the
 * basins' or countries' values). Expects this markup (see
 * index.html):
 *
 *   <button class="legend-ramp ramp-menu" aria-haspopup="listbox" aria-expanded="false">
 *     <span class="title-menu-label" hidden></span>
 *   </button>
 *
 * Also the legends' tick labels (fmtStop).
 */
import type { WaporStretch } from "../map/layers/wapor-variables";
import { compactNumber, fmtNumber } from "../lib/format";
import { initTitleMenu } from "./title-menu";

/** The menu's settings, as a % cut at either end. */
const STRETCHES: WaporStretch[] = [0, 1, 5];
/** What starts out picked. */
export const DEFAULT_STRETCH: WaporStretch = 1;

/** A stretch, or "wapor": WaPOR's own range for the variable (its default style's). */
export type RampChoice = WaporStretch | "wapor";

/** "Colours span 1–99% of the values in view". */
const stretchLabel = (cut: RampChoice, of: string) =>
  cut === "wapor"
    ? "Colours span WaPOR's default range"
    : cut === 0
      ? `Colours span all ${of}`
      : `Colours span ${cut}–${100 - cut}% of ${of}`;

/** A legend stop, with as many decimals as the range needs; large ones as "3.6M". */
export function fmtStop(v: number, span: number) {
  if (Math.abs(v) >= 1e5 || span >= 1e5) return compactNumber.format(v);
  const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
  return fmtNumber(v, decimals);
}

export interface RampMenu {
  /** Whether there's a choice (not for a map with a fixed range): else a plain ramp. */
  setEnabled(enabled: boolean): void;
  /** Show this as picked (without onPick). */
  set(choice: RampChoice): void;
}

/**
 * `of`: what the colours span, "the values in view". `onPick` runs when another is
 * picked. `wapor`: whether WaPOR's own range is offered too (asked each time the menu
 * opens; none if not given).
 */
export function initRampMenu<T extends RampChoice>(
  button: HTMLButtonElement,
  of: string,
  initial: T,
  onPick: (cut: T) => void,
  wapor: () => boolean = () => false,
): RampMenu {
  let stretch: RampChoice = initial;
  let enabled = true;
  initTitleMenu(
    button,
    () => {
      const choices: RampChoice[] = [...STRETCHES, ...(wapor() ? (["wapor"] as const) : [])];
      return { options: enabled ? choices.map((cut) => ({ id: String(cut), label: stretchLabel(cut, of) })) : [], current: String(stretch) };
    },
    (id) => {
      if (id === String(stretch)) return;
      stretch = id === "wapor" ? "wapor" : (Number(id) as WaporStretch);
      show();
      onPick(stretch as T);
    },
  );
  function show() {
    button.disabled = !enabled;
    button.title = enabled ? `${stretchLabel(stretch, of)}. Click to change.` : "";
  }
  show();
  return {
    setEnabled(on) {
      enabled = on;
      show();
    },
    set(choice) {
      stretch = choice;
      show();
    },
  };
}
