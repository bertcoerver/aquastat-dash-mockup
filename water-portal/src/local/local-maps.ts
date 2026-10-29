/*
 * The Local view's legend, as the Country and Basin views' (panels/legend.ts): its title
 * is a checklist of the maps, WaPOR's variables and the vector maps (vector-maps.ts)
 * under their groups, and each map on the map has a section. Each map has the icons of
 * how it can be drawn to its right: WaPOR's as a raster only, a vector map's amount as
 * circles or 3D bars, its other attributes as circles. One map per way of drawing
 * (shape-switch.ts): checked or switched into a slot another map is in, it takes it, and
 * the other moves to the slot it left (or another free one), else goes. So one raster
 * is shown at a time, a WaPOR variable or a GAEZ map (map/layers/gaez.ts), and checking
 * another replaces it.
 *
 * The raster's section has WaPOR's own legend under its title (map/wapor-legend.ts: the
 * source, period, unit and colour range, the quality slider); a GAEZ map's has its key
 * (fixed colours), and those by crop a menu of the crops. A vector map's has a menu
 * of its attributes under its title (one shown at a time), and its key: sizes (a menu of
 * the full size, shape-style.ts), a colour ramp, or classes, whose swatches switch them
 * off on the map. While a range plays its sizes and colours are locked (lockLegend).
 * Hovering a point on the map shows its tooltip: a tile for its map's attribute, and the
 * raster's pixel's under it; hovering the raster, its pixel's (rasterTip).
 *
 * Only WaPOR's variables have time: without one on the map, the date range changes
 * nothing (onTimed), and the Local panel has no time series. A GAEZ map on the map has
 * its own card there instead (onGaez).
 *
 * A card of the Local panel can preview its vector map by an attribute (a dams' card,
 * while hovered: drawn on top in its slot, not checked, the attribute only for the while)
 * or add it (pinned: checked, as if in the legend, the attribute picked as in its menu).
 * The crops' card does the same with a GAEZ map ("gaez:<id>") and a crop. A preview is
 * only on the map: what's told of the maps checked (onTimed, onGaez, the variable for
 * the panel's series) stays as checked.
 */
import type { WaterMap } from "../map/map";
import { WAPOR_VARIABLES, openWapor, waporPixel, waporValueAt, waporVariable, type RasterSum, type WaporPixelValue, type WaporVariable } from "../map/layers/wapor";
import { GAEZ_CROPS, GAEZ_MAPS, GAEZ_UNIT, gaezCrop, gaezSum, type GaezMap } from "../map/layers/gaez";
import { rampColor, type WaporRamp } from "../map/layers/wapor-shader";
import type { Bar } from "../map/layers/bars";
import type { CountrySymbol } from "../map/layers/countries";
import { cssRgb as css, type Color } from "../map/theme";
import { hexToColor, rampScale } from "../basin/variables";
import { initLayerLegend, onePerSlot, toggled, type LegendKey, type LegendLayer, type SizesKey } from "../panels/legend";
import { DEFAULT_STRETCH, fmtStop } from "../panels/ramp-menu";
import { showMapTip, type MapTip, type MapTipRow } from "../panels/map-tip";
import { iconSvg } from "../panels/shape-icons";
import { freeShape, initShapePicks, shapeOptions, shapeSizes, switchShape, type MapShapes, type Shape, type ShapeOption } from "../panels/shape-switch";
import { describeStyle, initShapeStyles, sizeKey, type ShapeStyle } from "../panels/shape-style";
import { setProgress } from "../panels/load-bar";
import type { LngLat } from "../map/places";
import type { SelectedFeature } from "../selection";
import type { View } from "../toolbar/range-rules";
import { VECTOR_MAPS, loadVectorMap, type PointData, type VectorAttribute, type VectorMap } from "./vector-maps";
import { byId as $ } from "../lib/dom";

type Slot = "raster" | "circles" | "bars";
/** The ways of drawing, bottom to top (the raster stays at the bottom: legend.ts's first slot). */
const SLOTS: Slot[] = ["raster", "circles", "bars"];

/** The raster's one way of being drawn. */
const RASTER: ShapeOption = { id: "raster", slot: "raster", icon: "raster", label: "Raster", title: "Pixels, coloured by their value" };

