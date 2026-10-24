/*
 * Playback in the Local view: the range moves forward one step at a time, keeping its
 * length, and the map shows WaPOR for each. The step is the range's own unit: a year
 * for whole calendar years, a month for whole months, else a dekad.
 *
 * Each frame is loaded ahead: its rasters checked and opened, and the tiles the map
 * shows fetched into the tile cache (see bufferWapor), up to AHEAD frames, LOADERS at
 * a time. Playback
 * starts, and after a stall goes on, once a few frames are in. Moving the map changes
 * the tiles, so the frames ahead are loaded again for the new view.
 */
import { MAX_DK } from "../toolbar/dekads";
import type { DekadRange } from "../toolbar/range-rules";
import { bufferWapor, checkedWaporPeriod, onWaporView, waporBuffered, type CheckedWaporPeriod } from "./layers/wapor";

const FRAME_MS = 700;
const AHEAD = 12; // frames loaded ahead
const LOADERS = 3; // frames loading at once
const START_AHEAD = 3; // frames in before playing (or all that are left)

export type PlaybackStatus = "stopped" | "buffering" | "playing";

export interface PlaybackState {
  status: PlaybackStatus;
  /** How far ahead frames are loaded: the dekad boundary after the last one (null: none). */
  bufferedTo: number | null;
}

interface Frame {
  range: DekadRange;
  checked?: CheckedWaporPeriod | null; // null: can't be shown
  buffered: boolean;
  loading?: boolean;
}

/** The step to play a range with, in dekads. */
function stepOf({ start, end }: DekadRange) {
  const len = end - start + 1;
  if (start % 36 === 0 && len % 36 === 0) return 36;
  if (start % 3 === 0 && len % 3 === 0) return 3;
  return 1;
}

export interface WaporPlayer {
  /** Play from the current range (from the first one if it's the last), or stop. */
  toggle(): void;
  stop(): void;
}

/**
 * `getRange` is the range shown when play is pressed; `show` shows a frame (the range
 * on the toolbar and the period on the map); `onState` follows the play button and
 * the buffered part of the slider.
 */
export function initWaporPlayer({
  getRange,
  show,
  onState,
}: {
  getRange: () => DekadRange;
  show: (range: DekadRange, checked: CheckedWaporPeriod) => void;
  onState: (state: PlaybackState) => void;
}): WaporPlayer {
  let run: {
    frames: Frame[]; // from the next one to show
    last: DekadRange; // of the frames made so far
    end: number; // frames that can be shown (Infinity: not known yet)
    step: number;
    first: DekadRange; // of all, at the same length
    shown: number;
    rewound: boolean;
    status: PlaybackStatus;
    abort: AbortController; // the loading, for the current view
    waiting: (() => void)[]; // loaders with nothing to do, far enough ahead
    timer: number;
  } | null = null;

  function report() {
    if (!run) return onState({ status: "stopped", bufferedTo: null });
    let last: Frame | null = null;
    for (const frame of run.frames.slice(0, run.end)) {
      if (!frame.buffered) break;
      last = frame;
    }
    onState({ status: run.status, bufferedTo: last && last.range.end + 1 });
  }

  /** Frame `i` ahead, made when first needed; null past the current dekad. */
  function frameAt(i: number): Frame | null {
    const current = run!;
    const { frames, step } = current;
    while (frames.length <= i) {
      const prev = current.last;
      if (prev.end + step > MAX_DK) return null;
      current.last = { start: prev.start + step, end: prev.end + step };
      frames.push({ range: current.last, buffered: false });
    }
    return frames[i];
  }

  /** Wake the loaders that are waiting. */
  const wake = (current: NonNullable<typeof run>) => current.waiting.splice(0).forEach((resolve) => resolve());

  /** Keep loading frames ahead, the first not loaded or loading first, until stopped. */
  async function load(current: NonNullable<typeof run>) {
    while (run === current) {
      const { signal } = current.abort;
      // The first frame ahead that isn't in yet.
      const until = Math.min(current.end, AHEAD);
      let i = 0;
      while (i < until && (current.frames[i]?.buffered || current.frames[i]?.loading)) i++;
      if (i === until) {
        await new Promise<void>((resolve) => current.waiting.push(resolve));
        continue;
      }
      const frame = frameAt(i);
      if (!frame) {
        current.end = i;
        advance();
        continue;
      }
      frame.loading = true;
      try {
        if (frame.checked === undefined) frame.checked = await checkedWaporPeriod(frame.range);
        // Not published (yet): playback ends before it.
        if (!frame.checked) {
          current.end = Math.min(current.end, current.frames.indexOf(frame));
        } else if (!waporBuffered(frame.checked.period)) {
          await bufferWapor(frame.checked.period, signal);
        }
        if (run !== current || signal.aborted) continue;
        frame.buffered = Boolean(frame.checked);
      } catch {
        if (signal.aborted) continue; // the view moved: start over for the new one
        current.end = Math.min(current.end, current.frames.indexOf(frame)); // can't reach the bucket
      } finally {
        frame.loading = false;
      }
      advance();
    }
  }

  /** Show the next frame if it's time and it's in; stop at the end. */
  function advance() {
    if (!run) return;
    const { frames, end } = run;
    if (end === 0) {
      // Nothing after the range when play was pressed: from the start.
      if (run.shown === 0 && !run.rewound) {
        Object.assign(run, { frames: [{ range: run.first, buffered: false }], last: run.first, end: Infinity, rewound: true });
        wake(run);
        return report();
      }
      return stop();
    }
    const ahead = Math.min(START_AHEAD, end);
    const ready = frames.slice(0, ahead).length === ahead && frames.slice(0, ahead).every((f) => f.buffered);
    if (run.status === "buffering" && ready) {
      run.status = "playing";
      tick();
    } else if (run.status === "playing" && !run.timer && !frames[0]?.buffered) {
      run.status = "buffering"; // stalled
    }
    report();
  }

  function tick() {
    const current = run;
    if (!current || current.status !== "playing") return;
    current.timer = 0;
    const [frame] = current.frames;
    if (!frame?.buffered) return advance();
    current.frames.shift();
    current.end--;
    current.shown++;
    show(frame.range, frame.checked!);
    wake(current);
    current.timer = window.setTimeout(tick, FRAME_MS);
    advance();
  }

  function play() {
    const range = getRange();
    const step = stepOf(range);
    const first = { start: range.start % step, end: (range.start % step) + range.end - range.start };
    // From the start if there's no next frame.
    const rewound = range.end + step > MAX_DK;
    const from = rewound ? first : { start: range.start + step, end: range.end + step };
    const current = {
      frames: [{ range: from, buffered: false }],
      last: from,
      end: Infinity,
      step,
      first,
      shown: 0,
      rewound,
      status: "buffering" as PlaybackStatus,
      abort: new AbortController(),
      waiting: [],
      timer: 0,
    };
    run = current;
    report();
    for (let i = 0; i < LOADERS; i++) load(current);
  }

  function stop() {
    if (!run) return;
    run.abort.abort();
    clearTimeout(run.timer);
    wake(run);
    run = null;
    report();
  }

  // The view moved: load the frames ahead again, for the tiles now in view.
  let viewTimer = 0;
  onWaporView(() => {
    if (!run) return;
    clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      if (!run) return;
      run.abort.abort();
      run.abort = new AbortController();
      for (const frame of run.frames) frame.buffered = false;
      wake(run);
      advance();
    }, 200);
  });

  return {
    toggle: () => (run ? stop() : play()),
    stop,
  };
}
