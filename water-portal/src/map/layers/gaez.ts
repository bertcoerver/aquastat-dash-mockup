/*
 * GAEZ v5 (FAO and IIASA's Global Agro-Ecological Zones) maps for the Local view. They have
 * no time: each is one raster, or a difference of two, drawn by WaPOR's raster layer
 * (wapor.ts) from the same kind of COGs in another bucket. All in % of the pixel's area:
 *
 * - Cropland and irrigated cropland: LR-LCC's shares of land cover classes LC02 and LC12,
 *   ~1 km (30″). Irrigated is area equipped for irrigation (Mehta et al., 2024), and is
 *   the same raster as GAEZ's map LR-IRR, "share of irrigated land" (the Water Portal's
 *   Infrastructure layer). Its catalogue says that's a share of cropland; it's of the pixel.
 * - Rain-fed cropland: LC02 − LC12 (irrigated cropland is part of cropland).
 * - Harvested area in 2020 (RES06-HAR), ~10 km (5′), of a crop or group of crops, on
 *   irrigated, rain-fed or all cropland: ha per pixel, shown as % of the pixel's area, so
 *   it compares with the cropland. Land harvested twice a year counts twice.
 *
 * Catalogue: https://data.apps.fao.org/gismgr/api/v2/catalog/workspaces/GAEZ-V5/mapsets/LR-LCC
 * (RES06-HAR). Model documentation: https://github.com/un-fao/gaezv5/wiki
 */
import type { WaporVariable, RasterSum } from "./wapor";
import type { WaporRamp } from "./wapor-shader";

const BUCKET = "https://storage.googleapis.com/fao-gismgr-gaez-v5-data/DATA/GAEZ-V5/MAPSET";

const rasterUrl = (mapset: string, code: string) => `${BUCKET}/${mapset}/GAEZ-V5.${mapset}.${code}.tif`;

/**
 * A crop of RES06-HAR, by its code there: one of its 33 classes, or a group of them
 * (ALL, MAJ, CER, OIL, RTS; its own raster, the sum of its classes'). Some classes are
 * several crops (fruits and nuts, pulses, other vegetables, …), but not a group.
 */
export interface GaezCrop {
  code: string;
  label: string;
  /** The group it's in (the nearest; none: all crops). */
  parent: string | null;
  /** A group of classes. */
  group: boolean;
  /** How deep in the groups (all crops: 0). */
  depth: number;
}

/**
 * The classes in their groups, from the GAEZ v5 Model Documentation, Appendix 4-1
 * (https://github.com/un-fao/gaezv5/wiki/14.-Appendix-4%E2%80%901-Crops, its RES06
 * sheet): all crops 1–33; major crops 1–9, 11, 12, 14–20, 22–24; cereals 1–7; oil crops
 * 14–20; roots and tubers 8–9 (not 10, yams and other roots). So the major crops hold
 * the cereals, oil crops and roots and tubers. Groups first, then by name.
 */
type Node = [code: string, label: string, children: Node[] | null];
const TREE: Node = [
  "ALL",
  "All crops",
  [
    [
      "MAJ",
      "Major crops",
      [
        ["CER", "Cereals", [["BRL", "Barley", null], ["MZE", "Maize", null], ["MLT", "Millet", null], ["OCE", "Other cereals (oats, rye, …)", null], ["RCW", "Rice", null], ["SRG", "Sorghum", null], ["WHE", "Wheat", null]]],
        ["OIL", "Oil crops", [["CON", "Coconut", null], ["GRD", "Groundnut", null], ["OLP", "Oil palm", null], ["RSD", "Rapeseed", null], ["SES", "Sesame", null], ["SOY", "Soybean", null], ["SFL", "Sunflower", null]]],
        ["RTS", "Roots and tubers", [["CSV", "Cassava", null], ["POT", "Potato and sweet potato", null]]],
        ["BAN", "Banana and plantain", null],
        ["COT", "Cotton", null],
        ["SUB", "Sugar beet", null],
        ["SUC", "Sugarcane", null],
        ["TOB", "Tobacco", null],
      ],
    ],
    ["COC", "Cocoa", null],
    ["COF", "Coffee", null],
    ["FDD", "Fodder crops", null],
    ["FRT", "Fruits and nuts", null],
    ["OOC", "Olives and minor oil crops", null],
    ["NES", "Other crops (spices, fibres, …)", null],
    ["PLS", "Pulses", null],
    ["RUB", "Rubber", null],
    ["TEA", "Tea and maté", null],
    ["TOM", "Tomato", null],
    ["OVG", "Vegetables (but tomato)", null],
    ["ORT", "Yams and other roots", null],
  ],
];
const flatten = ([code, label, children]: Node, parent: string | null, depth: number): GaezCrop[] => [
  { code, label, parent, group: Boolean(children), depth },
  ...(children ?? []).flatMap((c) => flatten(c, code, depth + 1)),
];
/** Every crop and group, as a tree read top to bottom (a group before its own). */
export const GAEZ_CROPS: GaezCrop[] = flatten(TREE, null, 0);

export const gaezCrop = (code: string) => GAEZ_CROPS.find((c) => c.code === code) ?? GAEZ_CROPS[0];

/** Whether a crop is `code` or in it (a group, at any depth). */
export function gaezCropIn(crop: string, code: string): boolean {
  for (let c: string | null = crop; c; c = gaezCrop(c).parent) if (c === code) return true;
  return false;
}

