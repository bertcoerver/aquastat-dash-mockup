/*
 * The load bar: the line under each graph pane's heading fills while something loads.
 * Where a task says how far along it is (setProgress), the bar shows that; otherwise
 * (only "loading") a short stretch of it sweeps left and right. It counts every
 * fetch() on the page (map tiles, WaPOR rasters, place lookups, lists), so nothing has
 * to report to it just to be counted. The bar itself is CSS (.wb-head::after in
 * basin.css), driven by classes on <html>: .loading, and .load-known with --load (0–1).
 *
 * A request counts until its body has been read, not just until the headers arrive.
 * A body that's never read (a HEAD request, an error page nobody reads) stops counting
 * at the headers, or after BODY_TIMEOUT_MS at the latest.
 *
 * Lookups nobody waits for (what's under the pointer) fetch with quietFetch instead,
 * or every move of the mouse over the map would set it off.
 *
 * Messages that only said "Loading…" are gone with it: a status that is LOADING still
 * holds things back like any other message, but shows nothing (see unlessLoading).
 */

const SHOW_AFTER_MS = 200; // quick requests don't flash the bar
const MIN_VISIBLE_MS = 400; // once shown, don't flicker off between requests
const FULL_MS = 500; // a finished bar stays full this long
const BODY_TIMEOUT_MS = 15_000;
const BODY_READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

/** A status meaning "not there yet, still loading": shown as nothing, the bar says it. */
export const LOADING = "Loading…";
/** A status as it is shown: LOADING as nothing. */
export const unlessLoading = (status: string) => (status === LOADING ? "" : status);

/** fetch() that the bar doesn't count (the page's own, from before initLoadBar). */
export const quietFetch: typeof fetch = window.fetch.bind(window);

const root = document.documentElement;
let pending = 0;
/** Tasks that know how far along they are (0–1), by name. */
const progress = new Map<string, number>();
let shownAt = 0;
// Once scheduled, a timer isn't restarted by later requests: a steady stream of
// short requests would otherwise keep postponing it.
let showTimer = 0;
let hideTimer = 0;
let fullTimer = 0;

/**
 * How far along a task is, from 0 to 1, or null once it's done (or stopped). While any
 * task has said, the bar shows the least far along of them (sweeping while that is 0).
 */
export function setProgress(task: string, fraction: number | null) {
  if (fraction === null) progress.delete(task);
  else progress.set(task, Math.min(1, Math.max(0, fraction)));
  update();
}

function show() {
  showTimer = 0;
  if (!busy()) return; // all done within SHOW_AFTER_MS
  root.classList.add("loading");
  shownAt = performance.now();
}

function hide() {
  hideTimer = 0;
  root.classList.remove("loading");
}

const busy = () => pending > 0 || progress.size > 0;

function update() {
  // (No progress yet is as good as not knowing: it sweeps until there is some.)
  const least = progress.size ? Math.min(...progress.values()) : 0;
  if (least > 0) {
    clearTimeout(fullTimer);
    fullTimer = 0;
    root.classList.add("load-known");
    root.style.setProperty("--load", String(least));
  } else if (progress.size) {
    root.classList.remove("load-known");
  } else if (root.classList.contains("load-known")) {
    // Finished: full for a moment (while it fades, or before it sweeps for what's left).
    root.style.setProperty("--load", "1");
    fullTimer ||= window.setTimeout(() => {
      fullTimer = 0;
      if (!progress.size) root.classList.remove("load-known");
    }, FULL_MS);
  }
  const visible = root.classList.contains("loading");
  if (busy()) {
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (!visible && !showTimer) showTimer = window.setTimeout(show, SHOW_AFTER_MS);
  } else if (visible && !hideTimer) {
    // A pending show timer is left running: it checks again when it fires, so short
    // gaps between requests don't keep cancelling it.
    hideTimer = window.setTimeout(hide, Math.max(0, shownAt + MIN_VISIBLE_MS - performance.now()));
  }
}

/** Count one request; the returned function ends it (only the first call counts). */
function begin() {
  pending++;
  update();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    pending--;
    update();
  };
}

/** Start counting requests. Call before anything fetches. */
export function initLoadBar() {
  window.fetch = async (input, init) => {
    const end = begin();
    try {
      const response = await quietFetch(input, init);
      if (!response.body) {
        end();
        return response;
      }
      // Wrap the body readers on this response, so the request ends when one settles.
      for (const name of BODY_READERS) {
        const read = response[name] as (() => Promise<unknown>) | undefined;
        if (!read) continue;
        Object.defineProperty(response, name, {
          value: () => read.call(response).finally(end),
        });
      }
      setTimeout(end, BODY_TIMEOUT_MS);
      return response;
    } catch (err) {
      end(); // network error or aborted
      throw err;
    }
  };
}
