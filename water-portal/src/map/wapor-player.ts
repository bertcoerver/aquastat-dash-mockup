/*
 * Playback in the Local view: the range moves forward a step at a time (a day),
 * keeping its length, and the map shows WaPOR for each. Steps shorter than a dekad
 * mostly weigh the same rasters differently, so their tiles are cached already:
 * only a frame that reaches a new dekad loads more.
 *
 * Each frame is loaded ahead: its rasters checked and opened, and the tiles the map
 * shows fetched into the tile cache (see bufferWapor), up to `ahead` frames, `loaders`
 * at a time. Playback starts, and after a stall goes on, once a few frames are in.
 * Moving the map changes the tiles, so the frames ahead are loaded again for the new view.
 * With few frames in ahead (the next dekad's rasters still loading, say), each shows
 * longer: playback slows down rather than stopping and starting again.
 */
import { MAX_DAY } from "../toolbar/dekads";
import type { DayRange } from "../toolbar/range-rules";
import type { WaporVariable } from "./layers/wapor-variables";
import { bufferWapor, checkedWaporPeriod, onWaporView, waporBuffered, type CheckedWaporPeriod } from "./layers/wapor";

export interface PlaybackSettings {
  stepDays: number; // how far each frame moves the range
  frameMs: number; // how long each frame shows
  ahead: number; // frames loaded ahead
  loaders: number; // frames loading at once
  startAhead: number; // frames in before playing (or all that are left)
}

const DEFAULT_PLAYBACK: PlaybackSettings = { stepDays: 1, frameMs: 200, ahead: 30, loaders: 3, startAhead: 3 };

/** Fewer frames in ahead than this: each shows longer, up to SLOWEST times as long with none. */
const SLOW_BELOW = 10;
const SLOWEST = 3;

export type PlaybackStatus = "stopped" | "buffering" | "playing";

export interface PlaybackState {
  status: PlaybackStatus;
  /** How far ahead frames are loaded: the day boundary after the last one (null: none). */
  bufferedTo: number | null;
  /**
   * How far the frames it's waiting for are loaded, 0 to 1: those it needs to (re)start,
   * or while playing on with few in ahead, the ones that would let it play at full
   * speed. Null otherwise (stopped, or enough in ahead).
   */
  loading: number | null;
}

interface Frame {
  range: DayRange;
  checked?: CheckedWaporPeriod | null; // null: can't be shown
  buffered: boolean;
  loading?: boolean;
}

/** How to play a range: the frame after one, and the first of all (as far back as it goes). */
function framesOf(range: DayRange, step: number): { next: (r: DayRange) => DayRange; first: DayRange } {
  const back = range.start - (range.start % step);
  return {
    next: ({ start, end }) => ({ start: start + step, end: end + step }),
    first: { start: range.start - back, end: range.end - back },
  };
}

export interface WaporPlayer {
  /** Play from the current range (from the first one if it's the last), or stop. */
  toggle(): void;
  stop(): void;
}

/**
 * `getRange` and `getVariable` are the range and variable shown when play is pressed;
 * `show` shows a frame (the range on the toolbar and the period on the map) for `ms`;
 * `onState` follows the play button and the buffered part of the slider.
 */
export function initWaporPlayer({
  getRange,
  getVariable,
  show,
  onState,
}: {
  getRange: () => DayRange;
  getVariable: () => WaporVariable;
  show: (range: DayRange, checked: CheckedWaporPeriod, ms: number) => void;
  onState: (state: PlaybackState) => void;
}): WaporPlayer {
  const settings = DEFAULT_PLAYBACK;
  let run: {
    variable: WaporVariable;
    frames: Frame[]; // from the next one to show
    last: DayRange; // of the frames made so far
    end: number; // frames that can be shown (Infinity: not known yet)
    next: (range: DayRange) => DayRange;
    first: DayRange; // of all, at the same length
    shown: number;
    rewound: boolean;
    status: PlaybackStatus;
    abort: AbortController; // the loading, for the current view
    waiting: (() => void)[]; // loaders with nothing to do, far enough ahead
    timer: number;
  } | null = null;

  // (Told only when something changed: several loaders report after each tile.)
  let reported = "";
  function tell(state: PlaybackState) {
    const key = `${state.status}:${state.bufferedTo}:${state.loading}`;
    if (key === reported) return;
    reported = key;
    onState(state);
  }
  function report() {
    if (!run) return tell({ status: "stopped", bufferedTo: null, loading: null });
    let last: Frame | null = null;
    let ahead = 0;
    for (const frame of run.frames.slice(0, run.end)) {
      if (!frame.buffered) break;
      last = frame;
      ahead++;
    }
    const wanted = Math.min(run.status === "buffering" ? settings.startAhead : SLOW_BELOW, run.end);
    const loading = ahead < wanted ? ahead / wanted : null;
    tell({ status: run.status, bufferedTo: last && last.range.end + 1, loading });
  }

  /** Frame `i` ahead, made when first needed; null past the current dekad. */
  function frameAt(i: number): Frame | null {
    const current = run!;
    const { frames } = current;
    while (frames.length <= i) {
      const next = current.next(current.last);
      if (next.end > MAX_DAY) return null;
      current.last = next;
      frames.push({ range: next, buffered: false });
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
      const until = Math.min(current.end, settings.ahead);
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
        if (frame.checked === undefined) frame.checked = await checkedWaporPeriod(current.variable, frame.range);
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
    const ahead = Math.min(settings.startAhead, end);
    const ready = frames.length >= ahead && frames.slice(0, ahead).every((f) => f.buffered);
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
    let ahead = 0;
    while (ahead < SLOW_BELOW && current.frames[ahead]?.buffered) ahead++;
    const ms = settings.frameMs * (1 + ((SLOWEST - 1) * (SLOW_BELOW - ahead)) / SLOW_BELOW);
    show(frame.range, frame.checked!, ms);
    wake(current);
    current.timer = window.setTimeout(tick, ms);
    advance();
  }

  function play() {
    const range = getRange();
    const { next, first } = framesOf(range, settings.stepDays);
    // From the start if there's no next frame.
    const rewound = next(range).end > MAX_DAY;
    const from = rewound ? first : next(range);
    const current = {
      variable: getVariable(),
      frames: [{ range: from, buffered: false }],
      last: from,
      end: Infinity,
      next,
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
    for (let i = 0; i < settings.loaders; i++) void load(current);
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
