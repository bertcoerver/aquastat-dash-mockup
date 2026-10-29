/*
 * What the build scripts share: where the project is, rounding, a fetch that fails
 * loudly, and writing a JSON file whole (never half-written if interrupted).
 */
import fs from "node:fs/promises";
import path from "node:path";

/** The project folder (water-portal/). */
export const ROOT = path.resolve(import.meta.dirname, "..");

/** To three decimals (a metre or so, for coordinates). */
export const round3 = (v) => Math.round(v * 1000) / 1000;

/** fetch(), failing with the URL and status on anything but 2xx. */
export async function fetchOk(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res;
}

/** Write `data` as JSON to `file`, through a temporary file, so an interrupted run leaves the old file. */
export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}
