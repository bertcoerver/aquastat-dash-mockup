/*
 * A warning in the bottom-left corner when the WaPOR rasters' server (Google Cloud Storage)
 * answers slowly. It says so in terms of the connection, not WaPOR: the data is fine. Every
 * map tile and time-series value is a request to it, so a slow answer makes the maps
 * and time series slow however small the request is. The usual cause is DNS that sends
 * the browser to Google servers on another continent (a 1 KiB read takes ~2.5 s instead
 * of ~0.1 s): a DNS filter or VPN can do this. It can change from one connection to the
 * next, so a page that started fast can turn slow.
 *
 * A page can't see DNS answers or ping, so this times a few 1 KiB reads in a row, on
 * the same connection the maps use, and takes the median: far away, single reads vary
 * from ~0.6 to ~3 s; near, they're a steady ~0.2 s. ~5 KiB each time. It checks at
 * start; then whenever one of the page's own requests to the server is slow (at most
 * once a minute: a big tile can be slow on a slow line too); and while the warning
 * shows, every minute, to see it go.
 */
import { BUCKET } from "../map/layers/wapor-variables";
import { cornerWarning } from "./corner-warning";
import { quietFetch } from "./load-bar";

const PROBE_URL = `${BUCKET}/L1-AETI-A/WAPOR-3.L1-AETI-A.2018.tif`;
const HOST = new URL(BUCKET).origin;
const READS = 5;
const SLOW_MS = 600; // the median, near: ~0.2 s; on another continent: ~1–2.5 s
const MIN_GAP_MS = 60_000; // between checks set off by slow requests
const WHILE_SHOWN_MS = 60_000;

/** Adds the (hidden) warning to the page's bottom-left corner and starts checking. */
export function initSlowServerCheck() {
  const warning = cornerWarning();

  let checking = false;
  let lastCheck = -Infinity;
  let recheck = 0;

  async function check() {
    if (checking) return;
    if (document.hidden) {
      // (Not timed in the background, where requests are slowed; the warning shown is
      // checked again once the page is back.)
      clearTimeout(recheck);
      if (!warning.hidden) recheck = window.setTimeout(() => void check(), WHILE_SHOWN_MS);
      return;
    }
    checking = true;
    lastCheck = performance.now();
    const ms = await typical();
    checking = false;
    if (ms === null) return; // offline, or the probe went away: say nothing
    const slow = ms > SLOW_MS;
    warning.hidden = !slow;
    clearTimeout(recheck);
    if (!slow) return;
    recheck = window.setTimeout(() => void check(), WHILE_SHOWN_MS);
    const s = (ms / 1000).toFixed(1);
    warning.textContent = `⚠ Slow connection to Google Cloud (${s} s)`;
    warning.title =
      `The WaPOR maps and time series come from Google Cloud Storage. From here, each request to it takes ${s} s ` +
      `(usually ~0.1 s), so they load slowly. The data and its servers are fine: most likely your DNS sends you ` +
      `to Google's servers on another continent (a DNS filter or VPN can do this). Reloading may help for a while; ` +
      `other DNS settings fix it.`;
  }

  void check();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !warning.hidden) void check();
  });
  // (Cross-origin, a request's duration is all the browser tells: start to last byte.)
  new PerformanceObserver((list) => {
    if (checking || !warning.hidden || performance.now() - lastCheck < MIN_GAP_MS) return;
    const slow = list.getEntries().some((entry) => entry.name.startsWith(HOST) && entry.duration > SLOW_MS);
    if (slow) void check();
  }).observe({ type: "resource" });
}

/** The median time of READS reads in a row, in ms; null if one fails. */
async function typical(): Promise<number | null> {
  const times: number[] = [];
  for (let i = 0; i < READS; i++) {
    const start = performance.now();
    try {
      const response = await quietFetch(PROBE_URL, { headers: { Range: "bytes=0-1023" }, cache: "no-store" });
      await response.arrayBuffer();
      if (!response.ok) return null;
    } catch {
      return null;
    }
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[READS >> 1];
}
