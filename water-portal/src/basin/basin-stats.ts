/*
 * Basin view: the statistics in the water balance panel, after the Country panel
 * (country/country-panel.ts): the topics' number tiles and chart cards
 * (stats-cards.ts), all in one column, about the selected major basin or, with none
 * selected, the World. All over the top bar's date range, compared with the same days in the other
 * years of the record.
 *
 * Every tile and card has a map: hovering previews it, clicking pins it
 * (map-drivers.ts); unpinned, the map shows the one picked in the legend, else the
 * first tile. Unless a sub-basin is selected and the water balance model is
 * shown (water-balance.ts, MODEL_SHOWN): then it shows the model's, which this hands
 * the map back to. Within a card, hovering a row picks out its basins on the map (a
 * group's, a basin, a sub-basin outlined), hovering a series in a legend maps that
 * series, and clicking a year on a chart of the same days every year selects that year.
 * Hovering a basin on the map shows its value. A switch in a map's legend section draws
 * it as the basins' colours, circles or 3D bars (panels/shape-switch.ts), except where
 * a map has its own (the scheme's, the rain and vapour's); the key of the circles' and
 * bars' sizes is a menu of how they look (panels/shape-style.ts: the map's colours or by
 * sign, the full size). Storage change's stand on the sub-basins' rivers, and it's first
 * drawn as circles, green rising and red falling.
 *
 * The legend's title is a menu of all the maps. Its unit is a menu too, as the WaPOR
 * legend's: per day, month or year, or in total over the period; per m² or over the
 * basin. The map and the charts follow it (the model's discharge and storage change keep
 * theirs, m³/s). And the ramp is a menu of how much of the basins' values the colours
 * span (panels/ramp-menu.ts).
 */
import type { WaterMap } from "../map/map";
import { flyTo, type Extent } from "../map/fly-to";
import type { Place } from "../map/places";
import type { SubBasin } from "../map/sub-basin-network";
import { mixColor, type Color } from "../map/theme";
import { unlessLoading } from "../panels/load-bar";
import { initDrivers, markDrivers, type Driver } from "../panels/map-drivers";
import { initLayerLegend, onePerSlot, toggled, type LegendKey, type LegendLayer, type SizesKey } from "../panels/legend";
import { DEFAULT_STRETCH } from "../panels/ramp-menu";
import type { Selection } from "../selection";
import type { MajorBasin } from "../toolbar/place-picker";
import { WAPOR_MIN_YEAR, fmtEnd, fmtStart, mk } from "../toolbar/dekads";
import { basinLastDekad, daysOfDekads, type DekadRange, type View } from "../toolbar/range-rules";
import { inGroup, setBasinGroups, type BasinGroups } from "./groups";
import { loadMajorFluxes, loadSubBasinFluxes, type FluxSeries } from "./model";
import { MODEL_SHOWN } from "./water-balance";
import { initSchemeMap } from "./scheme-map";
import { initEffectsMap } from "./effects-map";
import { loadMiddles } from "./rivers";
import { SHAPE_NOTES, SHAPES, freeShape, initShapePicks, shapeOptions, shapeSizes, switchShape, type MapShapes, type Shape } from "../panels/shape-switch";
import { iconSvg } from "../panels/shape-icons";
import { describeStyle, initShapeStyles, signColor, sizeKey, type ShapeStyle } from "../panels/shape-style";
import type { Bar } from "../map/layers/bars";
import type { CountrySymbol } from "../map/layers/countries";
import {
  BASIN_UNITS,
  TOPICS,
  describeUnit,
  parseArea,
  sameDays,
  tileMap,
  tileValue,
  unitMenu,
  windowLabel,
  type BasinCtx,
  type BasinMapSpec,
  type BasinTile,
  type BasinUnits,
  type FluxStatus,
  type MeasureKey,
  type TopicDef,
} from "./stats-cards";
import { loadSeries, monthlyStats, periodStats, windowRates, type Monthly, type PeriodStats, type WaporSeries, type WindowRates } from "./stats-data";
import { fmt, rampScale, type ColorScale } from "./variables";

interface Options {
  map: WaterMap;
  majorBasins: MajorBasin[];
  subBasins: SubBasin[];
  /** The major basins' groups (by climate, by where the water goes). */
  groups: BasinGroups;
  /** The water balance panel: it shows the model's map unless a chart takes over. */
  setMapOverride(override: boolean): void;
  /** Select a range in the top bar (from clicking a year on a chart). */
  setRange(range: DekadRange): void;
}

export interface BasinStats {
  setView(view: View): void;
  setRange(range: DekadRange): void;
  setSelection(selection: Selection): void;
  /** What is under the pointer on the map (null: nothing). */
  hover(place: Place | null): void;
  /** Lock the legend's ranges (when a range starts playing, so the dekads compare). */
  lockLegend(): void;
  /** Let the legend's ranges fit the values again (when it stops). */
  unlockLegend(): void;
}

/**
 * How the maps are drawn, in the legend's order: fills, circles, bars, the scheme's
 * discharge lines, precipitation as rain, evapotranspiration as vapour.
 */
