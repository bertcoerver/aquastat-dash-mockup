/*
 * The countries as a tree, for the country picker: AQUASTAT's regions, each holding its
 * countries, as the basin picker's major basins hold their sub-basins (basin-tree.ts).
 * Countries in no region (disputed areas, Antarctica) are at the top level, after the
 * regions; the unnamed ones ("---") are left out.
 */
import type { TreeOption } from "./tree-combobox";

/** An entry of public/data/countries.json (scripts/build-lists.mjs). */
export interface Country {
  m49: number;
  name: string;
  bbox: [number, number, number, number];
}

export interface Region {
  code: number;
  name: string;
}

export type CountryNode = TreeOption<{ kind: "region"; region: Region } | { kind: "country"; country: Country; region: Region | null }>;

/** Keys for the tree: region codes and M49 codes overlap. */
export const regionKey = (code: number) => `r${code}`;
export const countryKey = (m49: number) => `c${m49}`;

export function countryTree(regions: Region[], countries: Country[], regionOf: Map<number, number>): CountryNode[] {
  const regionNodes = new Map<number, CountryNode>(
    regions.map((region) => [region.code, { key: regionKey(region.code), label: region.name, parent: null, children: [], data: { kind: "region", region } }]),
  );
  const loose: CountryNode[] = [];
  for (const country of countries) {
    if (country.name === "---") continue;
    const parent = regionNodes.get(regionOf.get(country.m49) ?? NaN) ?? null;
    const region = parent?.data.kind === "region" ? parent.data.region : null;
    const node: CountryNode = { key: countryKey(country.m49), label: country.name, hint: String(country.m49), parent, children: [], data: { kind: "country", country, region } };
    if (parent) parent.children.push(node);
    else loose.push(node);
  }
  const byName = (a: CountryNode, b: CountryNode) => a.label.localeCompare(b.label);
  const roots = [...regionNodes.values()].sort(byName);
  for (const r of roots) r.children.sort(byName);
  return [...roots, ...loose.sort(byName)];
}