/** The GAEZ maps' heading in the checklist. */
const GAEZ_GROUP = "Cropland (GAEZ)";

/** The radius of a point drawn at one size (a value's colour, or its class), px. */
const POINT_R = 3.5;
/** An amount's points: in one colour, with a white ring. */
const AMOUNT_COLOR = hexToColor("#2c7fb8");

interface Options {
  map: WaterMap;
  /** WaPOR's own legend (wapor-legend.ts), put in the raster's section. */
  wapor: HTMLElement;
  /** The WaPOR variable on the map at first. */
  variable: WaporVariable;
  /** The WaPOR variable on the map, or none (null), and the one checked (not while another raster is previewed). */
  onWapor(variable: WaporVariable | null, checked: WaporVariable | null): void;
  /** The vector maps on the map changed (their ids, each with the attribute shown). */
  onMapped(mapped: Map<string, string>): void;
  /** Whether a map on it has time (a WaPOR variable); always, outside the Local view. */
  onTimed(timed: boolean): void;
  /** The GAEZ map checked (null: none, or not the Local view), and the crop of those by crop. */
  onGaez(gaez: GaezMap | null, crop: string): void;
  /** The WaPOR raster's pixel's tooltip at a point (null: none drawn there); see rasterTip. */
  waporTip(lngLat: LngLat): MapTip | null;
}

export interface LocalMaps {
  setView(view: View): void;
  /**
   * The point under the pointer on the map (its symbol's id; null: none), and where the
   * pointer is on the page and on the map (null: off the globe): the point's tooltip,
   * else the raster's pixel's.
   */
  hover(id: string | null, x: number, y: number, lngLat: LngLat | null): void;
  /** Lock the vector maps' sizes and colours (while a range plays, so the frames compare). */
  lockLegend(): void;
  unlockLegend(): void;
  /**
   * Show a vector map (by id) on top, by an attribute (none: as it is), without checking it, while its card is hovered (null: none);
   * or a GAEZ map ("gaez:<id>") in the raster's slot, of a crop.
   */
  preview(id: string | null, attribute?: string): void;
  /** Check a vector map (by id), if it isn't on the map, and show it by an attribute (none: as it is); or a GAEZ map ("gaez:<id>"), of a crop. */
  add(id: string, attribute?: string): void;
  /** The point a circle or bar stands for (its symbol's id), and where it is; null: not a point (or not loaded). */
  featureAt(id: string): { feature: SelectedFeature; lngLat: LngLat } | null;
}

/** A map on the map: WaPOR's raster for a variable, a GAEZ map, or a vector map. */
type Layer = { id: string; slot: Slot } & (
  | { wapor: WaporVariable; gaez?: undefined; vector?: undefined }
  | { gaez: GaezMap; wapor?: undefined; vector?: undefined }
  | { vector: VectorMap; wapor?: undefined; gaez?: undefined }
);

const waporId = (v: WaporVariable) => `wapor:${v.id}`;
const gaezId = (g: GaezMap) => `gaez:${g.id}`;
const vectorId = (m: VectorMap) => `vector:${m.id}`;


/**
 * A raster pixel's tooltip: its colour (from `ramp`, as the map draws it), its value
 * (times `k`, in `unit`: the legend's units; with one decimal more than the legend's
 * ticks, which have as many as the range its colours span needs, unless `decimals` is
 * given), and where it's from (`source`, e.g. "WaPOR L2") with its full-resolution
 * pixel's size; headed by its `short` name. None for a pixel the map doesn't draw (no
 * data, or hidden by the quality slider).
 */
export function rasterTip(
  at: WaporPixelValue,
  { title, short, ramp, k, unit, source, pixel }: { title: string; short: string; ramp: WaporRamp; k: number; unit: string; source: string; pixel: string },
  decimals?: number,
): MapTip | null {
  if (at.value === null) return null;
  const q = ramp.quantities;
  const v = at.value * k;
  const value =
    decimals === undefined ? fmtStop(v, (Math.abs(q[q.length - 1] - q[0]) * k) / 10) : v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  // (Its short name heads its one tile, which has the full one.)
  return { title: short, source: `${source} · ${pixel}`, rows: [{ color: rampColor(ramp, at.value), value, unit, label: title }] };
}

