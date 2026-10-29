/*
 * The dams as a tree, for the Local panel's search (place-picker.ts): the countries,
 * each holding its dams, by name (the river faintly after it). Picking a country flies
 * to its dams; picking a dam selects it.
 */
import type { Dams } from "../local/vector-maps";
import { unionBox, type Box } from "../map/fly-to";
import type { TreeOption } from "./tree-combobox";

export type DamNode = TreeOption<{ kind: "country"; box: Box } | { kind: "dam"; index: number }>;

export const damKey = (index: number) => `d${index}`;

export function damTree(dams: Dams): DamNode[] {
  const byCountry = new Map<string, DamNode>();
  for (let i = 0; i < dams.count; i++) {
    const name = dams.country[i] || "Country not given";
    let country = byCountry.get(name);
    if (!country) {
      country = { key: `dc:${name}`, label: name, parent: null, children: [], data: { kind: "country", box: [0, 0, 0, 0] } };
      byCountry.set(name, country);
    }
    country.children.push({ key: damKey(i), label: dams.name[i] || "Unnamed dam", hint: dams.river[i] || undefined, parent: country, children: [], data: { kind: "dam", index: i } });
  }
  const byName = (a: DamNode, b: DamNode) => a.label.localeCompare(b.label);
  const roots = [...byCountry.values()].sort(byName);
  for (const c of roots) {
    c.children.sort(byName);
    // (Around its dams, across 180° where that's shorter: a country's islands.)
    const at = (n: DamNode) => (n.data.kind === "dam" ? n.data.index : 0);
    c.data = { kind: "country", box: unionBox(c.children.map((n) => [dams.lon[at(n)], dams.lat[at(n)], dams.lon[at(n)], dams.lat[at(n)]])) };
  }
  return roots;
}
