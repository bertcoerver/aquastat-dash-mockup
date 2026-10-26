/*
 * The Basin view's groups of major basins, its counterpart of the Country view's
 * regions, two ways (public/data/basin-groups.json, built by scripts/build-basin-groups.mjs):
 *
 * - where the water goes: the ocean (or sea) most of a basin's area drains into, or
 *   inland, for discharge and what's left of the rain (it ends up there);
 * - climate: the basin's UNEP aridity class, WaPOR's precipitation over reference
 *   evapotranspiration, for precipitation and evapotranspiration (basins north of 60°N
 *   have none: WaPOR's precipitation stops there).
 *
 * Groups have ids of their own (a row's data-sub is "group:<id>").
 */

export type Grouping = "drain" | "climate";

export interface Group {
  id: number;
  grouping: Grouping;
  /** As in basin-groups.json. */
  key: string;
  name: string;
  /** For chart rows. */
  short: string;
  /** "basins draining to the Atlantic", for captions. */
  basins: string;
}

export const GROUPS: Group[] = [
  { id: 1, grouping: "drain", key: "atlantic", name: "Atlantic Ocean", short: "Atlantic", basins: "basins draining to the Atlantic" },
  { id: 2, grouping: "drain", key: "pacific", name: "Pacific Ocean", short: "Pacific", basins: "basins draining to the Pacific" },
  { id: 3, grouping: "drain", key: "indian", name: "Indian Ocean", short: "Indian Ocean", basins: "basins draining to the Indian Ocean" },
  { id: 4, grouping: "drain", key: "arctic", name: "Arctic Ocean", short: "Arctic", basins: "basins draining to the Arctic" },
  { id: 5, grouping: "drain", key: "mediterranean", name: "Mediterranean and Black Sea", short: "Mediterranean", basins: "basins draining to the Mediterranean" },
  { id: 6, grouping: "drain", key: "inland", name: "Inland (no outlet to the sea)", short: "Inland", basins: "inland basins" },
  { id: 11, grouping: "climate", key: "hyper-arid", name: "Hyper-arid", short: "Hyper-arid", basins: "hyper-arid basins" },
  { id: 12, grouping: "climate", key: "arid", name: "Arid", short: "Arid", basins: "arid basins" },
  { id: 13, grouping: "climate", key: "semi-arid", name: "Semi-arid", short: "Semi-arid", basins: "semi-arid basins" },
  { id: 14, grouping: "climate", key: "dry-subhumid", name: "Dry sub-humid", short: "Dry sub-humid", basins: "dry sub-humid basins" },
  { id: 15, grouping: "climate", key: "humid", name: "Humid", short: "Humid", basins: "humid basins" },
];

export const GROUPINGS: Record<Grouping, { label: string; about: string }> = {
  drain: {
    label: "where the water goes",
    about: "Where the water goes: the ocean or sea most of a basin's area drains into, or inland.",
  },
  climate: {
    label: "climate",
    about: "Climate: the UNEP aridity class of each basin, from WaPOR's precipitation over reference evapotranspiration",
  },
};

export interface BasinGroups {
  /** The years the aridity is over. */
  years: [number, number];
  majors: Record<string, { drain: string; drainShare: number; ai: number | null; climate: string | null; covered: number }>;
}

let data: BasinGroups = { years: [0, 0], majors: {} };
const byMajor = new Map<string, Group>(); // "<grouping>:<major>"

export function setBasinGroups(groups: BasinGroups) {
  data = groups;
  byMajor.clear();
  for (const [id, b] of Object.entries(groups.majors)) {
    for (const g of GROUPS) if ((g.grouping === "drain" ? b.drain : b.climate) === g.key) byMajor.set(`${g.grouping}:${id}`, g);
  }
}

export const groupsOf = (grouping: Grouping) => GROUPS.filter((g) => g.grouping === grouping);
export const groupById = (id: number) => GROUPS.find((g) => g.id === id) ?? null;
/** A major basin's group (null: none, e.g. no climate north of 60°N). */
export const groupOf = (major: number, grouping: Grouping) => byMajor.get(`${grouping}:${major}`) ?? null;
export const inGroup = (major: number, id: number) => {
  const g = groupById(id);
  return !!g && groupOf(major, g.grouping) === g;
};
/** "2018–2025", the years the climate is from. */
export const climateYears = () => `${data.years[0]}–${data.years[1]}`;
