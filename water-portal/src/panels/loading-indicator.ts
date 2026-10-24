/*
 * The spinner in the top bar: it turns while any data request is under way. It counts
 * every fetch() on the page (map tiles, WaPOR rasters, place lookups, lists), so
 * nothing has to report to it. The markup lives in index.html.
 *
 * A request counts until its body has been read, not just until the headers arrive.
 * A body that's never read (a HEAD request, an error page nobody reads) stops counting
 * at the headers, or after BODY_TIMEOUT_MS at the latest.
 */

const SHOW_AFTER_MS = 200; // quick requests don't flash the spinner
const MIN_VISIBLE_MS = 400; // once shown, don't flicker off between requests
const BODY_TIMEOUT_MS = 15_000;
const BODY_READERS = ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const;

/** Start counting requests and showing the spinner. Call before anything fetches. */
export function initLoadingIndicator() {
  const el = document.getElementById("loading")!;
  const text = document.getElementById("loading-text")!;
  let pending = 0;
  let shownAt = 0;
  // Once scheduled, a timer isn't restarted by later requests: a steady stream of
  // short requests would otherwise keep postponing it.
  let showTimer = 0;
  let hideTimer = 0;

  function show() {
    showTimer = 0;
    if (pending === 0) return; // all done within SHOW_AFTER_MS
    el.classList.add("active");
    text.textContent = "Loading data…";
    shownAt = performance.now();
  }

  function hide() {
    hideTimer = 0;
    el.classList.remove("active");
    text.textContent = "";
  }

  function update() {
    const visible = el.classList.contains("active");
    if (pending > 0) {
      clearTimeout(hideTimer);
      hideTimer = 0;
      if (!visible && !showTimer) showTimer = window.setTimeout(show, SHOW_AFTER_MS);
    } else {
      // A pending show timer is left running: it checks again when it fires, so short
      // gaps between requests don't keep cancelling it.
      if (visible && !hideTimer) {
        hideTimer = window.setTimeout(hide, Math.max(0, shownAt + MIN_VISIBLE_MS - performance.now()));
      }
    }
    el.title = pending > 0 ? `Loading data (${pending} request${pending === 1 ? "" : "s"})` : "";
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

  const fetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const end = begin();
    try {
      const response = await fetch(input, init);
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
