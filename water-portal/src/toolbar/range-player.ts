/*
 * Playback in the Country and Basin views: the range moves on a step at a time (a year
 * in Country, a dekad in Basin; see stepRange), keeping its length, and stops at the
 * view's last one. Played from there, it starts over from the first. Their data is
 * small and comes in whole, so unlike the Local view's (wapor-player.ts) nothing is
 * loaded ahead: a frame just sets the range.
 */
import type { PlaybackStatus } from "../map/wapor-player";
import { firstRange, stepRange, type DayRange, type View } from "./range-rules";

/** How long each frame shows: years are few, dekads many. */
const FRAME_MS: Record<Exclude<View, "local">, number> = { country: 800, basin: 300 };

export interface RangePlayer {
  toggle(): void;
  stop(): void;
}

/**
 * `getView` and `getRange` are what the toolbar shows; `show` sets a frame's range on
 * it; `onState` follows the play button (with how long a step shows, while playing).
 */
export function initRangePlayer({
  getView,
  getRange,
  show,
  onState,
}: {
  getView: () => View;
  getRange: () => DayRange;
  show: (range: DayRange) => void;
  onState: (status: PlaybackStatus, stepMs: number | null) => void;
}): RangePlayer {
  let timer = 0;

  function play() {
    const view = getView();
    if (view === "local") return;
    onState("playing", FRAME_MS[view]);
    if (!stepRange(view, getRange())) show(firstRange(view, getRange()));
    timer = window.setInterval(() => {
      const next = stepRange(view, getRange());
      if (next) show(next);
      if (!next || !stepRange(view, next)) stop();
    }, FRAME_MS[view]);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
    onState("stopped", null);
  }

  return {
    toggle: () => (timer ? stop() : play()),
    stop,
  };
}
