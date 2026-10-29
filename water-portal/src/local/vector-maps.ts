/*
 * The Local view's vector maps: point data sets, each a map in the Local legend's
 * checklist (local-maps.ts), under its group, beside WaPOR's rasters. A map shows one
 * of its attributes at a time, picked from a menu under its title, and how it can be
 * drawn follows from the attribute's kind:
 *
 * - an amount (a reservoir's capacity): circles (area by the value) or 3D bars (height);
 * - a value (the year a dam was completed): circles of one size, coloured by a ramp;
 * - classes (a dam's purpose): circles of one size, coloured by class; the legend's
 *   swatches switch classes off.
 *
 * Each map's data are one JSON file of columns (a list per field, an item per index),
 * loaded the first time the map is shown: all of it at once (no tiles), so any attribute
 * can be drawn, and its range and classes found, over all the points.
 */

/** A map's data: the points' positions, and its own columns. */
export interface PointData {
  count: number;
  lon: number[];
  lat: number[];
}

export type AttributeKind<D> =
  | { kind: "amount"; unit: string; value(d: D, i: number): number | null }
  | { kind: "value"; unit: string; ramp: string[]; value(d: D, i: number): number | null }
  | { kind: "classes"; classes: { label: string; color: string }[]; classOf(d: D, i: number): number };

export type VectorAttribute<D> = AttributeKind<D> & {
  id: string;
  label: string;
  /** What to know about it, under the title (a caveat of the data). */
  note?: string;
};

export interface VectorMap<D extends PointData = PointData> {
  id: string;
  title: string;
  /** Its group's heading in the checklist. */
  group: string;
  /** Where it comes from, under its title. */
  source: string;
  url: string;
  parse(json: unknown): D;
  attributes: VectorAttribute<D>[];
  /** A point's name (in the Local panel's title, once picked). */
  name(d: D, i: number): string;
  /** Where a point is, under its name in its tooltip (local-maps.ts: a tile per map on the map). */
  where(d: D, i: number): string;
}

// --- Dams --------------------------------------------------------------------------------------

/** AQUASTAT's dams (scripts/build-dams.mjs), a column per field. */
export interface Dams extends PointData {
  name: string[];
  country: string[];
  river: string[];
  basin: string[];
  year: (number | null)[];
  height: (number | null)[];
  capacity: (number | null)[];
  area: (number | null)[];
  /** Bits, in the order of PURPOSES. */
  purposes: number[];
  /** 1: checked, 0: not, null: not said. */
  validated: (0 | 1 | null)[];
}

/** The purposes' names, in the order of their bits (scripts/build-dams.mjs). */
export const PURPOSES = ["Irrigation", "Water supply", "Flood control", "Hydroelectricity", "Navigation", "Recreation", "Pollution control", "Livestock"];

/** The purpose classes: one of the four main purposes alone, another, several, or none given. */
const PURPOSE_CLASSES = [
  { label: "Irrigation", color: "#3a9a4a" },
  { label: "Hydroelectricity", color: "#eda100" },
  { label: "Water supply", color: "#2c7fb8" },
  { label: "Flood control", color: "#6250d6" },
  { label: "Other purpose", color: "#8c8a83" },
  { label: "Several purposes", color: "#d4342b" },
  { label: "None given", color: "#c9c6bd" },
];
const MAIN_PURPOSES = [0, 3, 1, 2]; // (bits, in PURPOSE_CLASSES's order)

function purposeClass(bits: number) {
  if (!bits) return 6;
  if (bits & (bits - 1)) return 5;
  const main = MAIN_PURPOSES.findIndex((b) => bits === 1 << b);
  return main >= 0 ? main : 4;
}

export const DAMS: VectorMap<Dams> = {
  id: "dams",
  title: "Dams",
  group: "Infrastructure",
  source: "AQUASTAT dams (2026 edition, via FAO's Water Portal)",
  url: `${import.meta.env.BASE_URL}data/dams.json`,
  parse(json) {
    const { count, columns } = json as { count: number; columns: Omit<Dams, "count"> };
    return { count, ...columns };
  },
  attributes: [
    { id: "capacity", label: "Reservoir capacity", kind: "amount", unit: "million m³", value: (d, i) => d.capacity[i] },
    { id: "area", label: "Reservoir area", kind: "amount", unit: "km²", value: (d, i) => d.area[i] },
    { id: "height", label: "Dam height", kind: "amount", unit: "m", value: (d, i) => d.height[i] },
    {
      id: "year",
      label: "Year completed",
      kind: "value",
      unit: "",
      ramp: ["#fff6b0", "#fdd84f", "#f28b35", "#d4342b", "#7f0000"],
      value: (d, i) => d.year[i],
      note: "1960 is given for far more dams than any other year (most of Uruguay's): it may stand for 1960 or before",
    },
    { id: "purpose", label: "Purpose", kind: "classes", classes: PURPOSE_CLASSES, classOf: (d, i) => purposeClass(d.purposes[i]) },
    {
      id: "location",
      label: "Location checked",
      kind: "classes",
      classes: [
        { label: "Checked", color: "#3a9a4a" },
        { label: "Not checked", color: "#eda100" },
        { label: "Not said", color: "#c9c6bd" },
      ],
      classOf: (d, i) => (d.validated[i] === 1 ? 0 : d.validated[i] === 0 ? 1 : 2),
      note: "Not checked: often placed at the nearest city",
    },
  ],
  name: (d, i) => d.name[i] || "Unnamed dam",
  where: (d, i) => [d.country[i], d.river[i], d.basin[i] !== d.river[i] && d.basin[i]].filter(Boolean).join(" · "),
};

/** All the vector maps, in the checklist's order. */
export const VECTOR_MAPS: VectorMap[] = [DAMS as unknown as VectorMap];

const loaded = new Map<string, Promise<PointData>>();
/** A map's data (loaded once). */
export function loadVectorMap(m: VectorMap): Promise<PointData> {
  let p = loaded.get(m.id);
  if (!p) {
    p = fetch(m.url)
      .then((res) => {
        if (!res.ok) throw new Error(`${m.title}: ${res.status} ${res.statusText}`);
        return res.json();
      })
      .then((json) => m.parse(json));
    // (A failed load is tried again next time.)
    p.catch(() => loaded.delete(m.id));
    loaded.set(m.id, p);
  }
  return p;
}

/** The dams' data (loaded once: the same as their map's). */
export const damsData = () => loadVectorMap(DAMS as unknown as VectorMap) as Promise<Dams>;