const SLOTS = ["fill", "circles", "bars", "lines", "rain", "vapour"];
const isShape = (l: { slot: string }) => l.slot === "circles" || l.slot === "bars";
const isScheme = (l: { slot: string }) => l.slot === "lines";
const isEffect = (l: { slot: string }) => l.slot === "rain" || l.slot === "vapour";

/** A map on the map: its tile or card, and how it's drawn (the legend's slot). */
interface Layer {
  d: Driver;
  spec: BasinMapSpec;
  slot: string;
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; series: WaporSeries };

const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The first dekad of the WaPOR record. */
const FIRST_DK = mk(WAPOR_MIN_YEAR, 0, 0);

export function initBasinStats({ map, majorBasins, subBasins, groups, setMapOverride, setRange }: Options): BasinStats {
  setBasinGroups(groups);
  const majorNames = new Map(majorBasins.map((b) => [b.id, b.name]));
  const subNames = new Map(subBasins.map((b) => [b.id, b.name]));
  const majorIds = majorBasins.map((b) => b.id);
  const majorBoxes = new Map(majorBasins.map((b) => [b.id, b.bbox]));
  const subBoxes = new Map(subBasins.map((b) => [b.id, b.bbox]));
  const state = {
    view: "country" as View,
    range: null as DekadRange | null,
    selection: null as Selection | null,
    /** The WaPOR series, loaded once: every range is summed from them. */
    status: { kind: "idle" } as Status,
    /** Pins and the legend's picks, per scope ("world", "major"). */
    pinned: new Map<string, Driver>(),
    /** The maps checked in the legend, oldest first (none: the first tile's). */
    chosen: new Map<string, string[]>(),
    hover: null as Place | null,
    /** The model's output: "majors" (per major basin) or a major basin's id (its sub-basins). */
    fluxes: new Map<string, FluxStatus>(),
    /** Totals in mm by default, as before there was a choice. */
    units: BASIN_UNITS[3] as BasinUnits,
    /** The measures mapped against the other years. */
    against: new Set<MeasureKey>(),
    /** How much of the basins' values the colours span (% cut at either end). */
    stretch: DEFAULT_STRETCH,
  };
  const section = $("bs-section");
  const cardsEl = $("bs-cards");
  const tilesEl = $("bs-stats");
  const tooltip = $("bs-tooltip");
  let current: { ctx: BasinCtx; layers: Layer[]; csv: Map<string, (string | number)[][]> } | null = null;

  // Folded with no chart pinned, the pane shows none of its tiles and cards: they're
  // drawn once it opens (not at every step of a range being played, say).
  const pane = section.closest<HTMLElement>(".wb-panel")!;
  const unseen = () => pane.classList.contains("resting") && !state.pinned.get(scope());
  let stale = false;
  new MutationObserver(() => stale && !unseen() && render()).observe(pane, { attributeFilter: ["class"] });

  // The legend's title: a checklist of all the maps, each once, in the order of the tiles
  // and cards, with the icons of how each can be drawn; each one on the map has a section
  // (panels/legend.ts). A map not on the map is offered in a free slot, if there is one.
  // Checking one unpins the chart that was pinned (its map stays checked).
  const legend = initLayerLegend($("bs-legend"), {
    slots: SLOTS,
    onOrder: (slots) => map.setLayerOrder("basin", slots),
    options() {
      if (!current) return { options: [], current: [] };
      const ctx = current.ctx;
      const on = current.layers.map((l) => optionId(ctx, l.spec));
      const taken = new Set(current.layers.map((l) => l.slot));
      const options = menuMaps(ctx).map(({ id, spec }) => {
        const m = shapesOf(spec, ctx);
        const icons = m.options.map((o) => ({ id: o.id, html: iconSvg(o.icon), label: o.label, title: o.title }));
        return { id, label: spec.title, icons, icon: on.includes(id) ? m.current : freeShape(m, taken) };
      });
      return { options, current: on };
    },
    onToggle(id) {
      if (!current) return;
      const ctx = current.ctx;
      const spec = menuMaps(ctx).find((m) => m.id === id)?.spec;
      // Checked, it's drawn as it was offered.
      if (spec && !current.layers.some((l) => optionId(ctx, l.spec) === id)) {
        const m = shapesOf(spec, ctx);
        m.set(freeShape(m, new Set(current.layers.map((l) => l.slot))));
      }
      toggle(id);
    },
    // An icon: the map switches (the one in the slot it takes moving out of the way), or
    // is added so.
    onShape(id, shape) {
      if (!current) return;
      const ctx = current.ctx;
      const spec = menuMaps(ctx).find((m) => m.id === id)?.spec;
      if (!spec) return;
      switchShape(current.layers.map((l) => shapesOf(l.spec, ctx)), shapesOf(spec, ctx), shape);
      if (!current.layers.some((l) => optionId(ctx, l.spec) === id)) return toggle(id);
      switched((s) => s.title === spec.title);
      drawMap();
    },
    // How much of the basins' values the colours span: a menu on the ramp.
    ramp: {
      of: "the basins' values",
      initial: state.stretch,
      onPick(cut) {
        state.stretch = cut;
        drawMap();
      },
    },
    // The unit (the same for all maps in mm or km³), or against the other years (per measure).
    units: {
      options(slot) {
        const layer = current?.layers.find((l) => l.slot === slot);
        return layer ? unitMenu(current!.ctx, layer.spec) : { options: [], current: null };
      },
      onPick(slot, id) {
        const layer = current?.layers.find((l) => l.slot === slot);
        if (!layer) return;
        const m = layer.spec.measure;
        if (id === "against") state.against.add(m);
        else {
          state.against.delete(m);
          if (id !== "value") state.units = BASIN_UNITS[Number(id)];
          // A chart of every year maps against the others: in a unit, its map stays, unpinned.
          const pin = state.pinned.get(scope());
          if (layer.spec.against && pin?.id === layer.d.id) {
            const option = optionId(current!.ctx, layer.spec);
            state.chosen.set(scope(), [...(state.chosen.get(scope()) ?? []).filter((i) => i !== option), option]);
            state.pinned.delete(scope());
          }
        }
        render();
      },
      title(slot) {
        const layer = current?.layers.find((l) => l.slot === slot);
        return layer ? describeUnit(current!.ctx, layer.spec) : "";
      },
    },
    // How a map's circles or bars look: a menu on their sizes.
    sizes: {
      options(slot) {
        const layer = current?.layers.find((l) => l.slot === slot);
        return layer ? styles.menu(layer.spec.title, initialStyle(layer.spec), signed(layer.spec)) : { options: [], current: [] };
      },
      onPick(slot, id) {
        const layer = current?.layers.find((l) => l.slot === slot);
        if (!layer) return;
        styles.pick(layer.spec.title, id);
        drawMap();
      },
      title(slot) {
        const layer = current?.layers.find((l) => l.slot === slot);
        return layer ? describeStyle(styleOf(layer.spec), layer.slot as Shape) : "";
      },
    },
    onLock: () => drawMap(),
  });
  /** Check or uncheck a map. */
  function toggle(id: string) {
    if (!current) return;
    const ids = toggled(current.layers.map((l) => optionId(current!.ctx, l.spec)), id);
    state.chosen.set(scope(), ids);
    // With a sub-basin selected the map defaults to the model's, so a pick is a pin.
    if (followsModel() && ids.includes(id)) state.pinned.set(scope(), { id, sub: null });
    else state.pinned.delete(scope());
    drivers.clearPreview();
    drawMap();
    markAll();
  }
  // How a map's circles or bars look: in its colours (storage change's by sign), the 98th
  // percentile at full size.
  const styles = initShapeStyles();
  const initialStyle = (spec: BasinMapSpec): ShapeStyle => ({ colours: spec.onRivers ? "sign" : "map", full: 0.98 });
  const signed = (spec: BasinMapSpec) => spec.scale === "diverging";
  const styleOf = (spec: BasinMapSpec) => styles.get(spec.title, initialStyle(spec), signed(spec));

  // The discharge map of a basin's sub-basins: as the water balance scheme (a network of
  // lines, particles), or (its icons in the legend) as colours, circles or bars.
  const schemeMap = initSchemeMap({
    map,
    subBasins,
    legend,
    onChange: () => drawMap(),
    onHover: () => showMapTooltip(),
  });
  // Precipitation and evapotranspiration of a basin's sub-basins: as rain and vapour
  // (WaPOR's rasters), or (each one's icons in the legend) as colours, circles or bars.
  const effectsMap = initEffectsMap({
    map,
    majorBasins,
    onChange: () => drawMap(),
  });

  // Each other map's shape (colours, circles, bars): its icons in the legend.
  const shapes = initShapePicks();
  /**
   * A map switched shape: it goes last in the checklist, so it takes its new slot from the
   * map there, and the checked maps it covered stay off (not shown again in the slot it left).
   */
  function switched(match: (spec: BasinMapSpec) => boolean) {
    const ctx = current?.ctx;
    if (!ctx) return;
    const shown = new Set(current!.layers.map((l) => l.spec.title));
    const ids = (state.chosen.get(scope()) ?? []).filter((id) => shown.has(specFor(ctx, { id, sub: null }).title));
    const moved = ids.find((id) => match(specFor(ctx, { id, sub: null })));
    state.chosen.set(scope(), moved ? [...ids.filter((id) => id !== moved), moved] : ids);
  }

  // Where a basin's circle or bar stands: a sub-basin's middle; a major basin's, the
  // middle of its sub-basin nearest the middle of them all (by area), so it's inside it.
  let middles: { sub: Map<number, [number, number]>; major: Map<number, [number, number]> } | null = null;
  let middlesAsked = false;
  function loadedMiddles() {
    if (!middles && !middlesAsked) {
      middlesAsked = true;
      loadMiddles()
        .then((sub) => {
          middles = { sub, major: majorMiddles(sub) };
          drawMap();
        })
        .catch(() => (middlesAsked = false));
    }
    return middles;
  }
  function majorMiddles(sub: Map<number, [number, number]>) {
    const byMajor = new Map<number, { at: [number, number]; area: number }[]>();
    for (const b of subBasins) {
      const at = sub.get(b.id);
      if (!at) continue;
      if (!byMajor.has(b.majorBasin)) byMajor.set(b.majorBasin, []);
      byMajor.get(b.majorBasin)!.push({ at, area: b.area ?? 1 });
    }
    const out = new Map<number, [number, number]>();
    for (const [id, parts] of byMajor) {
      const total = parts.reduce((t, p) => t + p.area, 0);
      const x = parts.reduce((t, p) => t + p.at[0] * p.area, 0) / total;
      const y = parts.reduce((t, p) => t + p.at[1] * p.area, 0) / total;
      const d = (p: [number, number]) => (p[0] - x) ** 2 + (p[1] - y) ** 2;
      out.set(id, parts.reduce((a, b) => (d(b.at) < d(a.at) ? b : a)).at);
    }
    return out;
  }

  // All the topics' tiles and cards together, in one column.
  const allTopics: TopicDef = {
    id: "all",
    label: "All",
    tiles: TOPICS.flatMap((t) => t.tiles),
    cards: TOPICS.flatMap((t) => t.cards),
    about: TOPICS.map((t) => t.about).join(" "),
  };
  const topicDef = (): TopicDef => allTopics;
  const scope = () => (state.selection?.majorBasin ? "major" : "world");

  const drivers = initDrivers(section, {
    enabled: () => state.view === "basin",
    pinned: () => state.pinned.get(scope()) ?? null,
    setPinned(d) {
      if (d) state.pinned.set(scope(), d);
      else state.pinned.delete(scope());
      if (d) flyToRow(d.sub);
    },
    onChange() {
      drawMap();
      markAll();
    },
    // A year on a chart of the same days every year: the index of its range.
    onX(w) {
      const r = current?.ctx.windows.ranges[w];
      if (r) setRange(r);
    },
    onCsv: download,
    tooltip,
  });

  /** All the maps, each once (several charts can share one), in the order of the tiles and cards. */
  const menuMapsOf = new WeakMap<BasinCtx, { id: string; spec: BasinMapSpec }[]>(); // (once per draw)
  function menuMaps(ctx: BasinCtx): { id: string; spec: BasinMapSpec }[] {
    let maps = menuMapsOf.get(ctx);
    if (maps) return maps;
    const topic = topicDef();
    const seen = new Set<string>();
    maps = [
      ...topic.tiles.map((t) => ({ id: t.id, spec: tileMap(ctx, t) })),
      ...topic.cards.map((c) => ({ id: c.id, spec: c.map(ctx, null) })),
    ].filter(({ spec }) => !seen.has(spec.title) && !!seen.add(spec.title));
    menuMapsOf.set(ctx, maps);
    return maps;
  }
  /** The checklist's option for a map (by its title, as charts share maps). */
  const optionId = (ctx: BasinCtx, spec: BasinMapSpec) => menuMaps(ctx).find((m) => m.spec.title === spec.title)?.id ?? spec.id;

  /**
   * How a map can be drawn and is: as the scheme's lines or particles, as rain or vapour,
   * or as fills, circles or bars (storage change first as circles).
   */
  function shapesOf(spec: BasinMapSpec, ctx: BasinCtx): MapShapes {
    const title = spec.title;
    const major = ctx.major?.id ?? null;
    if (!ownSwitch(spec, ctx)) {
      const current = shapes.shape(title, SHAPES, spec.onRivers ? "circles" : "fill");
      return { title, options: shapeOptions(SHAPES), current, set: (id) => shapes.set(title, id as Shape) };
    }
    const effect = spec.effect;
    if (effect) return { title, options: effectsMap.modes(effect, major), current: effectsMap.mode(effect, major), set: (id) => effectsMap.setMode(effect, id) };
    const scheme = spec.scheme!;
    return { title, options: schemeMap.modes(scheme), current: schemeMap.mode(scheme), set: (id) => schemeMap.setMode(scheme, id) };
  }
  /** The slot of how a map is drawn. */
  function slotOf(spec: BasinMapSpec, ctx: BasinCtx): string {
    const m = shapesOf(spec, ctx);
    return m.options.find((o) => o.id === m.current)?.slot ?? "fill";
  }
  /** A basin's sub-basins' discharge, rain and evapotranspiration have their own ways (scheme-map.ts, effects-map.ts). */
  const ownSwitch = (spec: BasinMapSpec, ctx: BasinCtx) => !!(spec.scheme || spec.effect) && ctx.major !== null;

  // The map tooltip follows the pointer (to its right).
  const mapEl = map.map.getContainer();
  mapEl.addEventListener("pointermove", (e) => {
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  mapEl.addEventListener("pointerleave", () => (tooltip.hidden = true));

  // --- Loading -------------------------------------------------------------------------------
  function load() {
    if (state.view !== "basin" || state.status.kind !== "idle") return;
    state.status = { kind: "loading" };
    loadSeries().then(
      (series) => {
        state.status = { kind: "ready", series };
        render();
      },
      (err: Error) => {
        state.status = { kind: "error", message: err.message };
        render();
      },
    );
  }

  /** The last result, kept while its key stays the same (draw also runs on loads, selections, resizes). */
  function memo<T>() {
    let last: { key: string; value: T } | null = null;
    return (key: string, compute: () => T) => (last?.key === key ? last.value : (last = { key, value: compute() }).value);
  }
  const periodFor = memo<PeriodStats>();
  const ratesFor = memo<WindowRates | null>();
  const monthlyFor = memo<Monthly>();

  /**
   * The model's output for `key` (see state.fluxes), loading it the first time it's asked
   * for. A failed load is tried again after the selection or view changes.
   */
  function fluxes(key: string, load: () => Promise<FluxSeries>): FluxStatus {
    let status = state.fluxes.get(key);
    if (!status) {
      state.fluxes.set(key, (status = { kind: "loading" }));
      load().then(
        (result) => state.fluxes.set(key, { kind: "ready", result }),
        (err: Error) => state.fluxes.set(key, { kind: "error", message: err.message }),
      ).then(render);
    }
    return status;
  }

  function forgetFailedFluxes() {
    for (const [key, status] of state.fluxes) if (status.kind === "error") state.fluxes.delete(key);
  }

  // --- Rendering -------------------------------------------------------------------------------
  let frame = 0;
  function render() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(draw);
  }

  function draw() {
    const shown = state.view === "basin";
    section.hidden = !shown;
    const message = $("bs-message");
    if (!shown) return clear();

    const status = state.status;
    const major = state.selection?.majorBasin ?? null;
    $("bs-heading").textContent = major ? `${majorNames.get(major.id) ?? major.name}: basin statistics` : "Basins of the world";
    const range = state.range;
    const stats = status.kind === "ready" && range ? periodFor(`${range.start}-${range.end}`, () => periodStats(status.series, range)) : null;
    if (!stats?.covered) {
      message.classList.toggle("error", status.kind === "error");
      message.textContent =
        status.kind === "error"
          ? status.message
          : status.kind === "ready"
            ? "There are no WaPOR data for the selected period (they run from 2018 to the end of 2025)."
            : "";
      message.hidden = !message.textContent;
      tilesEl.innerHTML = "";
      cardsEl.innerHTML = "";
      return clear();
    }

    const covered = stats.covered;
    const topic = topicDef();
    const windows = sameDays(covered, FIRST_DK, basinLastDekad());
    // PCP and AETI in the other years, and per month.
    const { series } = status as { series: WaporSeries };
    const rates = ratesFor(windows.ranges.map((r) => `${r.start}-${r.end}`).join(","), () =>
      windows.ranges.length < 2 ? null : windowRates(series, windows.ranges),
    );
    const monthly = topic.cards.some((c) => c.id === "monthly")
      ? monthlyFor(`${covered.start}-${covered.end}:${major?.id ?? "all"}`, () => monthlyStats(series, covered, major?.id ?? null))
      : null;
    // The model's output.
    const majorFlux: FluxStatus = fluxes("majors", loadMajorFluxes);
    const subFlux: FluxStatus | null = major ? fluxes(String(major.id), () => loadSubBasinFluxes(major.id)) : null;

    const ctx: BasinCtx = {
      period: `${fmtStart(covered.start)} – ${fmtEnd(covered.end)}`,
      covered,
      days: stats.days,
      stats,
      windows,
      rates,
      ratesError: null,
      flux: { majors: majorFlux, sub: subFlux },
      monthly,
      major: major && { id: major.id, name: majorNames.get(major.id) ?? major.name },
      majors: majorIds,
      majorName: (id) => majorNames.get(id) ?? String(id),
      subName: (id) => subNames.get(id) ?? String(id),
      width: Math.max(240, cardsEl.clientWidth - 22),
      units: state.units,
      against: state.against,
      cache: new Map(),
    };
    const partly = state.range && (covered.start !== state.range.start || covered.end !== state.range.end);
    message.hidden = !partly;
    message.classList.remove("error");
    message.textContent = partly ? `WaPOR data cover only ${ctx.period} of the selected range.` : "";

    stale = unseen();
    if (stale) {
      current = { ctx, layers: [], csv: current?.csv ?? new Map() };
      drawMap();
      return;
    }
    tilesEl.innerHTML = topic.tiles.map((t) => tileHtml(t, ctx)).join("");
    const csv = new Map<string, (string | number)[][]>();
    const otherYears = windows.ranges.filter((_, w) => w !== windows.current).map(windowLabel);
    cardsEl.innerHTML = topic.cards
      .map((card) => {
        const out = card.render(ctx);
        csv.set(card.id, out.csv);
        return `<section class="cp-card" data-driver="${card.id}" tabindex="0" aria-label="${esc(card.title(ctx))}">` +
          `<h3><span>${esc(card.title(ctx))}</span><span class="cp-card-actions">` +
          (out.csv.length > 1 ? `<button class="wb-csv" data-csv="${card.id}">CSV</button>` : "") +
          `<button class="cp-unpin" data-unpin title="Remove pin" aria-label="Remove pin">×</button>` +
          `</span></h3><p>${esc(card.caption(ctx))}</p>${out.html}</section>`;
      })
      .join("") +
      `<p class="wb-about">${esc(topic.about)} ` +
      (otherYears.length ? `Other years: the same days in ${otherYears.join(", ")}.` : "") + `</p>`;
    current = { ctx, layers: [], csv };
    markAll();
    drawMap();
  }

  function tileHtml(t: BasinTile, ctx: BasinCtx) {
    const { value, unit, change, changeUnit } = tileValue(ctx, t);
    const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
    const vs = Number.isFinite(change) ? `${sign}${fmt(Math.abs(change))}${changeUnit === "%" ? "%" : ` ${changeUnit}`}` : "";
    return `<button data-driver="${t.id}" style="--var-color:${t.color}" title="Show on the map${vs ? ` (${vs} against the other years' average)` : ""}">` +
      `<span class="wb-stat-label">${esc(t.label)}</span>` +
      `<span class="wb-stat-value">${fmt(value)}</span>` +
      `<span class="wb-stat-unit">${esc(unit)}${vs ? ` · ${esc(vs)}` : ""}</span></button>`;
  }

  /**
   * Pinning a row of a group, a major basin or a sub-basin flies there, keeping the
   * selected basin in view where both fit (see flyTo). Not for the World.
   */
  function flyToRow(sub: string | null) {
    const area = parseArea(sub);
    if (!area || area.kind === "world") return;
    const box = (boxes: Map<number, Extent["box"]>, id: number): Extent[] => (boxes.has(id) ? [{ box: boxes.get(id)! }] : []);
    const own =
      area.kind === "sub" ? box(subBoxes, area.id)
      : area.kind === "major" ? box(majorBoxes, area.id)
      : majorIds.filter((id) => inGroup(id, area.id)).flatMap((id) => box(majorBoxes, id));
    const sel = state.selection?.majorBasin?.id;
    // A sub-basin is one of the selected basin's: fly to it alone.
    const inOwn = area.kind === "sub" || (sel !== undefined && (area.kind === "group" ? inGroup(sel, area.id) : sel === area.id));
    flyTo(map, own, sel === undefined || inOwn ? null : box(majorBoxes, sel)[0] ?? null);
  }

  function clear() {
    current = null;
    legend.show(null);
    tooltip.hidden = true;
    map.setBasinStatFills(null);
    schemeMap.draw(null, []);
    effectsMap.draw(null, null, []);
    map.setBasinSymbols(null);
    map.setBars("basin", null);
    setMapOverride(false);
  }

  /** Whether the map defaults to the water balance model's. */
  function followsModel() {
    return MODEL_SHOWN && !!state.selection?.subBasin;
  }

  const isDriver = (d: Driver | null | undefined): d is Driver =>
    !!d && (topicDef().tiles.some((t) => t.id === d.id) || topicDef().cards.some((c) => c.id === d.id));

  /** The previewed or pinned tile or card. */
  function leadDriver(): Driver | null {
    const d = drivers.preview() ?? state.pinned.get(scope()) ?? null;
    return isDriver(d) ? d : null;
  }

  /** The tile or card the map follows: previewed, pinned, or the first map on it. */
  function activeDriver(): Driver | null {
    return leadDriver() ?? (current ? shownLayers(current.ctx)[0]?.d ?? null : null);
  }

  /**
   * The maps on the map: those checked in the legend (else the first tile's), with the
   * previewed or pinned one in its slot. None while the map is the model's.
   */
  function shownLayers(ctx: BasinCtx): Layer[] {
    const lead = leadDriver();
    if (!lead && followsModel()) return [];
    const kept = state.chosen.get(scope());
    const chosen = (kept ?? []).filter((id) => isDriver({ id, sub: null }));
    // (The first tile's only alone: under a chart's map, it would show when that one changes
    // slot. None if all were unchecked.)
    const first = kept?.length === 0 || lead ? [] : [topicDef().tiles[0].id];
    const layers = (chosen.length ? chosen : first).map((id) => layerOf(ctx, { id, sub: null }));
    if (!lead) return onePerSlot(layers, SLOTS);
    const l = layerOf(ctx, lead);
    return onePerSlot([...layers.filter((m) => m.spec.title !== l.spec.title), l], SLOTS);
  }

  function layerOf(ctx: BasinCtx, d: Driver): Layer {
    const spec = specFor(ctx, d);
    return { d, spec, slot: slotOf(spec, ctx) };
  }

  function specFor(ctx: BasinCtx, d: Driver): BasinMapSpec {
    const topic = topicDef();
    const tile = topic.tiles.find((t) => t.id === d.id);
    if (tile) return tileMap(ctx, tile);
    return (topic.cards.find((c) => c.id === d.id) ?? topic.cards[0]).map(ctx, d.sub);
  }

  function markAll() {
    markDrivers(section, activeDriver(), drivers.preview(), state.pinned.get(scope()) ?? null);
  }

  function drawMap() {
    if (!current) return;
    const { ctx } = current;
    const layers = shownLayers(ctx);
    current.layers = layers;
    if (!layers.length) {
      // (The model's map has no legend; all unchecked, it has only the checklist.)
      legend.show(followsModel() ? null : []);
      map.setBasinStatFills(null);
      schemeMap.draw(null, []);
      effectsMap.draw(null, null, []);
      map.setBasinSymbols(null);
      map.setBars("basin", null);
      setMapOverride(false);
      return;
    }
    const major = ctx.major?.id ?? null;
    const theme = map.theme;
    const fill = layers.find((l) => l.slot === "fill")?.spec;
    // Discharge as the water balance scheme: lines, sized rather than coloured.
    const sized = layers.filter(isScheme);
    const keys = schemeMap.draw(
      major,
      sized.filter((l) => !l.spec.status).map((l) => ({ kind: l.spec.scheme!, value: l.spec.value, key: `${l.spec.id}:${ctx.period}`, range: `${l.spec.title}:${l.spec.unit}` })),
    );
    // Or as rain and vapour.
    const effectKeys = effectsMap.draw(
      major,
      daysOfDekads(ctx.covered),
      layers.filter((l) => isEffect(l) && !l.spec.status).map((l) => l.spec.effect!),
    );

    // The area under the pointer in a chart (or the one the card is pinned on): a group
    // or a major basin keeps its colours and fades the rest; a sub-basin is outlined.
    const sub = leadDriver()?.sub ?? null;
    const picked = parseArea(sub);
    /** A map's basins, values and colours (locked: the colours' range when the lock was put on); `shown`: not faded. */
    const paint = (spec: BasinMapSpec) => {
      const ids = spec.level === "major" ? ctx.majors : [...(spec.only ?? ctx.stats.sub.keys())];
      const values = ids.map((id) => spec.value(id));
      let scale = rampScale(spec, values, undefined, state.stretch);
      const domain = scale.ticks.length ? legend.hold(`${spec.title}:${spec.unit}:${spec.level}`, scale.domain) : scale.domain;
      if (domain !== scale.domain) scale = rampScale(spec, values, domain);
      const majorOf = (id: number) => (spec.level === "major" ? id : ctx.stats.sub.get(id)?.majorBasin ?? NaN);
      const shown = (id: number) => {
        if (picked?.kind === "major") return majorOf(id) === picked.id;
        if (picked?.kind === "group") return inGroup(majorOf(id), picked.id);
        return !spec.listed || spec.listed.has(id);
      };
      return { ids, values, scale, shown };
    };
    const scales = new Map<string, ColorScale>();
    const colors = new Map<number, Color>();
    if (fill) {
      const { ids, values, scale, shown } = paint(fill);
      scales.set("fill", scale);
      ids.forEach((id, i) => {
        const c = scale.color(values[i]) ?? (fill.level === "major" ? theme.noData : null);
        if (c) colors.set(id, shown(id) ? c : mixColor(c, theme.land, 0.78));
      });
    } else {
      // Plain land under the others; with a basin selected, the other major basins greyed.
      for (const id of ctx.majors) colors.set(id, major === null || id === major ? theme.land : theme.noData);
    }
    // Circles (area) and bars (height) by the value (the style's at full size; locked, as
    // when the lock was put on), coloured as the fill would be or by sign. At the basins'
    // middles; storage change's on the sub-basins' rivers (once the rivers are loaded).
    const symbols: CountrySymbol[] = [];
    const bars: Bar[] = [];
    const sizes = new Map<string, SizesKey>();
    const waiting = new Map<string, string>();
    const at = loadedMiddles();
    const css = (c: Color, alpha = 1) => `rgb(${c[0]} ${c[1]} ${c[2]} / ${alpha})`;
    for (const { spec, slot } of layers.filter(isShape)) {
      const { ids, values, scale, shown } = paint(spec);
      scales.set(slot, scale);
      const style = styleOf(spec);
      const river = spec.onRivers && major !== null ? schemeMap.riverPoints(major) : null;
      if (typeof river === "string") waiting.set(slot, river);
      const middles = spec.level === "major" ? at?.major : at?.sub;
      if (!middles || typeof river === "string") continue;
      const where = (id: number) => river?.get(id) ?? middles.get(id);
      const size = shapeSizes(values, style.full, (ref) => legend.hold(`${spec.title}:${spec.unit}:${spec.level}:${slot}:${style.full}`, ref), spec.level === "sub");
      sizes.set(slot, sizeKey(slot as "circles" | "bars", size, style, { one: css(theme.border, 0.6), rise: css(theme.storageRise), fall: css(theme.storageFall) }));
      ids.forEach((id, i) => {
        const v = Math.abs(values[i]);
        const position = where(id);
        const c = style.colours === "sign" && Number.isFinite(values[i]) ? signColor(values[i], theme.storageRise, theme.storageFall) : scale.color(values[i]);
        if (!position || !(v > 0) || !c) return;
        const [r, g, b] = shown(id) ? c : mixColor(c, theme.land, 0.78);
        if (slot === "circles") symbols.push({ id: `${spec.level}:${id}`, position, radius: size.radius(v), fill: [r, g, b, 200], line: [r * 0.6, g * 0.6, b * 0.6, 230] });
        else bars.push({ position, height: size.height(v), color: [r, g, b, 255] });
      });
    }
    // Small circles on top of big ones.
    symbols.sort((a, b) => b.radius - a.radius);
    const outlined = picked?.kind === "sub" ? [picked.id] : [];
    const statKey =
      `${fill?.id ?? ""}:${layers.filter((l) => l.slot !== "fill").map((l) => `${l.spec.id}:${l.slot}:${Object.values(styleOf(l.spec)).join("/")}:${waiting.has(l.slot)}`).join()}:${state.stretch}:` +
      `${legend.lockKey()}:${fill?.status ? "" : ctx.period}:${sub ?? ""}:${outlined.join()}`;
    map.setBasinStatFills({ level: fill?.level ?? "major", key: statKey, colors, outlined });
    map.setBasinSymbols(symbols.length ? { key: `${statKey}:${!!at}`, items: symbols } : null);
    map.setBars("basin", bars.length ? { key: `${statKey}:${!!at}`, items: bars } : null);
    setMapOverride(true);

    // Without values (the model's output, still loading), no key: only the status.
    legend.show(
      layers.map(({ spec, slot }): LegendLayer => {
        const common = { slot, id: optionId(ctx, spec), title: spec.title, unit: spec.unit, units: spec.units };
        if (slot === "fill" || isShape({ slot })) {
          const scale = scales.get(slot);
          const bySign = slot !== "fill" && styleOf(spec).colours === "sign";
          // (Only the fill's ramp is a menu. By sign, the sizes' key has the colours.)
          const key: LegendKey | null = scale?.ticks.length && !bySign ? { kind: "ramp", gradient: scale.gradient, ticks: scale.ticks, fixed: slot !== "fill" } : null;
          const sized = sizes.get(slot) ?? null;
          const where = spec.onRivers && slot !== "fill" ? spec.note.replace(/per sub-basin$/, "per sub-basin, on its river") : spec.note;
          const note = [where, spec.scale === "log" && !bySign ? "Log scale" : "", slot === "fill" ? "" : SHAPE_NOTES[slot as "circles" | "bars"]].filter(Boolean).join(" · ");
          const status = spec.status || waiting.get(slot) || "";
          return { ...common, note, period: key || sized ? ctx.period : "", key, sizes: status ? null : sized, status: unlessLoading(status) };
        }
        // Rain and vapour: a key of how many drops or puffs, per day whatever the units.
        if (isEffect({ slot })) {
          const drawn = effectKeys.get(spec.effect!);
          const status = spec.status || drawn?.status || "";
          const key = status ? null : drawn?.key ?? null;
          const note = spec.effect === "rain"
            ? "WaPOR's raster: more drops where more rain falls"
            : "WaPOR's raster: more puffs where more water goes up · green: transpiration, blue: evaporation";
          return { ...common, unit: "mm/day", units: false, note, period: key ? ctx.period : "", key, status: unlessLoading(status) };
        }
        // The scheme has a key of sizes instead.
        const drawn = keys.get(spec.scheme!);
        const status = spec.status || drawn?.status || "";
        const key = status ? null : drawn?.key ?? null;
        const note = spec.note.replace(/per sub-basin$/, "along the rivers");
        return { ...common, note, period: key ? ctx.period : "", key, status: unlessLoading(status) };
      }),
    );
    showMapTooltip();
  }

  function showMapTooltip() {
    const layers = current?.layers ?? [];
    const item = schemeMap.hovered();
    const sized = item && layers.find((l) => l.slot !== "fill" && l.spec.scheme === item.kind);
    if (item && sized && Number.isFinite(item.value)) {
      const name = subNames.get(item.subBasin) ?? String(item.subBasin);
      const what = item.kind === "Q" ? `${sized.spec.title} in the river` : sized.spec.title;
      tooltip.innerHTML = `<b>${esc(name)}</b><br>${esc(what)}: ${fmt(item.value)} ${esc(sized.spec.unit)}`;
      tooltip.hidden = false;
      return;
    }
    const place = state.hover;
    if (!place) return void (tooltip.hidden = true);
    // Each map's value there, under the basin's name.
    let name = "";
    const rows = layers.flatMap(({ spec }) => {
      const target = spec.level === "major" ? place.majorBasin : place.subBasin;
      if (!target || (spec.only && !spec.only.has(target.id))) return [];
      name ||= (spec.level === "major" ? majorNames : subNames).get(target.id) ?? target.name;
      return [`${esc(spec.title)}: ${fmt(spec.value(target.id))} ${esc(spec.unit)}`];
    });
    if (!rows.length) return void (tooltip.hidden = true);
    tooltip.innerHTML = `<b>${esc(name)}</b><br>${rows.join("<br>")}`;
    tooltip.hidden = false;
  }

  function download(id: string) {
    const rows = current?.csv.get(id);
    if (!rows || !current) return;
    const csvText = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csvText], { type: "text/csv" }));
    a.download = `${id}_${current.ctx.major?.id ?? "world"}_${current.ctx.period.replace(/ /g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  new ResizeObserver(() => {
    if (state.view === "basin") render();
  }).observe(cardsEl);

  return {
    lockLegend: () => legend.lock(),
    unlockLegend: () => legend.unlock(),
    setView(view) {
      state.view = view;
      forgetFailedFluxes();
      load();
      render();
    },
    setRange(range) {
      state.range = range;
      render();
    },
    setSelection(selection) {
      const majorBefore = state.selection?.majorBasin?.id;
      state.selection = selection;
      forgetFailedFluxes();
      if (selection.majorBasin?.id !== majorBefore) drivers.clearPreview();
      render();
    },
    hover(place) {
      state.hover = place;
      if (state.view === "basin") showMapTooltip();
    },
  };
}

const csvCell = (v: string | number) =>
  typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
