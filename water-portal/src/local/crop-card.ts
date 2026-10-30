/*
 * The Local panel's card of GAEZ's crops (map/layers/gaez.ts): the harvested area of each
 * crop in 2020 in the 5′ pixel at the point (RES06-HAR), one bar per crop, largest first.
 * GAEZ's maps have no time; what they're broken down by is the crop. It's of the GAEZ
 * map checked in the legend, on its water supply (all cropland, irrigated or rain-fed),
 * else of the harvested area on all cropland.
 *
 * - The headline is all crops' area (as % of the pixel and in ha), or the hovered crop's.
 * - As the dams' cards, it drives the map: hovered, its map is previewed (onHover; a
 *   bar hovered only changes the headline). Clicking a bar checks that crop's harvested
 *   area in the legend (onPick); the card's own pin, its map (selection).
 * - With a map by crop checked, its crop's bar is in full colour (a group's: its crops'), the others lighter.
 *
 * The crops' rasters (one folder: read alike, see cog-pixel.ts) are read at once, and
 * kept by supply and point: another crop, or map on the same supply, needs no reads.
 * Plain HTML, redrawn from scratch on every update (thirty bars at most).
 */
import { fmt } from "../basin/variables";
import { GAEZ_CROPS, GAEZ_HARVEST_PIXEL, GAEZ_MAPS, gaezCrop, gaezCropIn, gaezHarvestUrl, type GaezMap, type GaezSupply } from "../map/layers/gaez";
import { fmtArea, pixelArea } from "../map/layers/wapor-variables";
import { byPointer } from "../lib/words";
import type { LngLat } from "../map/places";
import { setProgress } from "../panels/load-bar";
import { cogPixel } from "./cog-pixel";

/** Each crop's harvested area (ha; 0 where there's none), and all crops'. */
interface Harvest {
  crops: { code: string; label: string; ha: number }[];
  all: number;
  /** The pixel's area, m². */
  area: number;
}

const SUPPLY: Record<GaezSupply, string> = { WST: "", WSI: "irrigated ", WSR: "rain-fed " };
/** RES06-HAR's classes, not its groups: together, all crops. */
const CROPS = GAEZ_CROPS.filter((c) => !c.group);

/** The card's map when none is checked: harvested area on all cropland. */
const HARVESTED = GAEZ_MAPS.find((g) => g.id === "harvested")!;

/** A GAEZ map, and the crop it's of (if it's by crop). */
export interface CropMap {
  map: GaezMap;
  crop: string;
}

export interface CropCard {
  /** The GAEZ map checked (null: none), the legend's crop, and the point (null: none picked); off: hidden (not the Local view). */
  set(checked: GaezMap | null, crop: string, lngLat: LngLat | null, on: boolean): void;
  /** The card's map and crop, for its pin. */
  selection(): CropMap;
}

