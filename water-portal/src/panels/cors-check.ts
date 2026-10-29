/*
 * A warning in the bottom-left corner, as the slow connection's (slow-server.ts), when
 * the browser won't let the page read a server's data because the server doesn't allow
 * other websites to (it sends no CORS headers): GAEZ's bucket, until FAO allows it.
 * Any map's or data set's requests count: it watches every fetch() on the page.
 *
 * The browser doesn't say why a request failed: blocked, it throws the same TypeError
 * as offline. So when a request to another site fails, the same URL is asked again, as
 * a HEAD in "no-cors" mode (the answer is opaque: nothing is read, but it comes). If
 * that gets an answer, the server is there, and CORS stopped the first. The warning
 * names the data (by bucket on Google Cloud Storage, else by host); an answer from it
 * later takes it off again.
 */
import { cornerWarning } from "./corner-warning";
import { quietFetch } from "./load-bar";

/** The data sets' names, by where they come from (see sourceOf). */
const NAMES: Record<string, string> = {
  "storage.googleapis.com/fao-gismgr-gaez-v5-data": "GAEZ v5",
  "storage.googleapis.com/fao-gismgr-gaez-v4-data": "GAEZ v4",
  "storage.googleapis.com/fao-gismgr-wapor-3-data": "WaPOR",
};

/** Where a URL's data comes from: a bucket on Google Cloud Storage, else the host. */
function sourceOf(url: URL) {
  return url.host === "storage.googleapis.com" ? `${url.host}/${url.pathname.split("/")[1]}` : url.host;
}

/** Start watching the page's requests. Call after initLoadBar (it wraps fetch too). */
export function initCorsCheck() {
  const warning = cornerWarning();
  /** The names of the sources blocked, by source. */
  const blocked = new Map<string, string>();
  const probing = new Set<string>();

  function show() {
    warning.hidden = !blocked.size;
    if (!blocked.size) return;
    const names = [...blocked.values()];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    warning.textContent = `⚠ Can't read ${list}: blocked by its server (CORS)`;
    warning.title =
      `The browser won't let this page read data from ${[...blocked.keys()].join(", ")}: the server doesn't ` +
      `allow other websites to read it (it sends no CORS headers). The data is there, but the maps made from it ` +
      `stay empty until the server allows it.`;
  }

  async function probe(url: URL) {
    const source = sourceOf(url);
    if (blocked.has(source) || probing.has(source)) return;
    probing.add(source);
    try {
      await quietFetch(url.href, { method: "HEAD", mode: "no-cors", cache: "no-store" });
      blocked.set(source, NAMES[source] ?? source);
      show();
    } catch {
      // Not there at all (offline, no such server): not CORS.
    } finally {
      probing.delete(source);
    }
  }

  const inner = window.fetch;
  window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input), window.location.href);
    const elsewhere = url.origin !== window.location.origin;
    try {
      const response = await inner(input, init);
      if (elsewhere && blocked.delete(sourceOf(url))) show();
      return response;
    } catch (err) {
      const aborted = init?.signal?.aborted || request?.signal.aborted || (err as Error)?.name === "AbortError";
      if (elsewhere && !aborted && navigator.onLine) void probe(url);
      throw err;
    }
  };
}