/** The stops of every map's colours: most pixels are a small share, a few are all of it. */
const STOPS = [0, 1, 5, 10, 25, 50, 100];
const GREENS = ["#ffffe5", "#d9f0a3", "#addd8e", "#78c679", "#41ab5d", "#238443", "#005a32"];
const BLUES = ["#f7fbff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594"];
const BROWNS = ["#ffffe5", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#8c2d04"];

export interface GaezMap {
  id: string;
  label: string;
  /** Where it comes from, under its title. */
  source: string;
  /** The year it's of, above the legend's sections ("": none given). */
  period: string;
  /** Of a crop (a menu of them in the legend). */
  byCrop: boolean;
  ramp: WaporRamp;
  /** Its rasters, each times a factor (of a crop's code, if `byCrop`), and the full-resolution pixel's size in degrees if they're areas (ha). */
  rasters(crop: string): { url: string; factor: number }[];
  perArea?: number;
  /** Its harvested areas by crop (RES06-HAR, for the Local panel's card): on all cropland, irrigated or rain-fed. */
  supply: GaezSupply;
}

/** RES06-HAR's water supplies: all cropland, irrigated, rain-fed. */
export type GaezSupply = "WST" | "WSI" | "WSR";

/** A crop's (or group's) harvested area on a supply, in 1000 ha per 5′ pixel. */
export const gaezHarvestUrl = (supply: GaezSupply, crop: string) => rasterUrl("RES06-HAR", `${crop}.${supply}`);

/** The size of RES06-HAR's pixels, in degrees. */
export const GAEZ_HARVEST_PIXEL = 5 / 60;

const LAND_COVER = "GAEZ v5 (FAO, IIASA): land cover maps with FAOSTAT's cropland";
const HARVESTED = "GAEZ v5 (FAO, IIASA): FAOSTAT's 2019–2021 harvested areas, spread over the cropland";
const lcc = (code: string) => rasterUrl("LR-LCC", code);
const harvested = (supply: GaezSupply) => (crop: string) => [{ url: gaezHarvestUrl(supply, crop), factor: 1000 }];

export const GAEZ_MAPS: GaezMap[] = [
  {
    id: "cropland",
    label: "Cropland",
    source: LAND_COVER,
    period: "",
    byCrop: false,
    ramp: { quantities: STOPS, colors: GREENS },
    rasters: () => [{ url: lcc("LC02"), factor: 1 }],
    supply: "WST",
  },
  {
    id: "irrigated",
    label: "Irrigated cropland",
    source: `${LAND_COVER}; irrigated: area equipped for irrigation, from statistics up to 2015`,
    period: "",
    byCrop: false,
    ramp: { quantities: STOPS, colors: BLUES },
    rasters: () => [{ url: lcc("LC12"), factor: 1 }],
    supply: "WSI",
  },
  {
    id: "rainfed",
    label: "Rain-fed cropland",
    source: `${LAND_COVER}; cropland not equipped for irrigation`,
    period: "",
    byCrop: false,
    ramp: { quantities: STOPS, colors: BROWNS },
    rasters: () => [
      { url: lcc("LC02"), factor: 1 },
      { url: lcc("LC12"), factor: -1 },
    ],
    supply: "WSR",
  },
  {
    id: "harvested",
    label: "Harvested area",
    source: `${HARVESTED}; twice a year counts twice`,
    period: "2020",
    byCrop: true,
    ramp: { quantities: STOPS, colors: GREENS },
    rasters: harvested("WST"),
    perArea: GAEZ_HARVEST_PIXEL,
    supply: "WST",
  },
  {
    id: "harvested-irrigated",
    label: "Harvested area, irrigated",
    source: `${HARVESTED}; twice a year counts twice`,
    period: "2020",
    byCrop: true,
    ramp: { quantities: STOPS, colors: BLUES },
    rasters: harvested("WSI"),
    perArea: GAEZ_HARVEST_PIXEL,
    supply: "WSI",
  },
  {
    id: "harvested-rainfed",
    label: "Harvested area, rain-fed",
    source: `${HARVESTED}; twice a year counts twice`,
    period: "2020",
    byCrop: true,
    ramp: { quantities: STOPS, colors: BROWNS },
    rasters: harvested("WSR"),
    perArea: GAEZ_HARVEST_PIXEL,
    supply: "WSR",
  },
];

/** The unit of every GAEZ map. */
export const GAEZ_UNIT = "% of pixel area";

/** What the raster layer draws for a map (of `crop`, if it's by crop). */
export function gaezSum(map: GaezMap, crop: string): RasterSum {
  const rasters = map.rasters(crop);
  const variable: WaporVariable = {
    id: "GAEZ",
    label: map.label,
    short: map.label,
    unit: "%",
    perPixel: "ha",
    pixel: map.perArea ? "10 km" : "1 km",
    scale: 1,
    kinds: [],
    quality: false,
    ramp: map.ramp,
    zeroEmpty: true,
    perArea: map.perArea,
  };
  const terms = rasters.map(({ url, factor }) => ({ url, factor, name: url.slice(url.lastIndexOf("/") + 1) }));
  return {
    variable,
    terms,
    qualityUrl: null,
    key: `gaez ${terms.map((t) => `${t.factor}*${t.url}`).join(" + ")}`,
    level: "L1",
    l2: null,
    fill: null,
  };
}