/** `el`: the card; `onHover` runs as it's hovered (null: left), `onPick` when a bar is clicked. */
export function initCropCard(el: HTMLElement, onHover: (shown: CropMap | null) => void, onPick: (shown: CropMap) => void): CropCard {
  const $ = (cls: string) => el.querySelector<HTMLElement>(cls)!;
  const empty = $(".cc-empty");
  const message = $(".cc-message");
  const head = $(".cc-head");
  const chart = $(".cc-chart");
  const caption = $(".cc-caption");

  /** Reads by supply and point; one given up on (the point moved on) is read again if asked for. */
  const cache = new Map<string, { harvest: Promise<Harvest>; signal: AbortSignal; done: boolean }>();
  let loading: AbortController | null = null;
  let gaez: GaezMap = HARVESTED;
  let checked = false;
  let on = false;
  let crop = "";
  let lngLat: LngLat | null = null;
  let harvest: Harvest | null = null;
  let error = "";
  let loadingKey = "";
  let hover: string | null = null;

  function read(supply: GaezSupply, at: LngLat, signal: AbortSignal): Promise<Harvest> {
    const key = `${supply} ${at}`;
    let known = cache.get(key);
    if (!known || (known.signal.aborted && !known.done)) {
      // (1000 ha a pixel; none: no crop there.)
      const ha = (code: string) => cogPixel(gaezHarvestUrl(supply, code), at, signal).then((v) => (v === null ? 0 : v * 1000));
      const task = `local-crops:${key}`;
      let done = 0;
      const crops = Promise.all(
        CROPS.map(async ({ code, label }) => {
          const value = await ha(code);
          setProgress(task, ++done / CROPS.length);
          return { code, label, ha: value };
        }),
      );
      const harvest = Promise.all([crops, ha("ALL")]).then(([crops, all]) => ({ crops, all, area: pixelArea([GAEZ_HARVEST_PIXEL, GAEZ_HARVEST_PIXEL], at[1]) }));
      const entry = (known = { harvest, signal, done: false as boolean });
      harvest
        .then(
          () => (entry.done = true),
          () => cache.get(key) === entry && cache.delete(key),
        )
        .finally(() => setProgress(task, null));
      cache.set(key, known);
    }
    return known.harvest;
  }

  function sync() {
    const key = on && lngLat ? `${gaez.supply} ${lngLat}` : "";
    if (key === loadingKey) return render();
    loadingKey = key;
    loading?.abort(); // (the reads for the last point, if still going)
    harvest = null;
    error = "";
    render();
    if (!key || !lngLat) return;
    const controller = (loading = new AbortController());
    read(gaez.supply, lngLat, controller.signal).then(
      (next) => {
        if (loadingKey !== key) return;
        harvest = next;
        render();
      },
      (err: Error) => {
        if (loadingKey !== key) return;
        error = `Couldn't read the harvested areas at this point: ${err.message}`;
        render();
      },
    );
  }

  function render() {
    el.hidden = !on;
    if (!on) return;
    const supply = SUPPLY[gaez.supply];
    $(".cc-title").textContent = `Harvested ${supply}area by crop`;
    empty.hidden = Boolean(lngLat);
    message.textContent = error;
    message.hidden = !error;
    const ready = harvest && !error;
    for (const part of [head, chart, caption]) part.hidden = !ready;
    if (!harvest || error) return;

    const { crops, all, area } = harvest;
    const pct = (ha: number) => (ha * 1e6) / area;
    const color = gaez.ramp.colors[5];
    // The crop on the map, or group (all crops: none singled out).
    const own = checked && gaez.byCrop && crop && crop !== "ALL" ? crop : null;
    const mapped = (code: string) => own !== null && gaezCropIn(code, own);
    const shown = crops.filter((c) => c.ha > 0).sort((a, b) => b.ha - a.ha);
    const top = Math.max(...shown.map((c) => c.ha), 1e-9);

    const hovered = shown.find((c) => c.code === hover);
    const [label, ha] = hovered ? [hovered.label, hovered.ha] : ["All crops", all];
    head.innerHTML = `
      <div class="yb-period">${label}, 2020</div>
      <div class="yb-value"><span class="yb-number">${fmt(pct(ha))}</span> <span class="yb-unit">% of the pixel</span>
        <span class="yb-vs">${fmtArea(ha * 1e4)} of ${fmtArea(area)}</span></div>`;
    chart.innerHTML = shown.length
      ? shown
          .map((c) => {
            const opacity = own === null || mapped(c.code) ? 1 : c.code === hover ? 0.75 : 0.45;
            return `<div class="cc-row${mapped(c.code) ? " cc-own" : ""}" data-crop="${c.code}">
              <span class="cc-label" title="${c.label}">${c.label}</span>
              <span class="cc-track"><span class="cc-bar" style="width:${(100 * c.ha) / top}%;background:${color};opacity:${opacity}"></span></span>
              <span class="cc-value">${fmt(pct(c.ha))}%</span></div>`;
          })
          .join("")
      : `<p class="ch-empty">No ${supply}crops harvested in this pixel in 2020.</p>`;
    caption.textContent =
      `Each crop's ${supply}harvested area in 2020, as % of the ${fmtArea(area)} pixel (5′, about 10 km) at this point: ` +
      "FAOSTAT's 2019–2021 averages, spread over the cropland by GAEZ v5. Land harvested twice a year counts twice, so they can add up to more than the cropland. " +
      (own ? (gaezCrop(own).group ? `The ${gaezCrop(own).label.toLowerCase()} on the map are in full colour. ` : `The crop on the map is in full colour (${gaezCrop(own).label.toLowerCase()}). `) : "") +
      byPointer("Hover a bar to read it, click it to show that crop on the map.", "Tap a bar to show that crop on the map.");
  }

  /** A crop's harvested area on the card's supply. */
  const ofCrop = (code: string): CropMap => ({ map: gaez.byCrop ? gaez : GAEZ_MAPS.find((g) => g.byCrop && g.supply === gaez.supply)!, crop: code });
  const selection = (): CropMap => ({ map: gaez, crop });

  // The card's map; a bar's crop only in the headline.
  el.addEventListener("pointerover", (e) => {
    const next = (e.target as Element).closest<HTMLElement>("[data-crop]")?.dataset.crop ?? null;
    onHover(selection());
    if (next === hover) return;
    hover = next;
    render();
  });
  el.addEventListener("pointerleave", () => {
    onHover(null);
    hover = null;
    render();
  });
  chart.addEventListener("click", (e) => {
    const code = (e.target as Element).closest<HTMLElement>("[data-crop]")?.dataset.crop;
    if (code) onPick(ofCrop(code));
  });

  return {
    set(nextChecked, nextCrop, nextLngLat, nextOn) {
      const next = nextChecked ?? HARVESTED;
      const same = next === gaez && Boolean(nextChecked) === checked && nextCrop === crop && nextOn === on &&
        (nextLngLat === lngLat || (!!nextLngLat && !!lngLat && nextLngLat[0] === lngLat[0] && nextLngLat[1] === lngLat[1]));
      if (same) return;
      gaez = next;
      checked = Boolean(nextChecked);
      crop = nextCrop;
      lngLat = nextLngLat;
      on = nextOn;
      sync();
    },
    selection,
  };
}
