/*
 * Discharge per sub-basin and dekad for a major basin, from the portal's water balance
 * model (water-portal/src/basin/model.ts):
 *
 * - the portal's precomputed files (major/<id>.json, written by fao-wapor-discharge),
 *   when they're there (VITE_MODEL_FILES, see vite.config.ts);
 * - otherwise the model run here, in the browser, as the portal's water balance panel
 *   runs it: once per outlet network the basin's sub-basins drain to (one BigQuery
 *   query each), whole, so sub-basins upstream in other major basins are included.
 */
import { loadSubBasinFluxes, runNetwork } from "@portal/basin/model";
import type { SubBasin } from "@portal/map/sub-basin-network";

export interface BasinDischarge {
  /** Dekad indices (the portal's dekads.ts), ascending. */
  dekads: number[];
  /** Q per sub-basin, m³/s, one value per dekad (NaN: none). */
  q: Map<number, Float64Array>;
  source: "files" | "browser";
}

/** Model runs at once in the browser (each is a BigQuery query). */
const PARALLEL = 4;

export async function basinDischarge(major: number, subBasins: SubBasin[]): Promise<BasinDischarge> {
  try {
    const { dekads, series } = await loadSubBasinFluxes(major);
    return { dekads, q: new Map([...series].map(([id, s]) => [id, s.Q])), source: "files" };
  } catch {
    return runInBrowser(major, subBasins);
  }
}

async function runInBrowser(major: number, subBasins: SubBasin[]): Promise<BasinDischarge> {
  const byId = new Map(subBasins.map((b) => [b.id, b]));
  const outletOf = (id: number) => {
    const seen = new Set<number>();
    for (let b = byId.get(id); b && !seen.has(b.id); b = byId.get(b.downstream)) {
      seen.add(b.id);
      if (b.downstream === -999 || b.downstream === -888) return b.id;
    }
    return null; // drains into a loop or a missing sub-basin: in no network
  };
  const networks = new Map<number, SubBasin[]>();
  for (const b of subBasins) {
    const outlet = outletOf(b.id);
    if (outlet === null) continue;
    if (!networks.has(outlet)) networks.set(outlet, []);
    networks.get(outlet)!.push(b);
  }
  const outlets = [...new Set(subBasins.filter((b) => b.majorBasin === major).map((b) => outletOf(b.id)))].filter(
    (o): o is number => o !== null,
  );

  const results = [];
  for (let i = 0; i < outlets.length; i += PARALLEL) {
    const batch = outlets.slice(i, i + PARALLEL).map((outlet) => {
      const network = networks.get(outlet)!;
      return runNetwork(byId.get(outlet)!, network.filter((b) => b.id !== outlet));
    });
    results.push(...(await Promise.all(batch)));
  }

  // One dekad axis for all the networks.
  const dekads = [...new Set(results.flatMap((r) => r.dekads))].sort((a, b) => a - b);
  const index = new Map(dekads.map((dk, i) => [dk, i]));
  const q = new Map<number, Float64Array>();
  for (const r of results) {
    for (const [id, s] of r.series) {
      const values = new Float64Array(dekads.length).fill(NaN);
      r.dekads.forEach((dk, i) => (values[index.get(dk)!] = s.Q[i]));
      q.set(id, values);
    }
  }
  return { dekads, q, source: "browser" };
}
