/*
 * The colour ramp of a map legend as a menu (title-menu.ts): how much of the values the
 * colours span, all of them or without 1% or 5% at either end, so a few extreme ones
 * don't wash out the rest. The WaPOR legend's (of the values in view), the Basin and
 * Country legends' (of the basins' or countries' values). Expects this markup (see
 * index.html):
 *
 *   <button class="legend-ramp ramp-menu" aria-haspopup="listbox" aria-expanded="false">
 *     <span class="title-menu-label" hidden></span>
 *   </button>
 *
 * Also the legends' tick labels (fmtStop).
 */
import type { WaporStretch } from "../map/layers/wapor";
import { initTitleMenu } from "./title-menu";

/** The menu's settings, as a % cut at either end. */
export const STRETCHES: WaporStretch[] = [0, 1, 5];
/** What starts out picked. */
export const DEFAULT_STRETCH: WaporStretch = 1;

/** "Colours span 1–99% of the values in view". */
export const stretchLabel = (cut: WaporStretch, of: string) =>
  cut === 0 ? `Colours span all ${of}` : `Colours span ${cut}–${100 - cut}% of ${of}`;

/** A legend stop, with as many decimals as the range needs; large ones as "3.6M". */
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 3 });
export function fmtStop(v: number, span: number) {
  if (Math.abs(v) >= 1e5 || span >= 1e5) return compact.format(v);
  const decimals = span >= 10 ? 0 : span >= 1 ? 1 : span >= 0.1 ? 2 : 3;
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export interface RampMenu {
  /** Whether there's a choice (not for a map with a fixed range): else a plain ramp. */
  setEnabled(enabled: boolean): void;
}

/** `of`: what the colours span, "the values in view". `onPick` runs when another is picked. */
export function initRampMenu(button: HTMLButtonElement, of: string, initial: WaporStretch, onPick: (cut: WaporStretch) => void): RampMenu {
  let stretch = initial;
  let enabled = true;
  initTitleMenu(
    button,
    () => ({ options: enabled ? STRETCHES.map((cut) => ({ id: String(cut), label: stretchLabel(cut, of) })) : [], current: String(stretch) }),
    (id) => {
      if (Number(id) === stretch) return;
      stretch = Number(id) as WaporStretch;
      show();
      onPick(stretch);
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
  };
}
