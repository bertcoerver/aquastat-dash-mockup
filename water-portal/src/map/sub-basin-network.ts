/*
 * How the SDG 6 sub-basins drain into each other. The links come from the tiles
 * (TO_SB_ID), via public/data/sub-basins.json (scripts/build-lists.mjs); they are the
 * same as in fao_sb_ids.json from the wapor_discharge project.
 */

/** An entry of public/data/sub-basins.json. */
export interface SubBasin {
  id: number;
  name: string;
  majorBasin: number;
  /** The sub-basin it drains into; -999 for the sea, -888 for an inland sink. */
  downstream: number;
  /** Area in km² (from fao_sb_ids.json; the water balance model needs it). */
  area: number | null;
  bbox: [number, number, number, number];
}

/** Returns a function that gives all sub-basins upstream of one (not itself). */
export function upstreamFinder(subBasins: SubBasin[]): (id: number) => Set<number> {
  // Reverse the links: for each sub-basin, those that drain straight into it.
  const inflows = new Map<number, number[]>();
  for (const { id, downstream } of subBasins) {
    if (!inflows.has(downstream)) inflows.set(downstream, []);
    inflows.get(downstream)!.push(id);
  }

  return (id) => {
    // Walk upstream. The data have a few loops (Liu He drains into itself, a ring of
    // six on the Aras), so each basin is visited once.
    const found = new Set<number>([id]);
    const todo = [id];
    while (todo.length) {
      for (const next of inflows.get(todo.pop()!) ?? []) {
        if (!found.has(next)) {
          found.add(next);
          todo.push(next);
        }
      }
    }
    found.delete(id);
    return found;
  };
}