/**
 * A GAEZ map's fixed colours: its stops evenly along the key, as they aren't evenly
 * spread (0, 1, 5, … 100), with the colours between them as the map has them.
 */
function evenKey({ quantities, colors }: WaporRamp): LegendKey {
  const at = (i: number) => i / (quantities.length - 1);
  return {
    kind: "ramp",
    fixed: true,
    gradient: `linear-gradient(to right, ${colors.map((c, i) => `${c} ${at(i) * 100}%`).join(", ")})`,
    ticks: quantities.map((value, i) => ({ value, at: at(i) })),
    format: (v) => String(v),
  };
}

export function initLocalMaps({ map, wapor, variable, onWapor, onMapped, onTimed, onGaez, waporTip }: Options): LocalMaps {
  /** A drawn point's tile in its tooltip, by its map (its attribute's value there, in its colour). */
  const tiles = new Map<string, (i: number) => MapTipRow>();

  const state = {
    view: "country" as View,
    /** The maps checked, oldest first (the latest in a slot is the one shown). */
    chosen: [waporId(variable)],
    /** Each vector map's attribute, by its id (none: its first). */
    attribute: new Map<string, string>(),
    /** Each vector map's classes switched off in the legend (for the attribute shown). */
    hiddenClasses: new Map<string, Set<number>>(),
    data: new Map<string, PointData>(),
    failed: new Map<string, string>(),
    /** The WaPOR variables last told to onWapor, on the map and checked. */
    waporShown: `${waporId(variable)} ${waporId(variable)}`,
    layers: [] as Layer[],
    /** A vector map previewed by its card (its layer id), drawn last, and the attribute it shows for the while (null: its own). */
    preview: null as string | null,
    previewAttribute: null as string | null,
    /** The vector maps last told to onMapped. */
    mapped: "",
    /** Last told to onTimed. */
    timed: true,
    /** Last told to onGaez (its map and crop). */
    gaezTold: "",
    /** The crop of the GAEZ maps by crop (its code). */
    crop: GAEZ_CROPS[0].code,
    /** Whether a GAEZ map's rasters opened, by its sum's key (failed: tried again when it's checked again). */
    gaezOpen: new Map<string, "opening" | "open" | "failed">(),
  };

  const attributeOf = (m: VectorMap): VectorAttribute<PointData> => {
    const id = state.preview === vectorId(m) && state.previewAttribute ? state.previewAttribute : state.attribute.get(m.id);
    return m.attributes.find((a) => a.id === id) ?? m.attributes[0];
  };
  // How each vector map is drawn: circles or bars for an amount, else circles.
  const shapes = initShapePicks();
  const shapesFor = (m: VectorMap): Shape[] => (attributeOf(m).kind === "amount" ? ["circles", "bars"] : ["circles"]);
  const slotOfVector = (m: VectorMap) => shapes.shape(m.title, shapesFor(m)) as Slot;
  const shapesOf = (l: Pick<Layer, "wapor" | "vector">): MapShapes =>
    l.vector
      ? { title: l.vector.title, options: shapeOptions(shapesFor(l.vector)), current: slotOfVector(l.vector), set: (id) => shapes.set(l.vector!.title, id as Shape) }
      : // (All the variables in the one raster slot.)
        { title: "WaPOR", options: [RASTER], current: RASTER.id, set: () => {} };
  // How an amount's circles or bars look: their full size.
  const styles = initShapeStyles();
  const initialStyle: ShapeStyle = { colours: "map", full: 0.98 };
  const styleOf = (m: VectorMap) => styles.get(m.title, initialStyle, false);

  function layerOf(id: string): Layer | null {
    const [kind, key] = id.split(":");
    if (kind === "wapor") return { id, slot: "raster", wapor: waporVariable(key) };
    if (kind === "gaez") {
      const gaez = GAEZ_MAPS.find((g) => g.id === key);
      return gaez ? { id, slot: "raster", gaez } : null;
    }
    const vector = VECTOR_MAPS.find((m) => m.id === key);
    return vector ? { id, slot: slotOfVector(vector), vector } : null;
  }
  const shownLayers = () => {
    const ids = state.preview ? [...state.chosen.filter((id) => id !== state.preview), state.preview] : state.chosen;
    return onePerSlot(ids.map(layerOf).filter((l): l is Layer => !!l), SLOTS);
  };
  /** The maps on the map as checked (a previewed one only if it was). */
  const checkedIds = () => state.layers.map((l) => l.id).filter((id) => id !== state.preview || state.chosen.includes(id));

  const legend = initLayerLegend($("lp-legend"), {
    slots: SLOTS,
    onOrder: (slots) => map.setLayerOrder("local", slots),
    options() {
      const layers = state.layers;
      const taken = new Set<string>(layers.map((l) => l.slot));
      const icons = (m: MapShapes) => m.options.map((o) => ({ id: o.id, html: iconSvg(o.icon), label: o.label, title: o.title }));
      const raster = shapesOf({});
      return {
        options: [
          ...WAPOR_VARIABLES.map((v) => ({ id: waporId(v), label: v.label, group: "WaPOR", icons: icons(raster), icon: RASTER.id })),
          ...GAEZ_MAPS.map((g) => ({ id: gaezId(g), label: g.label, group: GAEZ_GROUP, icons: icons(raster), icon: RASTER.id })),
          ...VECTOR_MAPS.map((m) => {
            const s = shapesOf({ vector: m });
            const drawn = layers.find((l) => l.vector === m)?.slot;
            return { id: vectorId(m), label: m.title, group: m.group, icons: icons(s), icon: drawn ?? freeShape(s, taken) };
          }),
        ],
        current: layers.map((l) => l.id),
      };
    },
    onToggle(id) {
      // Checked, a vector map is drawn as it was offered.
      const layer = layerOf(id);
      if (layer?.vector && !state.layers.some((l) => l.id === id)) {
        const m = shapesOf(layer);
        m.set(freeShape(m, new Set(state.layers.map((l) => l.slot))));
      }
      state.chosen = toggled(checkedIds(), id);
      draw();
    },
    // An icon: the map switches (the one in the slot it takes moving out of the way), or
    // is added so. Switched, it goes last, so it takes its new slot from the map there.
    onShape(id, shape) {
      const layer = layerOf(id);
      if (!layer) return;
      switchShape(state.layers.map(shapesOf), shapesOf(layer), shape);
      const ids = checkedIds();
      state.chosen = ids.includes(id) ? [...ids.filter((i) => i !== id), id] : [...ids, id];
      draw();
    },
    // (The raster's colour range is WaPOR's legend's own menu.)
    ramp: { of: "the values in view", initial: DEFAULT_STRETCH, onPick: () => {} },
    attributes: {
      options(slot) {
        if (gaezIn(slot)?.byCrop) return { options: GAEZ_CROPS.map((c) => ({ id: c.code, label: c.label, level: c.depth })), current: state.crop };
        const m = vectorIn(slot);
        return m ? { options: m.attributes.map((a) => ({ id: a.id, label: a.label })), current: attributeOf(m).id } : { options: [], current: null };
      },
      onPick(slot, id) {
        // (The crop is the same for each of the maps by crop.)
        if (gaezIn(slot)?.byCrop) {
          if (id === state.crop) return;
          state.crop = id;
          return draw();
        }
        const m = vectorIn(slot);
        if (!m || id === attributeOf(m).id) return;
        setAttribute(m, id);
        draw();
      },
      title: (slot) => {
        if (gaezIn(slot)?.byCrop) return "The crop whose harvested area is on the map. Click for the others.";
        const m = vectorIn(slot);
        return m ? `The ${m.title.toLowerCase()}' ${attributeOf(m).label.toLowerCase()} on the map. Click for their other attributes.` : "";
      },
    },
    sizes: {
      options(slot) {
        const m = vectorIn(slot);
        return m ? styles.menu(m.title, initialStyle, false) : { options: [], current: [] };
      },
      onPick(slot, id) {
        const m = vectorIn(slot);
        if (!m) return;
        styles.pick(m.title, id);
        draw();
      },
      title(slot) {
        const m = vectorIn(slot);
        return m ? describeStyle(styleOf(m), slot as Shape) : "";
      },
    },
    onClass(slot, index) {
      const m = vectorIn(slot);
      if (!m) return;
      const off = state.hiddenClasses.get(m.id) ?? new Set<number>();
      if (!off.delete(index)) off.add(index);
      state.hiddenClasses.set(m.id, off);
      draw();
    },
    onLock: () => draw(),
  });
  /** Show a vector map by another attribute; not an amount, no bars (it moves to the circles, the map there making way). */
  function setAttribute(m: VectorMap, id: string) {
    if (id === attributeOf(m).id) return;
    const amount = m.attributes.find((a) => a.id === id)?.kind === "amount";
    if (!amount && slotOfVector(m) === "bars") switchShape(state.layers.map(shapesOf), shapesOf({ vector: m }), "circles");
    state.attribute.set(m.id, id);
    state.hiddenClasses.delete(m.id);
  }
  /** The crop on the map: one previewed by the crops' card, else the legend's. */
  const cropShown = () => (state.preview?.startsWith("gaez:") && state.previewAttribute) || state.crop;
  const vectorIn = (slot: string) => state.layers.find((l) => l.slot === slot)?.vector;
  const gaezIn = (slot: string) => state.layers.find((l) => l.slot === slot)?.gaez;
  // WaPOR's legend goes under the raster section's title.
  legend.section("raster").extra.append(wapor);
  wapor.hidden = false;

  function load(m: VectorMap) {
    if (state.data.has(m.id)) return;
    const task = `vector:${m.id}`;
    setProgress(task, 0.1, true);
    loadVectorMap(m).then(
      (data) => {
        setProgress(task, null);
        state.data.set(m.id, data);
        state.failed.delete(m.id);
        draw();
      },
      (err: Error) => {
        setProgress(task, null);
        state.failed.set(m.id, err.message);
        draw();
      },
    );
  }

  function draw() {
    const shown = state.view === "local";
    const layers = (state.layers = shownLayers());
    // As checked, without a preview.
    const checked = state.preview ? onePerSlot(state.chosen.map(layerOf).filter((l): l is Layer => !!l), SLOTS) : layers;
    // The raster: the view's own (main.ts), told which variable, or none.
    const raster = layers.find((l) => l.wapor);
    const checkedRaster = checked.find((l) => l.wapor);
    const wanted = `${raster?.id} ${checkedRaster?.id}`;
    if (wanted !== state.waporShown) {
      state.waporShown = wanted;
      onWapor(raster?.wapor ?? null, checkedRaster?.wapor ?? null);
    }
    const mapped = new Map(shown ? layers.filter((l) => l.vector).map((l) => [l.vector!.id, attributeOf(l.vector!).id]) : []);
    const mappedKey = [...mapped].join();
    if (mappedKey !== state.mapped) {
      state.mapped = mappedKey;
      onMapped(mapped);
    }
    const timed = !shown || checked.some((l) => l.wapor);
    if (timed !== state.timed) {
      state.timed = timed;
      onTimed(timed);
    }
    // The GAEZ map, on the map once its rasters have opened.
    const gaez = shown ? layers.find((l) => l.gaez)?.gaez : undefined;
    const sum = gaez && gaezSum(gaez, cropShown());
    const gaezChecked = shown ? checked.find((l) => l.gaez)?.gaez : undefined;
    const gaezKey = gaezChecked ? `${gaezChecked.id} ${state.crop}` : "";
    if (gaezKey !== state.gaezTold) {
      state.gaezTold = gaezKey;
      onGaez(gaezChecked ?? null, state.crop);
    }
    for (const [key, open] of state.gaezOpen) if (open === "failed" && key !== sum?.key) state.gaezOpen.delete(key);
    map.setGaez(gaez && sum && openGaez(sum) === "open" ? { sum, ramp: gaez.ramp } : null);
    if (!shown) {
      legend.show(null);
      map.setSymbols("local", null);
      map.setBars("local", null);
      showTip(null);
      return;
    }
    const symbolLists: CountrySymbol[][] = [];
    const bars: Bar[] = [];
    const sections: LegendLayer[] = [];
    let key = "";
    for (const l of layers) {
      if (l.wapor) {
        sections.push({ slot: l.slot, id: l.id, title: l.wapor.label, note: "", period: "", unit: "", key: null });
        continue;
      }
      if (l.gaez) {
        const g = l.gaez;
        const open = openGaez(gaezSum(g, cropShown()));
        sections.push({
          slot: l.slot,
          id: l.id,
          title: g.label,
          attribute: g.byCrop ? gaezCrop(cropShown()).label : undefined,
          note: g.source,
          period: g.period,
          unit: GAEZ_UNIT,
          key: evenKey(g.ramp),
          status: open === "failed" ? "Couldn't read its rasters from GAEZ's server." : open === "opening" ? "Loading…" : "",
        });
        continue;
      }
      const m = l.vector;
      const attribute = attributeOf(m);
      const data = state.data.get(m.id);
      const section: LegendLayer = { slot: l.slot, id: l.id, title: m.title, attribute: attribute.label, note: m.source, period: "", unit: "", key: null };
      sections.push(section);
      if (!data) {
        load(m);
        section.status = state.failed.has(m.id) ? `Couldn't load the ${m.title.toLowerCase()}: ${state.failed.get(m.id)}` : "Loading…";
        continue;
      }
      const drawn = drawVector(m, attribute, data, l.slot as Exclude<Slot, "raster">);
      Object.assign(section, drawn.section);
      tiles.set(m.id, drawn.tile);
      if (drawn.symbols.length) symbolLists.push(drawn.symbols);
      bars.push(...drawn.bars);
      key += `${drawn.key};`;
    }
    // Small circles on top of big ones (a map's are sorted so already).
    const symbols = symbolLists.length === 1 ? symbolLists[0] : symbolLists.flat().sort((a, b) => b.radius - a.radius);
    map.setSymbols("local", symbols.length ? { key: `${key}:${symbols.length}`, items: symbols } : null);
    map.setBars("local", bars.length ? { key, items: bars } : null);
    legend.show(sections);
  }

  /** Whether a GAEZ map's rasters have opened (opening them, the first time). */
  function openGaez(sum: RasterSum) {
    const known = state.gaezOpen.get(sum.key);
    if (known) return known;
    state.gaezOpen.set(sum.key, "opening");
    const task = `gaez:${sum.key}`;
    setProgress(task, 0.1, true);
    const done = (open: "open" | "failed") => {
      setProgress(task, null);
      state.gaezOpen.set(sum.key, open);
      draw();
    };
    openWapor(sum).then(() => done("open"), () => done("failed"));
    return "opening";
  }

  /** A vector map's circles or bars, for its attribute, its points' tooltips, and its section's key and note. */
  interface DrawnVector {
    key: string;
    symbols: CountrySymbol[];
    bars: Bar[];
    tile: (i: number) => MapTipRow;
    section: Partial<LegendLayer>;
  }
  /**
   * The last few maps drawn, by key: a redraw that changes nothing about a map (a card
   * hovered, say) doesn't build its thousands of points again.
   */
  const drawnVectors = new Map<string, DrawnVector>();
  function drawVector(m: VectorMap, a: VectorAttribute<PointData>, d: PointData, slot: "circles" | "bars"): DrawnVector {
    const off = state.hiddenClasses.get(m.id) ?? new Set<number>();
    const style = styleOf(m);
    const key = `${m.id}:${a.id}:${slot}:${style.full}:${[...off].sort().join(",")}:${legend.lockKey()}`;
    let drawn = drawnVectors.get(key);
    if (!drawn) {
      const symbols: CountrySymbol[] = [];
      const bars: Bar[] = [];
      const { tile, section } = buildVector(m, a, d, slot, off, style, symbols, bars);
      // Small circles on top of big ones.
      symbols.sort((x, y) => y.radius - x.radius);
      drawn = { key, symbols, bars, tile, section };
      drawnVectors.set(key, drawn);
      for (const old of drawnVectors.keys()) {
        if (drawnVectors.size <= 6) break;
        drawnVectors.delete(old);
      }
    }
    return drawn;
  }
  function buildVector(m: VectorMap, a: VectorAttribute<PointData>, d: PointData, slot: "circles" | "bars", off: Set<number>, style: ShapeStyle, symbols: CountrySymbol[], bars: Bar[]) {
    const position = (i: number): [number, number] => [d.lon[i], d.lat[i]];
    // (How many are drawn, and what to know about the attribute, under the key.)
    const status = (shown: number) => [`${shown.toLocaleString("en-US")} of ${d.count.toLocaleString("en-US")} ${m.title.toLowerCase()} shown.`, a.note && `${a.note}.`].filter(Boolean).join(" ");

    if (a.kind === "amount") {
      // Circles (area) or bars (height) by the value, the style's at full size (locked: as
      // when the lock was put on); those without a value (or of 0) aren't drawn.
      const values = Array.from({ length: d.count }, (_, i) => a.value(d, i) ?? Number.NaN);
      const size = shapeSizes(values, style.full, (ref) => legend.hold(`${m.id}:${a.id}:${slot}:${style.full}`, ref), true);
      let shown = 0;
      values.forEach((v, i) => {
        if (!(v > 0)) return;
        shown++;
        const id = `${m.id}:${i}`;
        if (slot === "circles") symbols.push({ id, position: position(i), radius: size.radius(v), fill: [...AMOUNT_COLOR.slice(0, 3), 170] as Color, line: [255, 255, 255, 220] });
        else bars.push({ id, position: position(i), height: size.height(v), color: AMOUNT_COLOR });
      });
      const sizes: SizesKey = sizeKey(slot, size, () => css(AMOUNT_COLOR, slot === "circles" ? 0.7 : 1), false);
      const tile = (i: number): MapTipRow => ({ color: css(AMOUNT_COLOR), value: values[i].toLocaleString("en-US"), unit: a.unit, label: a.label });
      return { tile, section: { unit: a.unit, sizes, status: status(shown) } };
    }

    // One size, coloured by the value or the class.
    let colorOf: (i: number) => Color | null;
    let legendKey: LegendKey;
    let tile: (i: number) => MapTipRow;
    if (a.kind === "value") {
      const values = Array.from({ length: d.count }, (_, i) => a.value(d, i) ?? Number.NaN);
      let scale = rampScale({ ramp: a.ramp, scale: "linear" }, values);
      const domain = scale.ticks.length ? legend.hold(`${m.id}:${a.id}`, scale.domain) : scale.domain;
      if (domain !== scale.domain) scale = rampScale({ ramp: a.ramp, scale: "linear" }, values, domain);
      colorOf = (i) => scale.color(values[i]);
      // (A year, as it is: 1960, not 1,960.)
      legendKey = { kind: "ramp", gradient: scale.gradient, ticks: scale.ticks, format: a.unit ? undefined : (v) => String(Math.round(v)) };
      tile = (i) => ({ color: css(colorOf(i) ?? AMOUNT_COLOR), value: a.unit ? values[i].toLocaleString("en-US") : String(values[i]), unit: a.unit, label: a.label });
    } else {
      const classes = Array.from({ length: d.count }, (_, i) => a.classOf(d, i));
      const present = new Set(classes);
      const colors = a.classes.map((k) => hexToColor(k.color));
      colorOf = (i) => (off.has(classes[i]) ? null : colors[classes[i]]);
      legendKey = {
        kind: "classes",
        items: a.classes.map((k, i) => ({ label: k.label, background: k.color, state: !present.has(i) ? "absent" : off.has(i) ? "off" : "on" })),
      };
      tile = (i) => ({ color: a.classes[classes[i]].color, value: a.classes[classes[i]].label, unit: "", label: a.label });
    }
    let shown = 0;
    for (let i = 0; i < d.count; i++) {
      const c = colorOf(i);
      if (!c) continue;
      shown++;
      symbols.push({ id: `${m.id}:${i}`, position: position(i), radius: POINT_R, fill: [c[0], c[1], c[2], 230], line: [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55, 240] });
    }
    return { tile, section: { unit: a.kind === "value" ? a.unit : "", key: legendKey, status: status(shown) } };
  }

  // The point under the pointer: its name, where it is, its map's tile, and the raster's
  // pixel's there (at the point); else the raster's pixel's under the pointer.
  const tooltip = $("lp-tooltip");
  // (The same tooltip as shown, on the same point or pixel, isn't written again on every move.)
  let tipShown = "";
  function showTip(tip: MapTip | null) {
    const key = tip ? JSON.stringify(tip) : "";
    if (key === tipShown && !tooltip.hidden === !!tip) return;
    tipShown = key;
    showMapTip(tooltip, tip);
  }
  function hover(id: string | null, x: number, y: number, lngLat: LngLat | null) {
    const [mapId, index] = id?.split(":") ?? [];
    const i = Number(index);
    const m = VECTOR_MAPS.find((v) => v.id === mapId);
    const data = m && state.data.get(m.id);
    const tile = state.view === "local" && m && data ? tiles.get(m.id) : undefined;
    let tip: MapTip | null = null;
    if (tile && m && data) {
      const under = rasterAt([data.lon[i], data.lat[i]]);
      tip = { title: m.name(data, i), source: m.where(data, i) || m.title, rows: [tile(i), ...(under?.rows ?? [])] };
    } else if (state.view === "local" && lngLat) tip = rasterAt(lngLat);
    showTip(tip);
    tooltip.style.left = `${x + 14}px`;
    tooltip.style.top = `${y + 14}px`;
  }

  /** The raster's pixel's tooltip at a point: the GAEZ map's, or WaPOR's (null: none drawn there). */
  function rasterAt(lngLat: LngLat): MapTip | null {
    const raster = state.layers.find((l) => l.slot === "raster");
    if (raster?.wapor) return waporTip(lngLat);
    const g = raster?.gaez;
    if (!g) return null;
    const sum = gaezSum(g, cropShown());
    const at = state.gaezOpen.get(sum.key) === "open" ? waporValueAt(sum, lngLat, null) : null;
    if (!at) return null;
    const title = g.byCrop ? `${g.label}: ${gaezCrop(cropShown()).label}` : g.label;
    const pixel = waporPixel(sum.variable, at.level);
    // (Shares of a pixel, 0–100 %: one decimal, as small ones matter.)
    return rasterTip(at, { title, short: g.label, ramp: g.ramp, k: 1, unit: GAEZ_UNIT, source: "GAEZ v5", pixel }, 1);
  }

  return {
    setView(view) {
      if (view === state.view) return;
      state.view = view;
      draw();
    },
    hover,
    preview(id, attribute) {
      const next = id && (id.startsWith("gaez:") ? id : `vector:${id}`);
      const nextAttribute = (next && attribute) || null;
      if (next === state.preview && nextAttribute === state.previewAttribute) return;
      state.preview = next;
      state.previewAttribute = nextAttribute;
      draw();
    },
    add(id, attribute) {
      // A GAEZ map: checked last, so it's the raster (the crop as picked in its menu).
      if (id.startsWith("gaez:")) {
        state.previewAttribute = null;
        state.layers = shownLayers();
        if (attribute) state.crop = attribute;
        state.chosen = [...checkedIds().filter((i) => i !== id), id];
        return draw();
      }
      const m = VECTOR_MAPS.find((v) => v.id === id)!;
      const own = vectorId(m);
      // The attribute picked as in its menu (the one previewed is now its own), then checked
      // as in the legend: in a free slot, if there is one.
      state.previewAttribute = null;
      state.layers = shownLayers();
      if (attribute) setAttribute(m, attribute);
      if (!(state.chosen.includes(own) && state.layers.some((l) => l.id === own))) {
        const s = shapesOf({ vector: m });
        s.set(freeShape(s, new Set(state.layers.filter((l) => l.id !== own).map((l) => l.slot))));
        state.chosen = [...checkedIds().filter((i) => i !== own), own];
      }
      draw();
    },
    featureAt(id) {
      const [mapId, index] = id.split(":");
      const m = VECTOR_MAPS.find((v) => v.id === mapId);
      const data = m && state.data.get(m.id);
      const i = Number(index);
      if (!m || !data || !(i >= 0 && i < data.count)) return null;
      return { feature: { map: m.id, index: i, name: m.name(data, i) }, lngLat: [data.lon[i], data.lat[i]] };
    },
    lockLegend: () => legend.lock(),
    unlockLegend: () => legend.unlock(),
  };
}
