/*
 * The basins as a tree, for the basin picker: each major basin holds its sub-basins,
 * arranged as the rivers run. A sub-basin's children are the sub-basins that drain
 * into it, so the top level of a major basin is where its rivers reach the sea (or an
 * inland sink, or another major basin), and going down the tree goes upstream.
 */
import type { SubBasin } from "../map/sub-basin-network";
import type { TreeOption } from "./tree-combobox";

/** A major basin, as in public/data/major-basins.json. */
export interface MajorBasin {
  id: number;
  name: string;
  bbox: [number, number, number, number];
}

export type BasinNode = TreeOption<
  { kind: "major"; basin: MajorBasin } | { kind: "sub"; basin: SubBasin; majorBasin: MajorBasin }
>;

/** Keys for the tree: major and sub-basin IDs are separate number ranges. */
export const majorKey = (id: number) => `mb${id}`;
export const subKey = (id: number) => `sb${id}`;

export function basinTree(majors: MajorBasin[], subs: SubBasin[]): BasinNode[] {
  const majorNodes = new Map<number, BasinNode>(
    majors.map((basin) => [
      basin.id,
      { key: majorKey(basin.id), label: basin.name, hint: String(basin.id), parent: null, children: [], data: { kind: "major", basin } },
    ]),
  );
  const subNodes = new Map<number, BasinNode>();
  for (const basin of subs) {
    const major = majorNodes.get(basin.majorBasin);
    if (!major || major.data.kind !== "major") continue; // (every sub-basin has one)
    subNodes.set(basin.id, {
      key: subKey(basin.id),
      label: basin.name,
      hint: String(basin.id),
      parent: null,
      children: [],
      data: { kind: "sub", basin, majorBasin: major.data.basin },
    });
  }

  // Hang each sub-basin under the one it drains into, if that is in the same major
  // basin; otherwise under the major basin itself.
  const inflows = new Map<BasinNode, BasinNode[]>();
  for (const node of subNodes.values()) {
    const sub = node.data as Extract<BasinNode["data"], { kind: "sub" }>;
    const down = subNodes.get(sub.basin.downstream);
    const sameMajor = down && down !== node && down.data.kind === "sub" && down.data.majorBasin.id === sub.majorBasin.id;
    const parent = sameMajor ? down : majorNodes.get(sub.majorBasin.id)!;
    if (!inflows.has(parent)) inflows.set(parent, []);
    inflows.get(parent)!.push(node);
  }

  // Build the tree from the top, so a loop in the links (a ring of sub-basins that
  // drain into each other, see sub-basin-network.ts) can't make a cycle: whatever
  // isn't reached from a major basin is hung under it at the top level.
  const placed = new Set<BasinNode>();
  function attach(parent: BasinNode, children: BasinNode[]) {
    for (const child of children) {
      if (placed.has(child)) continue;
      placed.add(child);
      child.parent = parent;
      parent.children.push(child);
      attach(child, inflows.get(child) ?? []);
    }
  }
  for (const major of majorNodes.values()) attach(major, inflows.get(major) ?? []);
  for (const node of subNodes.values()) {
    if (!placed.has(node) && node.data.kind === "sub") attach(majorNodes.get(node.data.majorBasin.id)!, [node]);
  }

  const roots = [...majorNodes.values()];
  sortTree(roots);
  return roots;
}

function sortTree(nodes: BasinNode[]) {
  // Numeric, so "White Nile 2" comes before "White Nile 10".
  nodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  for (const node of nodes) sortTree(node.children);
}
